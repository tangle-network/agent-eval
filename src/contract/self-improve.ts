/**
 * Run one complete improvement job.
 *
 * A caller-owned `proposer` can generate candidates across local generations.
 * An external `method`, such as official GEPA or SkillOpt, owns its complete
 * search and returns one candidate. Both paths remeasure the selected candidate
 * against cases that candidate generation never receives.
 */

import { createHash } from 'node:crypto'
import { defaultProductionGate } from '../campaign/gates/default-production-gate'
import { type PowerPreflight, powerPreflight } from '../campaign/gates/power-preflight'
import {
  assertOptimizationResult,
  type OptimizationMethod,
  type OptimizationMethodProvenance,
  type OptimizationMethodResult,
} from '../campaign/presets/compare-optimization-methods'
import {
  type RunImprovementLoopResult,
  runImprovementLoop,
} from '../campaign/presets/run-improvement-loop'
import type {
  PremeasuredOptimizationBaseline,
  RunOptimizationOptions,
} from '../campaign/presets/run-optimization'
import {
  emitLoopProvenance,
  type LoopProvenanceRecord,
  loopProvenanceArgsFromResult,
} from '../campaign/provenance'
import { resolveRunDir } from '../campaign/run-dir'
import {
  type CampaignStorage,
  createRunCostLedger,
  fsCampaignStorage,
  inMemoryCampaignStorage,
} from '../campaign/storage'
import { surfaceContentHash, surfaceHash } from '../campaign/surface-identity'
import type {
  CampaignCellResult,
  DispatchContext,
  Gate,
  JudgeConfig,
  LabeledScenarioStore,
  MutableSurface,
  Scenario,
  SurfaceProposer,
} from '../campaign/types'
import type { CostLedgerHandle, CostLedgerSummary, CostReceipt } from '../cost-ledger'
import { createHostedClient, type HostedTenant } from '../hosted/client'
import type { EvalRunCellScore, EvalRunEvent, EvalRunGenerationSnapshot } from '../hosted/types'
import type { JudgeScoresRecord, RunRecord } from '../run-record'
import { analyzeRuns } from './analyze-runs'
import type { InsightReport } from './insight-report'

export interface SelfImproveBudget {
  /** Hard spend cap across the full run. Each paid call reserves its enforced
   *  maximum before dispatch, so completed spend cannot cross this amount. */
  dollars?: number
  /** Proposer generations. Default: 3. External methods own their rounds and
   *  require this value to be omitted or set to 1. Set 0 only for a
   *  proposer-free baseline run. */
  generations?: number
  /** Candidates the proposer emits per generation. Default 2. */
  populationSize?: number
  /** Max concurrent cells across the loop. Default 2. */
  maxConcurrency?: number
  /** Candidate campaigns scored in parallel. Default 1. Total concurrent
   *  cells are bounded by `candidateConcurrency * maxConcurrency`. */
  candidateConcurrency?: number
  /** Fraction of `scenarios` held out from training, used for the gate.
   *  Default 0.25. Ignored when `holdoutScenarios` is set explicitly. */
  holdoutFraction?: number
  /** Fraction of the non-final cases reserved for method selection.
   *  Default 0.25. Used only with `method` and ignored when
   *  `selectionScenarios` is supplied explicitly. */
  selectionFraction?: number
  /** Explicit held-out scenarios; overrides `holdoutFraction`. */
  holdoutScenarios?: Scenario[]
  /** Holdout policy. Default `'measured'`: split, re-score baseline vs winner
   *  on the held-out set, gate on that comparison. `'deferred'`: run the
   *  improvement-set campaigns + search promotion, dispatch ZERO holdout cells,
   *  force the gate to `'hold'`, return `lift: undefined`, and record
   *  `holdout: 'deferred'` in the provenance record — for callers that measure
   *  the held-out comparison in a separate later run instead of faking a
   *  static holdout scenario and recording a meaningless lift. Unless
   *  `holdoutScenarios` reserves an explicit set, ALL scenarios train. */
  holdout?: 'measured' | 'deferred'
  /** Per-scenario replicates per cell — raises bootstrap-CI tightness. Default 1. */
  reps?: number
  /** DEPTH dial forwarded to the proposer's `propose()` as
   *  `ctx.maxImprovementShots` — max iterations an agentic candidate generator
   *  may take per candidate (verify-in-session retries). Unset ⇒ the
   *  proposer's own default. */
  maxImprovementShots?: number
}

export type SelfImproveProgressEvent =
  | { kind: 'baseline.started'; scenarios: number }
  | { kind: 'baseline.completed'; compositeMean: number; durationMs: number }
  | { kind: 'generation.started'; index: number; populationSize: number }
  | { kind: 'generation.completed'; index: number; bestComposite: number; durationMs: number }
  // `lift` is absent when `budget.holdout === 'deferred'` — no held-out
  // measurement ran, and the search-split delta must not masquerade as one.
  | { kind: 'gate.decided'; decision: string; lift?: number }
  | { kind: 'power.estimated'; n: number; sd: number; mde: number; underpowered: boolean }

export interface SelfImproveOptions<TScenario extends Scenario, TArtifact> {
  /**
   * Your agent — a function that takes the current `MutableSurface`
   * (typically a system prompt the loop is optimizing) plus the
   * scenario + cell ctx, and returns the artifact your judge scores.
   *
   * Same shape as `RunOptimizationOptions.dispatchWithSurface`. Wrap a
   * plain `Dispatch` if you don't have a surface seam:
   *
   *   agent: (_surface, scenario, ctx) => yourPlainDispatch(scenario, ctx)
   *
   * That mode evaluates without mutating any surface — useful as a
   * baseline-only run (set `budget.generations = 0`).
   */
  agent: (surface: MutableSurface, scenario: TScenario, ctx: DispatchContext) => Promise<TArtifact>

  /** Scenarios to evaluate against. Train/holdout split is computed from
   *  these unless `budget.holdoutScenarios` is set explicitly. */
  scenarios: TScenario[]

  /** Judge that scores artifacts. Bring your own; use `langchainJudge`
   *  from `/adapters/langchain` for a Runnable-shaped one. */
  judge: JudgeConfig<TArtifact, TScenario>

  /** Starting surface — system prompt, JSON config, anything `MutableSurface`
   *  accepts. The proposer mutates this each generation. */
  baselineSurface: MutableSurface

  /** Budget + loop shape. All fields optional. */
  budget?: SelfImproveBudget

  /**
   * Complete prior measurement of `baselineSurface` over the TRAIN split.
   * Forwarded to the loop body, which validates its surface hash, scenario
   * split, seed (42), reps, and coverage, then skips the baseline search
   * campaign entirely — no baseline dispatch, no resumability lookup. The
   * train split is `scenarios` minus the holdout split, so premeasure with
   * exactly that scenario set (explicit `budget.holdoutScenarios`, or
   * `budget.holdout: 'deferred'` with no reserved set, makes the train split
   * deterministic). Prior spend stays in the imported campaign aggregates and
   * is not re-added to this run's cost ledger.
   */
  premeasuredBaseline?: PremeasuredOptimizationBaseline<TArtifact, TScenario>

  /**
   * Candidate generator for this local generation loop.
   * Required when `budget.generations` is greater than zero.
   */
  proposer?: SurfaceProposer

  /**
   * Complete optimization method, such as official GEPA or SkillOpt.
   * The method receives disjoint train and selection cases and never receives
   * the final comparison cases. Mutually exclusive with `proposer`.
   */
  method?: OptimizationMethod<TScenario, TArtifact>

  /** Explicit method-selection cases. They must also appear in `scenarios`
   *  and must not overlap the final comparison cases. */
  selectionScenarios?: TScenario[]

  /** Custom gate. Default is `defaultProductionGate` with
   *  `deltaThreshold: 0.05` on the held-out split. */
  gate?: Gate<TArtifact, TScenario>

  /** Placebo control. When supplied AND the winner differs from baseline, the
   *  loop scores a THIRD held-out arm: the winner surface with its content
   *  footprint-matched-blanked by this fn (typically via `neutralizeText`). Its
   *  scores reach the gate as `ctx.neutralizedJudgeScores`, letting a
   *  `neutralizationGate` reject a win whose lift survives blanking the content
   *  (decorative — driven by footprint, not content). Costs one extra held-out
   *  campaign; omit to skip. Compose `neutralizationGate` into `gate` to act on it. */
  neutralize?: (winnerSurface: MutableSurface, baselineSurface: MutableSurface) => MutableSurface

  /** Storage backend. A filesystem run directory uses `fsCampaignStorage()`;
   *  a `mem://` directory uses in-memory storage. External methods default to
   *  a filesystem directory because their official state must survive. */
  storage?: CampaignStorage

  /** Run directory. Proposer mode defaults to
   *  `mem://selfImprove-<timestamp>`. External method mode defaults to
   *  `.agent-eval/runs/self-improve-<timestamp>`. */
  runDir?: string

  /** Fires once the durable provenance record + OTel spans are emitted.
   *  Receives the structured record for inline assertions / custom routing. */
  onProvenance?: (record: LoopProvenanceRecord) => void

  /** Distributed execution seam — same as `RunCampaignOptions.cellPlacement`.
   *  Returns an opaque placement key the substrate forwards to your agent
   *  as `ctx.placement`. Combined with `httpDispatch` from
   *  `/adapters/http`, fans cells across regions. */
  cellPlacement?: (input: {
    scenario: TScenario
    rep: number
    generation?: number
  }) => string | undefined

  /** Per-cell agent dispatch deadline, applied to baseline, candidate, and
   *  held-out campaigns. Default 600_000 ms. Set 0 to disable. */
  dispatchTimeoutMs?: number

  /** Streaming hook — fires on baseline + each generation + gate decision.
   *  Consumer routes events wherever (UI, dashboard, logs). */
  onProgress?: (event: SelfImproveProgressEvent) => void

  /** Auto-promotion behavior on a ship decision. Default `'none'` — we
   *  return the winner; you ship it however you ship. `'pr'` opens a
   *  GitHub PR via `openAutoPr`; requires `ghOwner` + `ghRepo`. */
  autoOnPromote?: 'pr' | 'none'
  ghOwner?: string
  ghRepo?: string

  /**
   * Opt-in: ship eval-run events to a hosted orchestrator (ours, your
   * self-hosted one, or any compatible implementation of the
   * `docs/hosted-ingest-spec.md` wire format). When set, the substrate
   * POSTs the final `EvalRunEvent` to `${endpoint}/v1/ingest/eval-runs`
   * after the loop completes. Failures are logged but do not fail the
   * loop — local result is always returned.
   *
   * For our orchestrator: `{ endpoint: 'https://orchestrator.tangle.tools/v1', apiKey, tenantId }`.
   *
   * For your self-hosted: any URL serving the wire format. See
   * `examples/hosted-ingest-server/` for the reference receiver.
   */
  hostedTenant?: HostedTenant

  /** Free-form labels attached to the hosted event (env, branch, model id,
   *  etc.). Ignored when `hostedTenant` is unset. */
  hostedLabels?: Record<string, string>

  /** Capture every artifact + judge score to this store (labeled-example
   *  corpus the proposer may read for few-shot, and the dataset you ship). Pass
   *  `'off'` to disable. Default: off. */
  labeledStore?: LabeledScenarioStore | 'off'

  /** Capture-source tag for `labeledStore`. Default `'eval-run'`. */
  captureSource?: 'production-trace' | 'eval-run' | 'manual' | 'red-team' | 'synthetic'

  /**
   * Per-cell backend-integrity expectation — the fail-loud guard. A cell that
   * produced an artifact but reported `costUsd === 0` AND zero tokens is a
   * stub. Modes: `'assert'` throws on the first such cell, `'warn'` logs it,
   * `'off'` skips the check (offline/replay). Default `'assert'` — `selfImprove`
   * is the real-run path, so a stub fails loud rather than scoring a clean 0.
   */
  expectUsage?: 'assert' | 'warn' | 'off'

  /**
   * Per-generation findings producer. Runs once on the baseline campaign (as
   * `generation: -1`) before generation 0 proposes — so single-generation runs
   * propose with trace context — and again after each generation is scored;
   * whatever it returns REPLACES the proposer's `findings` for the next
   * `propose()`. Plug a trace-analyst registry / HALO here. When absent,
   * findings stay `opts.findings`.
   */
  analyzeGeneration?: RunOptimizationOptions<TScenario, TArtifact>['analyzeGeneration']

  /** Static findings forwarded to the proposer's `propose()` as `ctx.findings`
   *  (a findings-grounded proposer consumes them). Default: none. */
  findings?: unknown[]
}

export interface SelfImproveResult<TScenario extends Scenario, TArtifact> {
  /** Composite mean across all scenarios, baseline run. When
   *  `budget.holdout === 'deferred'` this is measured on the improvement
   *  (search) split — no holdout campaign ran. */
  baseline: {
    compositeMean: number
    perScenario: Record<string, number>
  }
  /** Composite mean on the held-out set, winner run. When
   *  `budget.holdout === 'deferred'` this is the winner's improvement-set
   *  (search) measurement — no holdout campaign ran. */
  winner: {
    compositeMean: number
    perScenario: Record<string, number>
    surface: MutableSurface
    /** Proposer label for the promoted change. Absent ⇒ winner == baseline or
     *  a bare-surface mutator. */
    label?: string
    /** Proposer rationale — the "because Z" that motivated the promoted change.
     *  Threaded from the proposer's `ProposedCandidate` through the loop.
     *  Absent ⇒ winner == baseline. */
    rationale?: string
  }
  /** `winner.compositeMean - baselineOnHoldout.compositeMean`. Positive
   *  means the gate observed improvement. Absent iff
   *  `budget.holdout === 'deferred'` — no held-out measurement ran, so there
   *  is no lift to report (never a fabricated 0). */
  lift?: number
  /** The explicit baseline→winner unified diff. Always present (empty string
   *  when winner == baseline). */
  diff: string
  /** Durable, queryable provenance record: candidate→cell→gate→promote chain +
   *  rationale + diff + backend provenance. The artifact the hosted ingest
   *  path stores; the +lift RECOMPUTES from `record.heldOutLift`. */
  provenance: LoopProvenanceRecord
  /** `defaultProductionGate.decide()` result. */
  gateDecision: 'ship' | 'hold' | 'need_more_work' | 'model_ceiling' | 'arch_ceiling'
  /** Number of generations actually explored (may be less than the
   *  budget if the proposer gave up early). */
  generationsExplored: number
  /** Wall-clock total. */
  durationMs: number
  /** Total newly observed cost across the full run. */
  totalCostUsd: number
  /** Canonical run-wide spend summary. */
  cost: CostLedgerSummary
  /** Run-wide receipts across proposal, search, holdout, judging, analysis,
   *  and promotion work, with phase and actor attribution. */
  receipts: CostReceipt[]
  /** Exact external method and source identity, when `method` was used. */
  optimization?: {
    name: string
    cost: OptimizationMethodResult['cost']
    durationMs?: number
    provenance?: OptimizationMethodProvenance
  }
  /**
   * Rigor packet: distributional summary, paired-bootstrap lift CI,
   * judge stats, contamination check, recommendations. Wired through
   * `analyzeRuns()` on the baseline + winner cells of the campaign.
   * Hosted-tier dashboards render this as the v3-vs-v4 decision view.
   */
  insight: InsightReport
  /** Minimum-detectable-lift analysis from the baseline holdout cells: could this
   *  budget have shipped ANY plausible effect? Absent when the baseline produced
   *  fewer than 3 scored holdout cells. See `powerPreflight` for the standalone
   *  pre-run version (run `gate: 'none'` first, budget the real search after). */
  power?: PowerPreflight
  /**
   * Raw substrate result for advanced inspection — full per-generation
   * candidates, full campaign artifacts, all judge scores. Useful for
   * debugging or reporting beyond the summary.
   */
  raw: RunImprovementLoopResult<TArtifact, TScenario>
}

/** Failed self-improvement run with an immutable receipt snapshot. */
export class SelfImproveRunError extends Error {
  readonly cost: CostLedgerSummary
  readonly receipts: CostReceipt[]

  constructor(cause: unknown, ledger: CostLedgerHandle) {
    const original = cause instanceof Error ? cause : new Error(String(cause))
    super(original.message, { cause: original })
    this.name = 'SelfImproveRunError'
    this.cost = ledger.summary()
    this.receipts = ledger.list()
  }
}

function assertSelfImproveSearchMode<TScenario extends Scenario, TArtifact>(
  opts: SelfImproveOptions<TScenario, TArtifact>,
): void {
  if (opts.method && opts.proposer) {
    throw new Error('selfImprove: method and proposer are mutually exclusive')
  }
  if (!opts.method) {
    if (opts.selectionScenarios !== undefined) {
      throw new Error('selfImprove: selectionScenarios requires method')
    }
    return
  }
  if (
    typeof opts.method.name !== 'string' ||
    !opts.method.name.trim() ||
    opts.method.name.trim() !== opts.method.name ||
    typeof opts.method.optimize !== 'function'
  ) {
    throw new Error('selfImprove: method must have a trimmed name and optimize(input)')
  }
  const budget = opts.budget
  if (budget?.generations !== undefined && budget.generations !== 1) {
    throw new Error('selfImprove: method owns its rounds; budget.generations must be 1 when set')
  }
  if (budget?.populationSize !== undefined && budget.populationSize !== 1) {
    throw new Error(
      'selfImprove: method owns its candidates; budget.populationSize must be 1 when set',
    )
  }
  if (
    budget?.candidateConcurrency !== undefined ||
    budget?.maxImprovementShots !== undefined ||
    opts.analyzeGeneration !== undefined ||
    opts.findings !== undefined
  ) {
    throw new Error(
      'selfImprove: candidateConcurrency, maxImprovementShots, analyzeGeneration, and findings apply only to proposer mode',
    )
  }
}

function splitMethodPartitions<TScenario extends Scenario>(
  searchScenarios: TScenario[],
  explicitSelection: TScenario[] | undefined,
  fraction: number,
): { train: TScenario[]; selection: TScenario[] } {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    throw new Error('selfImprove: budget.selectionFraction must be in (0, 1)')
  }
  const byId = new Map<string, TScenario>()
  for (const scenario of searchScenarios) {
    if (byId.has(scenario.id)) {
      throw new Error(`selfImprove: duplicate scenario id '${scenario.id}'`)
    }
    byId.set(scenario.id, scenario)
  }
  if (explicitSelection) {
    if (explicitSelection.length === 0) {
      throw new Error('selfImprove: selectionScenarios must not be empty')
    }
    const selectionIds = new Set<string>()
    for (const scenario of explicitSelection) {
      if (!byId.has(scenario.id)) {
        throw new Error(
          `selfImprove: selection scenario '${scenario.id}' is absent from the non-final cases`,
        )
      }
      if (selectionIds.has(scenario.id)) {
        throw new Error(`selfImprove: duplicate selection scenario id '${scenario.id}'`)
      }
      selectionIds.add(scenario.id)
    }
    const train = searchScenarios.filter((scenario) => !selectionIds.has(scenario.id))
    if (train.length === 0) {
      throw new Error('selfImprove: method train split is empty')
    }
    return {
      train,
      selection: explicitSelection.map((scenario) => byId.get(scenario.id)!),
    }
  }
  if (searchScenarios.length < 2) {
    throw new Error('selfImprove: method requires at least two non-final scenarios')
  }
  const sorted = [...searchScenarios].sort(
    (a, b) => stableScenarioHash(a.id) - stableScenarioHash(b.id),
  )
  const count = Math.max(1, Math.min(sorted.length - 1, Math.round(sorted.length * fraction)))
  return {
    selection: sorted.slice(0, count),
    train: sorted.slice(count),
  }
}

function safeRunComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function stableScenarioHash(value: string): number {
  let hash = 2166136261 >>> 0
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

/**
 * Deterministic train/holdout split by a stable hash of `scenario.id`,
 * so the same scenario set always splits the same way across runs.
 */
function splitTrainHoldout<TScenario extends Scenario>(
  scenarios: TScenario[],
  fraction: number,
): { train: TScenario[]; holdout: TScenario[] } {
  const sorted = [...scenarios].sort((a, b) => stableScenarioHash(a.id) - stableScenarioHash(b.id))
  const nHoldout = Math.max(1, Math.min(sorted.length - 1, Math.round(sorted.length * fraction)))
  return {
    holdout: sorted.slice(0, nHoldout),
    train: sorted.slice(nHoldout),
  }
}

function meanComposite(byScenario: Record<string, { meanComposite: number }>): {
  compositeMean: number
  perScenario: Record<string, number>
} {
  const perScenario: Record<string, number> = {}
  const values: number[] = []
  for (const [id, agg] of Object.entries(byScenario)) {
    perScenario[id] = agg.meanComposite
    values.push(agg.meanComposite)
  }
  return {
    compositeMean: values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length,
    perScenario,
  }
}

/**
 * Latest search campaign measured for the winner surface; the baseline search
 * campaign when the winner IS the baseline. Used by the deferred-holdout
 * summary, where no holdout campaign exists to summarize.
 */
function winnerSearchCampaign<TScenario extends Scenario, TArtifact>(
  result: RunImprovementLoopResult<TArtifact, TScenario>,
): RunImprovementLoopResult<TArtifact, TScenario>['baselineCampaign'] {
  for (let i = result.generations.length - 1; i >= 0; i--) {
    const measured = result.generations[i]?.surfaces.find(
      (s) => s.surfaceHash === result.winnerSurfaceHash,
    )
    if (measured) return measured.campaign
  }
  return result.baselineCampaign
}

/**
 * One-shot self-improvement loop. See module docstring for defaults +
 * extension points.
 *
 * @example Minimum:
 *
 *   const result = await selfImprove({
 *     agent: (surface, scenario, ctx) => myAgent(surface, scenario, ctx.signal),
 *     scenarios,
 *     judge,
 *     baselineSurface: DEFAULT_PROMPT,
 *     proposer,
 *   })
 *   console.log(`lift: ${result.lift.toFixed(3)} (${result.gateDecision})`)
 *
 * @example Distributed (workers in three regions):
 *
 *   await selfImprove({
 *     agent: httpDispatch({ resolveUrl: ({ placement }) => REGION_URLS[placement!] }),
 *     scenarios,
 *     judge,
 *     baselineSurface: DEFAULT_PROMPT,
 *     cellPlacement: ({ scenario }) => scenario.region,
 *     budget: { maxConcurrency: 12 },
 *   })
 */
export async function selfImprove<TScenario extends Scenario, TArtifact>(
  opts: SelfImproveOptions<TScenario, TArtifact>,
): Promise<SelfImproveResult<TScenario, TArtifact>> {
  const startedAt = Date.now()
  const requestedRunDir =
    opts.runDir ??
    (opts.method ? `.agent-eval/runs/self-improve-${startedAt}` : `mem://selfImprove-${startedAt}`)
  const runDir = resolveRunDir(requestedRunDir)
  const storage =
    opts.storage ?? (runDir.startsWith('mem://') ? inMemoryCampaignStorage() : fsCampaignStorage())
  const costLedger = createRunCostLedger({
    storage,
    runDir,
    costCeilingUsd: opts.budget?.dollars,
  })
  try {
    return await runSelfImprove(opts, costLedger, startedAt, runDir, storage)
  } catch (error) {
    throw new SelfImproveRunError(error, costLedger)
  }
}

async function runSelfImprove<TScenario extends Scenario, TArtifact>(
  opts: SelfImproveOptions<TScenario, TArtifact>,
  costLedger: CostLedgerHandle,
  startedAt: number,
  runDir: string,
  storage: CampaignStorage,
): Promise<SelfImproveResult<TScenario, TArtifact>> {
  const budget = opts.budget ?? {}
  assertSelfImproveSearchMode(opts)
  const generations = opts.method ? 1 : (budget.generations ?? 3)
  const populationSize = opts.method ? 1 : (budget.populationSize ?? 2)
  const maxConcurrency = budget.maxConcurrency ?? 2
  const holdoutFraction = budget.holdoutFraction ?? 0.25
  const holdoutMode = budget.holdout ?? 'measured'
  const holdoutDeferred = holdoutMode === 'deferred'
  const expectUsage = opts.expectUsage ?? 'assert'

  // Deferred holdout without an explicitly reserved set trains on EVERYTHING:
  // there is no held-out measurement in this run, so carving out a fraction
  // would waste scenarios. An explicit `holdoutScenarios` set stays reserved
  // (excluded from training) even when deferred, for the later measured run.
  const explicitHoldout = budget.holdoutScenarios
  const { train, holdout } = explicitHoldout
    ? {
        train: opts.scenarios.filter((s) => !explicitHoldout.some((h) => h.id === s.id)),
        holdout: explicitHoldout as TScenario[],
      }
    : holdoutDeferred
      ? { train: opts.scenarios, holdout: [] as TScenario[] }
      : splitTrainHoldout(opts.scenarios, holdoutFraction)

  if (train.length === 0) {
    throw new Error(
      'selfImprove: train split is empty. Reduce holdoutFraction or pass more scenarios.',
    )
  }
  if (holdout.length === 0 && !holdoutDeferred) {
    throw new Error('selfImprove: holdout split is empty. Pass more scenarios.')
  }

  if (generations > 0 && !opts.proposer && !opts.method) {
    throw new Error(
      'selfImprove: method or proposer is required when budget.generations is greater than zero',
    )
  }
  let optimizationResult: OptimizationMethodResult | undefined
  const methodPartitions = opts.method
    ? splitMethodPartitions(train, opts.selectionScenarios, budget.selectionFraction ?? 0.25)
    : undefined
  const proposer: SurfaceProposer = opts.method
    ? {
        kind: `method:${opts.method.name}`,
        propose: async (context) => {
          if (context.generation > 0) return []
          const result = await opts.method!.optimize(
            Object.freeze({
              baselineSurface: structuredClone(context.currentSurface),
              trainScenarios: Object.freeze(
                methodPartitions!.train.map((scenario) => structuredClone(scenario)),
              ),
              selectionScenarios: Object.freeze(
                methodPartitions!.selection.map((scenario) => structuredClone(scenario)),
              ),
              dispatchWithSurface: opts.agent,
              judges: Object.freeze([opts.judge]),
              runDir: `${runDir}/optimization/${safeRunComponent(opts.method!.name)}`,
              seed: 42,
              runOptions: Object.freeze({
                storage,
                maxConcurrency,
                reps: budget.reps,
                dispatchTimeoutMs: opts.dispatchTimeoutMs,
                expectUsage,
                costCeiling: budget.dollars,
              }),
              costLedger,
            }),
          )
          assertOptimizationResult(opts.method!.name, result)
          optimizationResult = structuredClone(result)
          return [
            {
              surface: structuredClone(result.winnerSurface),
              label: opts.method!.name,
              rationale: `${opts.method!.name} selected this surface without final cases.`,
            },
          ]
        },
      }
    : (opts.proposer ?? {
        kind: 'baseline-only',
        propose: async () => [],
      })

  const gate: Gate<TArtifact, TScenario> =
    opts.gate ??
    defaultProductionGate<TArtifact, TScenario>({
      holdoutScenarios: holdout,
      deltaThreshold: 0.05,
    })

  if (opts.onProgress) {
    opts.onProgress({ kind: 'baseline.started', scenarios: opts.scenarios.length })
  }

  const result = await runImprovementLoop<TScenario, TArtifact>({
    scenarios: train,
    baselineSurface: opts.baselineSurface,
    premeasuredBaseline: opts.premeasuredBaseline,
    dispatchWithSurface: opts.agent,
    proposer,
    judges: [opts.judge],
    populationSize,
    maxGenerations: generations,
    candidateConcurrency: budget.candidateConcurrency,
    reps: budget.reps,
    maxImprovementShots: budget.maxImprovementShots,
    holdoutScenarios: holdout,
    holdout: holdoutMode,
    gate,
    neutralize: opts.neutralize,
    autoOnPromote: opts.autoOnPromote ?? 'none',
    ghOwner: opts.ghOwner,
    ghRepo: opts.ghRepo,
    storage,
    runDir,
    maxConcurrency,
    cellPlacement: opts.cellPlacement,
    dispatchTimeoutMs: opts.dispatchTimeoutMs,
    costLedger,
    expectUsage,
    labeledStore: opts.labeledStore,
    captureSource: opts.captureSource,
    analyzeGeneration: opts.analyzeGeneration,
    findings: opts.findings,
  })

  // Deferred holdout ran zero holdout cells, so the summary stats come from
  // the improvement-set (search) campaigns — labeled as such on the result
  // type — and `lift` is omitted rather than fabricated from empty campaigns.
  const winnerSearch = holdoutDeferred ? winnerSearchCampaign(result) : undefined
  const baseline = meanComposite(
    (holdoutDeferred ? result.baselineCampaign : result.baselineOnHoldout).aggregates.byScenario,
  )
  const winnerStats = meanComposite((winnerSearch ?? result.winnerOnHoldout).aggregates.byScenario)

  // Power analysis from the baseline holdout cells — the number that says whether
  // this budget could ship ANY effect. Attached to every result; loud when the
  // search was structurally unable to promote (that spend should not repeat).
  let power: PowerPreflight | undefined
  const baselineHoldoutComposites = result.baselineOnHoldout.cells
    .filter((cell) => !cell.error)
    .map((cell) => {
      const scores = Object.values(cell.judgeScores)
      return scores.length === 0
        ? Number.NaN
        : scores.reduce((sum, s) => sum + s.composite, 0) / scores.length
    })
    .filter((v) => Number.isFinite(v))
  if (baselineHoldoutComposites.length >= 3) {
    // selfImprove's holdout is scored by the SAME judge as the gate — the
    // shared-channel case by construction (S1c): flag it so the MDE reads as a
    // lower bound and nobody buys reps expecting them to fix judge bias.
    power = powerPreflight({
      baselineComposites: baselineHoldoutComposites,
      sharedScorerChannel: true,
    })
    if (opts.onProgress) {
      opts.onProgress({
        kind: 'power.estimated',
        n: power.n,
        sd: power.sd,
        mde: power.mde,
        underpowered: power.underpowered,
      })
    }
    if (power.underpowered && generations > 0) {
      console.warn(`[selfImprove] ${power.recommendation}`)
    }
  }

  if (opts.onProgress) {
    opts.onProgress({
      kind: 'baseline.completed',
      compositeMean: baseline.compositeMean,
      durationMs: Date.now() - startedAt,
    })
    opts.onProgress({
      kind: 'gate.decided',
      decision: result.gateResult.decision,
      // Deferred holdout has no held-out measurement: in that mode the summary
      // stats are search-split numbers, and emitting their delta as `lift`
      // would misreport a train-split delta as a held-out one. Omit instead.
      ...(holdoutDeferred ? {} : { lift: winnerStats.compositeMean - baseline.compositeMean }),
    })
  }

  const cost = result.cost
  const totalCost = cost.totalCostUsd

  // Rigor packet: feed baseline + winner cells through analyzeRuns().
  // The two candidates (`baseline` / `winner`) give the lift section a
  // clean paired comparison; per-judge / per-dimension / cost-quality
  // sections populate from the cells' judgeScores.
  const insight = await analyzeRuns({
    runs: [
      ...cellsToRunRecords(result.baselineCampaign.cells, 'baseline', runDir, opts.baselineSurface),
      ...cellsToRunRecords(
        (winnerSearch ?? result.winnerOnHoldout).cells,
        'winner',
        runDir,
        result.winnerSurface,
      ),
    ],
    baselineCandidateId: 'baseline',
    candidateCandidateId: 'winner',
  })

  // ── Durable provenance: candidate→cell→gate→promote chain + rationale +
  // diff + backend provenance. Always emitted; the +lift recomputes from it.
  const durationMs = Date.now() - startedAt
  const { record: provenance } = await emitLoopProvenance<TArtifact, TScenario>({
    ...loopProvenanceArgsFromResult({
      runId: `${runDir}#${startedAt}`,
      runDir,
      timestamp: new Date(startedAt).toISOString(),
      baselineSurface: opts.baselineSurface,
      result,
      costReceipts: costLedger.list(),
      totalCostUsd: totalCost,
      totalDurationMs: durationMs,
    }),
    ...(optimizationResult
      ? {
          optimizationMethod: {
            name: opts.method!.name,
            cost: structuredClone(optimizationResult.cost),
            ...(optimizationResult.durationMs === undefined
              ? {}
              : { durationMs: optimizationResult.durationMs }),
            ...(optimizationResult.provenance === undefined
              ? {}
              : { provenance: structuredClone(optimizationResult.provenance) }),
          },
        }
      : {}),
    storage,
    hostedClient: opts.hostedTenant ? createHostedClient(opts.hostedTenant) : undefined,
  })
  if (opts.onProvenance) opts.onProvenance(provenance)

  const summary: SelfImproveResult<TScenario, TArtifact> = {
    baseline,
    winner: {
      ...winnerStats,
      surface: result.winnerSurface,
      ...(result.winnerLabel ? { label: result.winnerLabel } : {}),
      ...(result.winnerRationale ? { rationale: result.winnerRationale } : {}),
    },
    ...(holdoutDeferred ? {} : { lift: winnerStats.compositeMean - baseline.compositeMean }),
    diff: result.promotedDiff,
    provenance,
    gateDecision: result.gateResult.decision,
    generationsExplored: result.generations.length,
    durationMs,
    totalCostUsd: totalCost,
    cost,
    receipts: costLedger.list(),
    ...(optimizationResult
      ? {
          optimization: {
            name: opts.method!.name,
            cost: structuredClone(optimizationResult.cost),
            ...(optimizationResult.durationMs === undefined
              ? {}
              : { durationMs: optimizationResult.durationMs }),
            ...(optimizationResult.provenance === undefined
              ? {}
              : { provenance: structuredClone(optimizationResult.provenance) }),
          },
        }
      : {}),
    insight,
    ...(power ? { power } : {}),
    raw: result,
  }

  // Opt-in hosted ingest. Failures are logged but never fail the loop: the
  // local result is always returned.
  if (opts.hostedTenant) {
    try {
      await shipEvalRunToHosted(opts.hostedTenant, opts, summary, result, runDir)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console -- intentional: hosted-ingest is best-effort
      console.warn(`[agent-eval] hosted ingest failed (continuing): ${msg}`)
    }
  }

  return summary
}

async function shipEvalRunToHosted<TScenario extends Scenario, TArtifact>(
  tenant: HostedTenant,
  opts: SelfImproveOptions<TScenario, TArtifact>,
  summary: SelfImproveResult<TScenario, TArtifact>,
  raw: RunImprovementLoopResult<TArtifact, TScenario>,
  runDir: string,
): Promise<void> {
  const client = createHostedClient(tenant)

  function snapshotFromCampaign(
    index: number,
    surface: MutableSurface,
    campaign: RunImprovementLoopResult<TArtifact, TScenario>['baselineCampaign'],
    durationMs: number,
  ): EvalRunGenerationSnapshot {
    const cells: EvalRunCellScore[] = campaign.cells.map((cell) => {
      const judgeScores = Object.values(cell.judgeScores)
      const composite =
        judgeScores.length === 0
          ? 0
          : judgeScores.reduce((s, j) => s + j.composite, 0) / judgeScores.length
      return {
        scenarioId: cell.scenarioId,
        rep: cell.rep,
        compositeMean: composite,
        dimensions: Object.fromEntries(
          Object.entries(cell.judgeScores).map(([name, score]) => [name, score.dimensions]),
        ),
        errorMessage: cell.error ?? undefined,
      }
    })
    const compositeMean =
      cells.length === 0 ? 0 : cells.reduce((s, c) => s + c.compositeMean, 0) / cells.length
    return {
      index,
      surfaceHash: surfaceHash(surface),
      surface,
      cells,
      compositeMean,
      costUsd: campaign.aggregates.totalCostUsd,
      durationMs,
    }
  }

  const generations: EvalRunGenerationSnapshot[] = []
  // Baseline as generation 0.
  generations.push(snapshotFromCampaign(0, opts.baselineSurface, raw.baselineCampaign, 0))
  // Improvement generations as 1..N. Substrate stores per-surface campaigns
  // per generation — we summarize the WINNING surface per generation here.
  for (const gen of raw.generations) {
    const winner = gen.surfaces.reduce(
      (best, s) =>
        s.campaign.aggregates.cellsExecuted > 0 &&
        (best === undefined || averageComposite(s.campaign) > averageComposite(best.campaign))
          ? s
          : best,
      gen.surfaces[0],
    )
    if (!winner) continue
    generations.push(
      snapshotFromCampaign(gen.record.generationIndex + 1, winner.surface, winner.campaign, 0),
    )
  }

  const event: EvalRunEvent = {
    runId: `${runDir}#${Date.now()}`,
    runDir,
    timestamp: new Date().toISOString(),
    status: 'finished',
    labels: opts.hostedLabels ?? {},
    baseline: generations[0],
    generations,
    gateDecision: summary.gateDecision,
    holdoutLift: summary.lift,
    totalCostUsd: summary.totalCostUsd,
    totalDurationMs: summary.durationMs,
    insightReport: summary.insight,
  }

  await client.ingestEvalRun(event)
}

function averageComposite(
  campaign: RunImprovementLoopResult<unknown, Scenario>['baselineCampaign'],
): number {
  const aggs = Object.values(campaign.aggregates.byScenario)
  return aggs.length === 0 ? 0 : aggs.reduce((s, a) => s + a.meanComposite, 0) / aggs.length
}

function hashString(s: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Adapt campaign cells into the `RunRecord` shape `analyzeRuns()` consumes.
 * Each cell becomes one run; `candidateId` is the caller-supplied label so
 * baseline + winner pair cleanly on `(experimentId, seed)`.
 *
 * `promptHash` is the REAL sha256 content hash of the surface this cell ran
 * (baseline vs winner are byte-distinguishable + byte-identical-verifiable);
 * `configHash` is the sha256 of the candidate label so the two candidates'
 * config rows differ. Both were previously the literal `'sha256:cell'`, which
 * made baseline and winner indistinguishable in every downstream record.
 */
function cellsToRunRecords<TArtifact>(
  cells: ReadonlyArray<CampaignCellResult<TArtifact>>,
  candidateId: 'baseline' | 'winner',
  runId: string,
  surface: MutableSurface,
): RunRecord[] {
  const promptHash = surfaceContentHash(surface)
  const configHash = `sha256:${createHash('sha256').update(candidateId).digest('hex')}`
  return cells.map((cell) => {
    const perJudge: Record<string, Record<string, number>> = {}
    const perDimMeanAccum: Record<string, { sum: number; n: number }> = {}
    let compositeSum = 0
    let compositeCount = 0
    for (const [judgeId, score] of Object.entries(cell.judgeScores)) {
      perJudge[judgeId] = { ...score.dimensions }
      for (const [dim, value] of Object.entries(score.dimensions)) {
        if (!Number.isFinite(value)) continue
        const accum = perDimMeanAccum[dim] ?? { sum: 0, n: 0 }
        accum.sum += value
        accum.n += 1
        perDimMeanAccum[dim] = accum
      }
      if (Number.isFinite(score.composite)) {
        compositeSum += score.composite
        compositeCount += 1
      }
    }
    const perDimMean: Record<string, number> = {}
    for (const [dim, { sum, n }] of Object.entries(perDimMeanAccum)) {
      perDimMean[dim] = n === 0 ? 0 : sum / n
    }
    const composite = compositeCount === 0 ? 0 : compositeSum / compositeCount
    const judgeScores: JudgeScoresRecord = {
      perJudge,
      perDimMean,
      composite,
    }
    return {
      runId: `${runId}::${candidateId}::${cell.cellId}`,
      experimentId: runId,
      candidateId,
      // Pair on (scenarioId, rep) — analyzeRuns pairs on (experimentId, seed).
      // Synthesize a stable seed for that pairing.
      seed:
        cell.rep * 1_000_000 +
        hashString(cell.scenarioId)
          .slice(0, 6)
          .split('')
          .reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0),
      model: 'campaign-cell',
      promptHash,
      configHash,
      commitSha: 'cell',
      wallMs: cell.durationMs,
      costUsd: cell.costUsd,
      tokenUsage: {
        input: cell.tokenUsage.input,
        output: cell.tokenUsage.output,
        ...(cell.tokenUsage.reasoning === undefined
          ? {}
          : { reasoning: cell.tokenUsage.reasoning }),
        ...(cell.tokenUsage.cached === undefined ? {} : { cached: cell.tokenUsage.cached }),
        ...(cell.tokenUsage.cacheWrite === undefined
          ? {}
          : { cacheWrite: cell.tokenUsage.cacheWrite }),
      },
      outcome: {
        holdoutScore: composite,
        raw: {},
        judgeScores,
      },
      splitTag: 'holdout',
      ...(cell.error ? { failureMode: cell.error } : {}),
    } satisfies RunRecord
  })
}
