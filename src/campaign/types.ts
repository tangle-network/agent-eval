/**
 * @experimental
 *
 * Pass A substrate types — `runCampaign` is the one primitive every
 * eval flow composes from. Three contracts in this file:
 *
 *   - `Scenario`            input set
 *   - `DispatchFn`          how to run one scenario → artifact
 *   - `CampaignResult`      defined output schema (the contract downstream tools depend on)
 *
 * Three more lifted from earlier substrate work (re-exported):
 *
 *   - `JudgeConfig`         pluggable dimensional scorer (0.38)
 *   - `Mutator`             optimization-loop surface mutator
 *   - `Gate`                promotion gate (`HeldOutGate` and friends adapt to this)
 *
 * No new architecture vs 0.38 — Pass A formalizes the shapes so consumers
 * can build dashboards / CI gates / regression diffs against a stable schema.
 */

/** @experimental Stable identifier + kind tag for any scenario. Consumers
 *  extend with their per-domain payload (persona, task, requirement, ...). */
export interface Scenario {
  id: string
  kind: string
  tags?: string[]
}

/** @experimental Context handed to every dispatch invocation. Scoped — every
 *  trace/span carries the cellId, every artifact write lands under the cell's
 *  artifact root, the cost meter accumulates per cell. */
export interface DispatchContext {
  cellId: string
  rep: number
  generation?: number
  seed: number
  signal: AbortSignal
  trace: CampaignTraceWriter
  artifacts: CampaignArtifactWriter
  cost: CampaignCostMeter
  /** Populated when this run is part of a multi-cycle improvement loop. */
  cycleId?: string
  /** Populated when the substrate resumed from a prior cache hit. */
  resumedFrom?: string
}

/** @experimental One function: scenario + ctx → artifact. Dispatcher chooses
 *  whether to call `runMultishot`, `runLoop`, raw `streamPrompt`, anything. */
export type DispatchFn<TScenario extends Scenario, TArtifact> = (
  scenario: TScenario,
  ctx: DispatchContext,
) => Promise<TArtifact>

// ── Sessions ──────────────────────────────────────────────────────────

/** @experimental One session within a multi-session journey. Dispatch is
 *  invoked once per session in order; state from prior session's artifact
 *  is exposed via `ctx.priorSessionArtifact`. */
export interface SessionScript<TScenario, TArtifact> {
  id: string
  intent: string
  maxTurns?: number
  /** When true, knowledge accumulated this session persists to next. */
  affectsKnowledge?: boolean
  /** Optional per-session persona evolution — called after the session
   *  resolves. Returns the persona shape used by the NEXT session. */
  evolveAfterSession?: (artifact: TArtifact, sessionIndex: number, scenario: TScenario) => TScenario
}

// ── Judges (re-export 0.38 shape) ─────────────────────────────────────

export interface JudgeDimension {
  /** JSON field name + score key. */
  key: string
  /** Description shown in the judge's user prompt. */
  description: string
}

/** @experimental Pluggable dimensional scorer. `score` is the contract:
 *  given an artifact + scenario, return a `JudgeScore`. This is deliberately a
 *  function, not a fixed LLM-prompt shape — real consumers judge with
 *  ensembles, deterministic checks, or a single LLM call, and the substrate
 *  must not constrain that. The `llmJudge()` helper builds a `score` that does
 *  one LLM call for the common case. `appliesTo` lets a judge run only on
 *  scenarios that match (e.g. a legal-citation judge only on legal scenarios). */
export interface JudgeConfig<TArtifact, TScenario extends Scenario = Scenario> {
  name: string
  dimensions: JudgeDimension[]
  /** Score one artifact. Throw on failure — a thrown judge is recorded as a
   *  failed cell, never silently folded into a zero. */
  score(input: {
    artifact: TArtifact
    scenario: TScenario
    signal: AbortSignal
  }): JudgeScore | Promise<JudgeScore>
  appliesTo?: (scenario: TScenario) => boolean
}

export interface JudgeScore {
  dimensions: Record<string, number>
  composite: number
  notes: string
}

// ── Optimization (population + generations + mutator) ─────────────────

/** @experimental A tier-4 code surface — a candidate change to the agent's
 *  IMPLEMENTATION, not its prompt. Produced by autoresearch (reads codebase +
 *  trace findings → opens a worktree). Measured by checking out `worktreeRef`
 *  and running the worker against the changed code. See the improvement-tier
 *  table in `docs/design/loop-taxonomy.md`. */
export interface CodeSurface {
  kind: 'code'
  /** Worktree path or git ref holding the candidate code change. The
   *  consumer's `dispatchWithSurface` checks this out before running. */
  worktreeRef: string
  /** Base ref the change is measured against. Default: the repo's main. */
  baseRef?: string
  /** Human summary of what changed — rendered into the auto-PR body. */
  summary?: string
}

/** @experimental The mutable surface a driver proposes. Tiers (see
 *  `docs/design/loop-taxonomy.md`):
 *   - `string`      — tiers 1-2: system-prompt addendum / serialized tool
 *                     config. Cheap, reversible, text-diffable.
 *   - `CodeSurface` — tier 4: an implementation change behind a worktree ref.
 *  Tier 3 (knowledge) is owned by agent-knowledge and rides its own adapter,
 *  not this type. */
export type MutableSurface = string | CodeSurface

/** @experimental Stateless surface mutation — given findings + current
 *  surface, return N candidate surfaces. Pure transform, no generation
 *  awareness. Reflective-mutation, `runMultiShotOptimization`, `AxGEPA`
 *  conform. Wrapped by `evolutionaryDriver` to become an `ImprovementDriver`. */
export interface Mutator<TFindings = unknown> {
  kind: string
  mutate(args: {
    findings: TFindings[]
    currentSurface: MutableSurface
    populationSize: number
    signal: AbortSignal
  }): Promise<MutableSurface[]>
}

/** @experimental Everything a driver's `propose()` may read to plan the next
 *  batch of candidates. The first six fields are always present; the rest are
 *  optional context the loop supplies when available, so cheap drivers
 *  (`evolutionaryDriver`) can ignore them while a code-tier agentic generator
 *  consumes the research report + dataset to drive a coding harness.
 *  See `docs/design/self-improvement-engine.md`. */
export interface ProposeContext<TFindings = unknown> {
  currentSurface: MutableSurface
  history: GenerationRecord[]
  findings: TFindings[]
  /** BREADTH: how many candidate surfaces to return this generation. */
  populationSize: number
  generation: number
  signal: AbortSignal
  /** The Phase-2 research report (analyst findings + diff), produced AFTER the
   *  trace analysts run. Opaque to the substrate — the driver that consumes it
   *  types it. See the phase diagram in self-improvement-engine.md. */
  report?: unknown
  /** Handle to all captured data — the driver samples traces / artifacts /
   *  rewards here to ground its proposals. */
  dataset?: LabeledScenarioStore
  /** DEPTH: max iterations the agentic generator may take per candidate.
   *  1 = single-shot; >1 = it may iterate on its own change before handing it
   *  back to be measured. */
  maxImprovementShots?: number
}

/** @experimental A surface-improvement strategy — the DRIVER of the
 *  improvement loop. Given the current best surface, the history of what's
 *  been tried + scored, and any external findings, propose the next batch of
 *  candidate surfaces to measure. Optionally decide to stop early.
 *
 *  The evolutionary mutator (`evolutionaryDriver`, here) and agent-runtime's
 *  `improvementDriver` (with reflective / agentic generators) both conform —
 *  drivers of the SAME loop, not separate loops. The loop body
 *  (`runOptimization`) and the gated promotion shell (`runImprovementLoop`)
 *  are driver-agnostic. */
export interface ImprovementDriver<TFindings = unknown> {
  kind: string
  /** Plan: propose N candidate surfaces for the next generation. */
  propose(ctx: ProposeContext<TFindings>): Promise<MutableSurface[]>
  /** Decide: stop early when the driver judges the search converged or
   *  exhausted. Default (omitted) runs all `maxGenerations`. */
  decide?(args: { history: GenerationRecord[] }): { stop: boolean; reason?: string }
}

export interface OptimizerConfig {
  driver: ImprovementDriver
  populationSize: number
  maxGenerations: number
  surfaceExtractor: (profile: unknown) => MutableSurface
}

// ── Gates ─────────────────────────────────────────────────────────────

/** @experimental Five-valued verdict taxonomy (MOSS-paper alignment). */
export type GateDecision = 'ship' | 'hold' | 'need_more_work' | 'model_ceiling' | 'arch_ceiling'

export interface GateContext<TArtifact, TScenario extends Scenario> {
  candidateArtifacts: Map<string, TArtifact>
  baselineArtifacts?: Map<string, TArtifact>
  judgeScores: Map<string, Record<string, JudgeScore>>
  scenarios: TScenario[]
  cost: { candidate: number; baseline: number }
  signal: AbortSignal
}

export interface GateResult {
  decision: GateDecision
  reasons: string[]
  contributingGates: Array<{ name: string; passed: boolean; detail: unknown }>
  delta?: number
}

/** @experimental Composable promotion gate. */
export interface Gate<TArtifact = unknown, TScenario extends Scenario = Scenario> {
  name: string
  decide(ctx: GateContext<TArtifact, TScenario>): Promise<GateResult>
}

// ── Tracing / artifacts / cost ────────────────────────────────────────

/** @experimental Scoped trace writer handed to each dispatch — every span
 *  auto-tagged with the cellId so traces filter cleanly. */
export interface CampaignTraceWriter {
  span(name: string, attributes?: Record<string, unknown>): TraceSpan
  flush(): Promise<void>
}

export interface TraceSpan {
  end(attributes?: Record<string, unknown>): void
  setAttribute(key: string, value: unknown): void
}

/** @experimental Scoped artifact writer — `write(path, content)` lands under
 *  `<runDir>/<cellId>/<path>`. */
export interface CampaignArtifactWriter {
  write(path: string, content: string | Uint8Array): Promise<string>
  writeJson(path: string, value: unknown): Promise<string>
}

/** @experimental Cell-scoped cost meter. Substrate auto-tracks LLM costs
 *  via the cost-ledger backend hooks; consumers can record additional
 *  spend (sandbox time, tool costs) via `observe`. */
export interface CampaignCostMeter {
  observe(amountUsd: number, source: string): void
  current(): number
}

// ── LabeledScenarioStore ──────────────────────────────────────────────

/** @experimental Source tag — required on every store write. Used by the
 *  default training-source filter (production-trace samples NOT used as
 *  training scenarios unless explicitly opted in). */
export type LabeledScenarioSource =
  | 'production-trace'
  | 'eval-run'
  | 'manual'
  | 'red-team'
  | 'synthetic'

export type RedactionStatus = 'raw' | 'redacted-pii' | 'redacted-secrets' | 'fully-redacted'

/** @experimental Required-provenance write. The store rejects writes that
 *  lack provenance — a default-on flywheel without provenance is the
 *  data-poisoning vector flagged in the alignment review. */
export interface LabeledScenarioWrite<TScenario extends Scenario = Scenario, TArtifact = unknown> {
  scenario: TScenario
  artifact: TArtifact
  judgeScores: Record<string, JudgeScore>
  source: LabeledScenarioSource
  sourceVersionHash: string
  capturedAt: string
  redactionStatus: RedactionStatus
  /** Optional per-source rate-limit bucket key (e.g., the tenant id). */
  rateLimitBucket?: string
}

export interface LabeledScenarioRecord<TScenario extends Scenario = Scenario, TArtifact = unknown>
  extends LabeledScenarioWrite<TScenario, TArtifact> {
  /** Stable hash of (scenario.id, source, capturedAt, sourceVersionHash). */
  recordHash: string
  /** Substrate-assigned split — train if captured before the campaign's
   *  `temporalCutoff`, test if after. Explicit override allowed via filter. */
  split: 'train' | 'test'
}

export interface LabeledScenarioSampleArgs {
  count: number
  /** REQUIRED — substrate refuses to sample without an explicit split. */
  split: 'train' | 'test'
  /** REQUIRED — only records captured before this timestamp are returned.
   *  Enforces temporal split discipline (test scenarios captured AFTER train
   *  cannot enter the training pool). */
  capturedBefore: string
  filter?: {
    kind?: string
    source?: LabeledScenarioSource | LabeledScenarioSource[]
    minComposite?: number
    maxComposite?: number
  }
}

export interface LabeledScenarioStore {
  observe(write: LabeledScenarioWrite): Promise<void>
  sample(args: LabeledScenarioSampleArgs): Promise<LabeledScenarioRecord[]>
  size(): Promise<{ train: number; test: number; bySource: Record<string, number> }>
}

// ── The CampaignResult schema (the downstream-tools contract) ─────────

export interface CampaignCellResult<TArtifact> {
  cellId: string
  scenarioId: string
  rep: number
  generation?: number
  artifact: TArtifact
  judgeScores: Record<string, JudgeScore>
  costUsd: number
  durationMs: number
  seed: number
  cached: boolean
  error?: string
}

export interface JudgeAggregate {
  mean: number
  stdev: number
  ci95: [number, number]
  n: number
}

export interface ScenarioAggregate {
  meanComposite: number
  ci95: [number, number]
  n: number
}

export interface GenerationRecord {
  generationIndex: number
  candidates: Array<{ surfaceHash: string; composite: number; ci95: [number, number] }>
  promoted: string[]
}

export interface CampaignAggregates {
  byJudge: Record<string, JudgeAggregate>
  byScenario: Record<string, ScenarioAggregate>
  totalCostUsd: number
  cellsExecuted: number
  cellsSkipped: number
  cellsCached: number
  cellsFailed: number
}

export interface CampaignResult<TArtifact = unknown, TScenario extends Scenario = Scenario> {
  /** sha256(scenarios, judges, dispatch source ref, optimizer config, seed). Stable identity for reruns. */
  manifestHash: string
  seed: number
  startedAt: string
  endedAt: string
  durationMs: number
  cells: Array<CampaignCellResult<TArtifact>>
  aggregates: CampaignAggregates
  optimization?: {
    generations: GenerationRecord[]
    winnerSurfaceHash?: string
  }
  gate?: GateResult
  prUrl?: string
  runDir: string
  artifactsByPath: Record<string, string>
  /** Substrate strips the input scenarios to id+kind for the result manifest;
   *  consumers needing full payload look it up via the original input. The
   *  type parameter `TScenario` is propagated for downstream consumers that
   *  want narrowed types when extending `CampaignResult`. */
  scenarios: Array<Pick<TScenario, 'id' | 'kind'>>
}
