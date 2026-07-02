/**
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

import type { RunTokenUsage } from '../run-record'

/** Stable identifier + kind tag for any scenario. Consumers
 *  extend with their per-domain payload (persona, task, requirement, ...). */
export interface Scenario {
  id: string
  kind: string
  tags?: string[]
}

/** Context handed to every dispatch invocation. Scoped — every
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
  /**
   * Opaque placement key supplied by `RunCampaignOptions.cellPlacement`.
   * The substrate forwards it through unchanged; placement-aware Dispatch
   * implementations (e.g. `httpDispatch` from `/adapters/http`) read it to
   * route the cell to the right worker / region / sandbox. `undefined`
   * when no placement strategy is configured.
   */
  placement?: string
}

/** One function: scenario + ctx → artifact. Dispatcher chooses
 *  whether to call `runMultishot`, `runLoop`, raw `streamPrompt`, anything. */
export type DispatchFn<TScenario extends Scenario, TArtifact> = (
  scenario: TScenario,
  ctx: DispatchContext,
) => Promise<TArtifact>

// ── Sessions ──────────────────────────────────────────────────────────

/** One session within a multi-session journey. Dispatch is
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

/** Pluggable dimensional scorer. `score` is the contract:
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

/** The canonical judge verdict shape — one declaration, shared by campaign
 *  judges and the multishot judge runner (which re-exports this type).
 *
 *  Scale is PRODUCER-DEFINED: campaign convention is [0,1]; the legacy
 *  multishot runner emits 0-10. Cross-scale comparison must go through
 *  `detectScale` (src/campaign/gates/statistical-heldout.ts, used by
 *  promotion-policy) — never renormalize a producer's values in place, as
 *  downstream thresholds (`composite >= 5` in multishot/matrix.ts, live-soak
 *  `>= 7` gates) key on the producer's native scale. */
export interface JudgeScore {
  dimensions: Record<string, number>
  composite: number
  notes: string
  /** Set when the judge itself failed (call error, unparseable output).
   *  `composite`/`dimensions` carry no signal — aggregators MUST exclude
   *  failed scores from means instead of folding them into zeros. */
  failed?: true
  /** Ensemble extras (populated by `ensembleJudge`): max per-dimension
   *  spread across surviving judges — the inter-rater signal. */
  maxDisagreement?: number
  /** Ensemble extras: judge identities whose verdict failed. */
  failedJudges?: string[]
  /** Ensemble extras: each surviving judge's per-dimension scores. */
  perJudge?: Record<string, Record<string, number>>
}

// ── Optimization (population + generations + mutator) ─────────────────

/** A tier-4 code surface — a candidate change to the agent's
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

/** The mutable surface a proposer changes. Tiers (see
 *  `docs/design/loop-taxonomy.md`):
 *   - `string`      — tiers 1-2: system-prompt addendum / serialized tool
 *                     config. Cheap, reversible, text-diffable.
 *   - `CodeSurface` — tier 4: an implementation change behind a worktree ref.
 *  Tier 3 (knowledge) is owned by agent-knowledge and rides its own adapter,
 *  not this type. */
export type MutableSurface = string | CodeSurface

/** A proposer output carrying the surface AND the WHY behind
 *  it. Reflective proposers (`gepaProposer`) parse a `{label, rationale, payload}`
 *  from the model; without this wrapper the loop keeps only `payload` and the
 *  rationale that motivated the change is lost — the candidate becomes
 *  unattributable. `propose()` may return either bare `MutableSurface`s (cheap
 *  blind mutators) or these (reflective proposers); the loop normalizes both. */
export interface ProposedCandidate {
  surface: MutableSurface
  /** Short human label for the change (≤ 40 chars typical). */
  label: string
  /** Why this change was proposed — which failure it targets, which
   *  primitive it used. Survives to `GenerationCandidate.rationale` and the
   *  emitted provenance record. */
  rationale: string
}

/** Type guard: a proposal carrying its rationale vs a bare
 *  surface. The loop branches on this to populate `GenerationCandidate`. */
export function isProposedCandidate(
  value: MutableSurface | ProposedCandidate,
): value is ProposedCandidate {
  return (
    typeof value === 'object' &&
    value !== null &&
    'surface' in value &&
    'label' in value &&
    'rationale' in value
  )
}

/** A non-dominated parent on the GEPA Pareto frontier — a
 *  surface that, across the per-scenario objective vectors, no other tried
 *  surface beats on every scenario. A candidate worse on the mean composite
 *  but uniquely best on one hard scenario is non-dominated and survives here;
 *  the composite-best ranking would discard the lesson it carries. The loop
 *  computes the frontier across ALL generations and hands it to the proposer so
 *  a reflective proposer can combine complementary lessons (GEPA, Agrawal et
 *  al., arXiv:2507.19457). See `pareto.ts` (`paretoFrontier`). */
export interface ParetoParent {
  surface: MutableSurface
  surfaceHash: string
  /** The objective vector: per-scenario composite (higher is better). The
   *  axes the frontier is computed over. */
  objectives: Record<string, number>
  /** Mean composite across the objective scenarios — the scalar summary used
   *  for ordering + display, NOT for dominance. */
  composite: number
  /** Generation that produced this surface (`-1` for the baseline). */
  generation: number
  label?: string
  rationale?: string
}

/** Stateless surface mutation — given findings + current
 *  surface, return N candidate surfaces. Pure transform, no generation
 *  awareness. Reflective-mutation and `AxGEPA` mutators conform. Wrapped by
 *  `evolutionaryProposer` to become a `SurfaceProposer`. */
export interface Mutator<TFindings = unknown> {
  kind: string
  mutate(args: {
    findings: TFindings[]
    currentSurface: MutableSurface
    populationSize: number
    signal: AbortSignal
  }): Promise<Array<MutableSurface | ProposedCandidate>>
}

/** Everything a proposer may read to plan the next
 *  batch of candidates. The first six fields are always present; the rest are
 *  optional context the loop supplies when available, so cheap proposers
 *  (`evolutionaryProposer`) can ignore them while a code-tier agentic generator
 *  consumes the report + dataset to drive a coding harness.
 *  See `docs/campaign-proposers.md`. */
export interface ProposeContext<TFindings = unknown> {
  currentSurface: MutableSurface
  history: GenerationRecord[]
  findings: TFindings[]
  /** BREADTH: how many candidate surfaces to return this generation. */
  populationSize: number
  generation: number
  signal: AbortSignal
  /** Optional analysis report produced before proposal. Opaque to the substrate:
   *  the proposer that consumes it owns the shape. */
  report?: unknown
  /** Handle to all captured data — the proposer samples traces / artifacts /
   *  rewards here to ground its proposals. */
  dataset?: LabeledScenarioStore
  /** DEPTH: max iterations the agentic generator may take per candidate.
   *  1 = single-shot; >1 = it may iterate on its own change before handing it
   *  back to be measured. */
  maxImprovementShots?: number
  /** GEPA Pareto frontier across ALL generations so far — the non-dominated
   *  surfaces by per-scenario objective vector. Empty/absent on generation 0
   *  (only the baseline is scored). A reflective proposer combines the
   *  complementary lessons of these parents (each excels on different
   *  scenarios) into a merged candidate. Proposers doing pure single-parent
   *  reflection may ignore it. See {@link ParetoParent}. */
  paretoParents?: ParetoParent[]
  /** FIREWALL (non-negotiable): the held-out judge is write-only — its verdicts
   *  score the chosen output and gate promotion, and are NEVER an input to
   *  proposal/steering (else the optimizer games the acceptance axis = an
   *  oracle). This `never`-typed field makes that a compile-time tripwire: a
   *  proposer that tries to thread judge verdicts into the proposal will not type.
   *  Steering may consume TRACE-OBSERVABLE signals (what the agent did) via
   *  `findings`/`report`; it may NOT consume the judge's held-out verdict. */
  judgeScores?: never
}

/** A surface-improvement strategy. Given the current best
 *  surface, the history of what's been tried + scored, and any external
 *  findings, propose the next batch of candidate surfaces to measure.
 *  Optionally decide to stop early.
 *
 *  The evolutionary mutator (`evolutionaryProposer`, here) and agent-runtime's
 *  reflective / agentic generators both conform. They are proposers for the
 *  SAME loop, not separate loops. The loop body (`runOptimization`) and the
 *  gated promotion shell (`runImprovementLoop`) are proposer-agnostic.
 *
 *  This is THE optimization proposer — every optimizer is a factory
 *  `xProposer(opts): SurfaceProposer` (`evolutionaryProposer`, `aceProposer`,
 *  `gepaProposer`, `skillOptProposer`, `traceAnalystProposer`, `haloProposer`,
 *  `memoryCurationProposer`, `fapoProposer`), all exported from `/campaign` and
 *  drivable by `selfImprove({ proposer })`. Not to be confused with the
 *  behavior-fuzzing `MutationProposer` (`fuzz/types`), a scenario generator for
 *  a different loop.
 */
export interface SurfaceProposer<TFindings = unknown> {
  kind: string
  /** Plan: propose N candidate surfaces for the next generation. A proposer
   *  may return bare `MutableSurface`s or `ProposedCandidate`s that carry the
   *  `{label, rationale}` motivating the change — the loop threads the
   *  rationale into `GenerationCandidate` and the emitted provenance. */
  propose(ctx: ProposeContext<TFindings>): Promise<Array<MutableSurface | ProposedCandidate>>
  /** Decide: stop early when the proposer judges the search converged or
   *  exhausted. Default (omitted) runs all `maxGenerations`. */
  decide?(args: { history: GenerationRecord[] }): { stop: boolean; reason?: string }
}

/** Optional vocabulary alias. The loop is the optimizer; this object is the
 * proposer inside that loop. */
export type OptimizationProposer<TFindings = unknown> = SurfaceProposer<TFindings>

export interface OptimizerConfigBase {
  populationSize: number
  maxGenerations: number
  surfaceExtractor: (profile: unknown) => MutableSurface
}

export interface OptimizerConfig extends OptimizerConfigBase {
  proposer: SurfaceProposer
}

// ── Gates ─────────────────────────────────────────────────────────────

/** Five-valued verdict taxonomy (MOSS-paper alignment). */
export type GateDecision = 'ship' | 'hold' | 'need_more_work' | 'model_ceiling' | 'arch_ceiling'

export interface GateContext<TArtifact, TScenario extends Scenario> {
  candidateArtifacts: Map<string, TArtifact>
  baselineArtifacts?: Map<string, TArtifact>
  /** Candidate (winner) judge scores, keyed by cellId. */
  judgeScores: Map<string, Record<string, JudgeScore>>
  /** Baseline judge scores, keyed by cellId. SEPARATE from `judgeScores` —
   *  baseline + candidate share cellIds (same scenarios), so a single map
   *  cannot represent both. A gate computing a holdout delta MUST read
   *  candidate from `judgeScores` and baseline from here. */
  baselineJudgeScores?: Map<string, Record<string, JudgeScore>>
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

/** Composable promotion gate. */
export interface Gate<TArtifact = unknown, TScenario extends Scenario = Scenario> {
  name: string
  decide(ctx: GateContext<TArtifact, TScenario>): Promise<GateResult>
}

// ── Tracing / artifacts / cost ────────────────────────────────────────

/** Scoped trace writer handed to each dispatch — every span
 *  auto-tagged with the cellId so traces filter cleanly. */
export interface CampaignTraceWriter {
  span(name: string, attributes?: Record<string, unknown>): TraceSpan
  flush(): Promise<void>
}

export interface TraceSpan {
  end(attributes?: Record<string, unknown>): void
  setAttribute(key: string, value: unknown): void
}

/** Scoped artifact writer — `write(path, content)` lands under
 *  `<runDir>/<cellId>/<path>`. */
export interface CampaignArtifactWriter {
  write(path: string, content: string | Uint8Array): Promise<string>
  writeJson(path: string, value: unknown): Promise<string>
}

/** Token usage accumulated for a cell. Aliased to the canonical `RunTokenUsage`
 *  (run-record.ts, same package) so a cell maps onto a `RunRecord` for the
 *  backend-integrity guard with ONE source of truth — a field added to
 *  `RunTokenUsage` is a compile error here, not a silent drift. */
export type CampaignTokenUsage = RunTokenUsage

/** Cell-scoped cost meter. NOTHING is captured automatically —
 *  the substrate does not intercept the LLM call, so it cannot see cost or
 *  tokens unless the dispatch reports them. Every LLM cost MUST be reported via
 *  `observe` and every token count via `observeTokens`; a dispatch that reports
 *  neither yields a `{cost:0, tokens:0}` cell, which the backend-integrity
 *  guard (`assertRealBackend`) correctly reads as a stub. Also use `observe`
 *  for non-LLM spend (sandbox time, tool costs). */
export interface CampaignCostMeter {
  observe(amountUsd: number, source: string): void
  /** Record LLM token usage for this cell; accumulates across calls. A cell
   *  has `costUsd` but no token counts unless the dispatch reports them here —
   *  and the backend-integrity guard (`assertRealBackend`) keys on
   *  `tokenUsage`, so a cell that never reports tokens reads as a stub. Any
   *  dispatch that calls an LLM MUST report its usage. */
  observeTokens(usage: CampaignTokenUsage): void
  /** Record the concrete model the backend RESOLVED this cell to at runtime.
   *  The substrate cannot see the LLM call, so it cannot know which model a
   *  vendor-locked harness actually served — only the dispatch, reading the
   *  backend's usage/terminal events, can. A dispatch whose profile declares a
   *  runtime-resolved model (the `HARNESS_NATIVE_MODEL` sentinel) MUST report
   *  the resolved, snapshot-bearing id here so the RunRecord pins a real model
   *  instead of the sentinel. Last write wins (a cell issues one logical run);
   *  optional because most dispatches declare a concrete model up front. */
  observeModel?(model: string): void
  current(): number
  /** Accumulated token usage for this cell (zeros if never observed). */
  tokens(): CampaignTokenUsage
  /** The runtime-resolved model reported via `observeModel`, if any. */
  resolvedModel?(): string | undefined
}

// ── LabeledScenarioStore ──────────────────────────────────────────────

/** Source tag — required on every store write. Used by the
 *  default training-source filter (production-trace samples NOT used as
 *  training scenarios unless explicitly opted in). */
export type LabeledScenarioSource =
  | 'production-trace'
  | 'eval-run'
  | 'manual'
  | 'red-team'
  | 'synthetic'

export type RedactionStatus = 'raw' | 'redacted-pii' | 'redacted-secrets' | 'fully-redacted'

/** How much a label can be trusted to evaluate against — the gold-admission
 *  gate. Strictly ordered: a record qualifies for a `minTrust` filter when its
 *  trust rank is >= the requested rank.
 *
 *   - `unverified`      — label is a heuristic (e.g. raw outcome success/fail).
 *                          Fine as corpus; MUST NOT enter a gold set that lift
 *                          numbers are computed against.
 *   - `verified-signal` — an external signal confirmed the outcome (PR merged,
 *                          tests green, user did not retry, downstream check).
 *   - `human-rated`     — a human explicitly rated or corrected the artifact.
 *
 *  Absent on a write ⇒ treated as `unverified` (fail-closed: a writer must
 *  explicitly assert trust to make a record gold-eligible — it never happens
 *  by accident). */
export type LabelTrust = 'unverified' | 'verified-signal' | 'human-rated'

const LABEL_TRUST_RANK: Record<LabelTrust, number> = {
  unverified: 0,
  'verified-signal': 1,
  'human-rated': 2,
}

/** Ordinal rank for a label-trust tier; absent ⇒ `unverified` (rank 0). */
export function labelTrustRank(trust: LabelTrust | undefined): number {
  return LABEL_TRUST_RANK[trust ?? 'unverified']
}

/** Required-provenance write. The store rejects writes that
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
  /** Gold-admission trust tier. Absent ⇒ `unverified` (fail-closed): the
   *  record is corpus, never gold. A writer must explicitly assert
   *  `verified-signal` or `human-rated` to make it eligible for a gold
   *  sample. See {@link LabelTrust}. */
  labelTrust?: LabelTrust
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
    /** Gold gate: only records whose trust rank is >= this tier are
     *  returned. `sample({ split: 'test', minTrust: 'verified-signal' })` is
     *  the canonical "give me the gold set" call. Absent ⇒ no trust gate
     *  (corpus-level read). */
    minTrust?: LabelTrust
  }
}

export interface LabeledScenarioStore {
  observe(write: LabeledScenarioWrite): Promise<void>
  sample(args: LabeledScenarioSampleArgs): Promise<LabeledScenarioRecord[]>
  size(): Promise<{
    train: number
    test: number
    bySource: Record<string, number>
    /** Count by trust tier — tells the flywheel how much gold it has
     *  accumulated vs. raw corpus. */
    byTrust: Record<LabelTrust, number>
  }>
}

// ── The CampaignResult schema (the downstream-tools contract) ─────────

export interface CampaignCellResult<TArtifact> {
  /** Manifest that produced this cell. Resumability refuses to reuse a cell
   *  whose manifest differs from the current run. */
  manifestHash?: string
  cellId: string
  scenarioId: string
  rep: number
  generation?: number
  artifact: TArtifact
  judgeScores: Record<string, JudgeScore>
  costUsd: number
  /** LLM token usage the dispatch reported via `ctx.cost.observeTokens`.
   *  `{ input: 0, output: 0 }` when the dispatch reported none — which the
   *  backend-integrity guard reads as a stub. */
  tokenUsage: CampaignTokenUsage
  /** The concrete model the backend resolved this cell to at runtime, reported
   *  by the dispatch via `ctx.cost.observeModel`. Set only when the dispatch
   *  reported it — a profile that declares a concrete model up front has no
   *  need to. Consumed by `buildRunRecord` to pin the real model when the
   *  declared model is the `HARNESS_NATIVE_MODEL` sentinel. */
  resolvedModel?: string
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
  candidates: GenerationCandidate[]
  promoted: string[]
}

/** One scored candidate surface in a generation. `dimensions` + `scenarios`
 *  let a reflective proposer ground its next proposal on WHICH
 *  dimensions the candidate is weakest on and WHICH scenarios it best/worst
 *  handled — the evidence a blind `Mutator` cannot see. */
export interface GenerationCandidate {
  surfaceHash: string
  composite: number
  ci95: [number, number]
  /** Mean score per judge dimension across all cells (scenarios × reps ×
   *  judges that reported the dimension). */
  dimensions: Record<string, number>
  /** Per-scenario composite (mean over reps + judges), plus the judge's
   *  free-form `notes` for that scenario — the "why it scored low" evidence a
   *  reflective proposer grounds its next edit on. Keep `notes` GENERALIZABLE
   *  (which checks/lines/dimensions failed and how), NOT case-specific ground
   *  truth: leaking expected answers into the prompt is memorization, and the
   *  held-out gate would reject it anyway. */
  scenarios: Array<{ scenarioId: string; composite: number; notes?: string }>
  /** Proposer-supplied short label for the change. Present when the proposer
   *  returned a `ProposedCandidate`; absent for bare-surface mutators. */
  label?: string
  /** Proposer-supplied rationale — WHY this candidate was proposed. The
   *  "because rationale Z" the audit requires to survive to the result.
   *  Present when the proposer returned a `ProposedCandidate`. */
  rationale?: string
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
