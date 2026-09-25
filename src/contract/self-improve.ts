import { defineEvaluationClaim, type EvaluationClaim } from '../experiment/claim'
/**
 * Run one complete improvement job.
 *
 * A caller-owned `proposer` can generate candidates across local generations.
 * An external `method`, such as official GEPA or SkillOpt, owns its complete
 * search and returns one candidate. Both paths remeasure the selected candidate
 * against cases that candidate generation never receives.
 */

import type { ProposalFinding } from '../analyst/types'
import {
  assertIndependentEvaluationSplit,
  captureFinalEvidencePolicy,
  evaluationUnitMap,
  type FinalEvidencePolicy,
  type FinalEvidenceUse,
  reserveFinalEvidence,
} from '../campaign/final-evidence'
import { defaultProductionGate } from '../campaign/gates/default-production-gate'
import { type PowerPreflight, powerPreflight } from '../campaign/gates/power-preflight'
import { captureJudge } from '../campaign/judge-snapshot'
import type {
  OptimizationMethod,
  OptimizationMethodProvenance,
  OptimizationMethodResult,
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
import type { CampaignCellRetryPolicy } from '../campaign/run-campaign'
import { resolveRunDir } from '../campaign/run-dir'
import type { SearchHistoryReceipt } from '../campaign/search-history-receipt'
import {
  assertSearchHistoryAdmissionOptions,
  type SearchHistoryAdmissionOptions,
} from '../campaign/search-history-receipt'
import {
  type CampaignStorage,
  createRunCostLedger,
  fsCampaignStorage,
  inMemoryCampaignStorage,
} from '../campaign/storage'
import type {
  DispatchContext,
  Gate,
  JudgeConfig,
  LabeledScenarioStore,
  MutableSurface,
  Scenario,
  SurfaceProposer,
} from '../campaign/types'
import type { CostLedgerHandle, CostLedgerSummary, CostReceipt } from '../cost-ledger'
import type { CampaignEvidenceContext } from '../experiment/campaign-evidence'
import { createHostedClient, type HostedTenant } from '../hosted/client'
import { shipBestEffort, startSearchShipper } from '../hosted/search-shipper'
import type { RunSplitTag } from '../run-record'
import { analyzeRuns } from './analyze-runs'
import type { InsightReport } from './insight-report'
import {
  runSelfImproveMethod,
  type SelfImproveMethodProvenance,
  type SelfImproveMethodResult,
} from './self-improve-method'
import { cellsToRunRecords, pairedCompositeSummary } from './self-improve-reporting'

export type { SelfImproveMethodProvenance, SelfImproveMethodResult } from './self-improve-method'

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
  /** Repeated executions per scenario. A claim's independent-unit count stays unchanged. Default 1. */
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

export interface SelfImproveOptions<TScenario extends Scenario, TArtifact>
  extends SearchHistoryAdmissionOptions {
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

  /**
   * Snapshot-bearing model identity for agents that do not report a paid-call
   * receipt through `ctx.cost.runPaidCall()`.
   *
   * Omit this when every cell reports its concrete model in a receipt.
   */
  model?: string
  /** Version of execution behavior outside the candidate surface, used by measurement caches. */
  dispatchRef?: string

  /** Scenarios to evaluate against. Train/holdout split is computed from
   *  these unless `budget.holdoutScenarios` is set explicitly. */
  scenarios: TScenario[]

  /** Judge that scores artifacts. Bring your own, or wrap `llmJudge`. */
  judge: JudgeConfig<TArtifact, TScenario>

  /** Starting surface — system prompt, JSON config, anything `MutableSurface`
   *  accepts. The proposer mutates this each generation. */
  baselineSurface: MutableSurface

  /** Budget + loop shape. All fields optional. */
  budget?: SelfImproveBudget

  /**
   * Complete prior measurement of `baselineSurface` over the TRAIN split.
   * Forwarded to the loop body, which validates its surface hash, scenario
   * split, seed (42), reps, evaluator manifest, and coverage, then skips the baseline search
   * campaign entirely — no baseline dispatch, no resumability lookup. The
   * train split is `scenarios` minus the holdout split, so premeasure with
   * exactly that scenario set (explicit `budget.holdoutScenarios`, or
   * `budget.holdout: 'deferred'` with no reserved set, makes the train split
   * deterministic). Prior spend stays in the imported campaign aggregates and
   * is not re-added to this run's cost ledger. Premeasure with
   * `dispatchRef: surfaceDispatchRef(baselineSurface, dispatchRef)` and the same judge revision.
   */
  premeasuredBaseline?: PremeasuredOptimizationBaseline<TArtifact, TScenario>

  /**
   * Candidate generator for this local generation loop.
   * Required when `budget.generations` is greater than zero.
   */
  proposer?: SurfaceProposer<ProposalFinding>

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

  /** Fires once the durable provenance record is written.
   *  Receives the structured record for inline assertions / custom routing. */
  onProvenance?: (record: LoopProvenanceRecord | SelfImproveMethodProvenance) => void

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

  /** Bounded in-run retry of failed cells — same as
   *  `RunCampaignOptions.cellRetry`, applied to baseline, candidate, and
   *  held-out campaigns. Pair with `transientDispatchFailure()` so a
   *  transport hiccup (a router 503, a dropped stream) is re-dispatched in
   *  the same slot instead of leaving holdout coverage incomplete. Absent by
   *  default: a failed cell is final. */
  cellRetry?: CampaignCellRetryPolicy

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
   * Opt-in: ship this run's search ledger to a hosted store (ours, your
   * self-hosted one, or any implementation of `docs/hosted-ingest-spec.md`).
   * In proposer mode it requires `searchLedger`, and the ledger ships while
   * the loop runs; in method mode the ledger the method recorded ships when
   * the method returns. A failed ship is logged and never fails the loop: the
   * local ledger is the source of truth, and `agent-eval search ship <ledger>`
   * resumes from the store's head.
   *
   * For our orchestrator: `{ endpoint: 'https://orchestrator.tangle.tools', apiKey, tenantId }`.
   * For your self-hosted one: see `examples/hosted-ingest-server/`.
   */
  hostedTenant?: HostedTenant

  /** Capture every search artifact and judge score to this store.
   *  The store is output only and is never exposed to candidate generation.
   *  Pass `'off'` to disable. Default: off. */
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
  findings?: ProposalFinding[]

  /** Which measured surface each proposal extends and which one the run
   *  keeps. Default `incumbent()`: the hill climb. Pass
   *  `crowdedFrontierParent({ seed })` to draw parents from the Pareto
   *  frontier. Proposer mode only. See `RunOptimizationOptions.policy`. */
  policy?: RunOptimizationOptions<TScenario, TArtifact>['policy']

  /** Where the run's search ledger goes and the identities it records. The
   *  ledger is always written; see `RunOptimizationOptions.searchLedger`. */
  searchLedger?: RunOptimizationOptions<TScenario, TArtifact>['searchLedger']
  /** Complete-method final measurement receipts; authority and environment remain caller-owned. */
  evidence?: CampaignEvidenceContext
  /** Declare the population and independent units without requiring fresh data. */
  claim?: EvaluationClaim
  /** Opt into durable fresh-evidence consumption for this final comparison. */
  finalEvidence?: FinalEvidencePolicy
}

export interface SelfImproveProposerResult<TScenario extends Scenario, TArtifact> {
  mode: 'proposer'
  claim?: EvaluationClaim
  finalEvidence?: FinalEvidenceUse
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
  /** Bounded proof envelope over this run's search ledger: always present in
   *  proposer mode, and in method mode when the method recorded a search. */
  searchHistory?: SearchHistoryReceipt
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
  /** Approximate detectable lift from baseline holdout observations.
   *  Declared independent units determine n and baseline variance.
   *  Absent with fewer than three observations or a deferred holdout. */
  power?: PowerPreflight
  /**
   * Raw substrate result for advanced inspection — full per-generation
   * candidates, full campaign artifacts, all judge scores. Useful for
   * debugging or reporting beyond the summary.
   */
  raw: RunImprovementLoopResult<TArtifact, TScenario>
}

export type SelfImproveResult<TScenario extends Scenario, TArtifact> =
  | SelfImproveProposerResult<TScenario, TArtifact>
  | SelfImproveMethodResult<TScenario, TArtifact>

export type SelfImproveMethodOptions<TScenario extends Scenario, TArtifact> = Omit<
  SelfImproveOptions<TScenario, TArtifact>,
  'proposer' | 'onProvenance'
> & {
  method: OptimizationMethod<TScenario, TArtifact>
  proposer?: never
  onProvenance?: (record: SelfImproveMethodProvenance) => void
}

export type SelfImproveProposerOptions<TScenario extends Scenario, TArtifact> = Omit<
  SelfImproveOptions<TScenario, TArtifact>,
  'method' | 'onProvenance'
> & {
  method?: never
  onProvenance?: (record: LoopProvenanceRecord) => void
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
  assertSearchHistoryAdmissionOptions(opts)
  if (
    !opts.method &&
    (opts.searchHistoryPolicy !== undefined ||
      opts.searchHistoryVerification !== undefined ||
      opts.evidence !== undefined)
  )
    throw new Error('selfImprove: search history admission requires method')
  if (opts.method && opts.proposer) {
    throw new Error('selfImprove: method and proposer are mutually exclusive')
  }
  if (!opts.method) {
    if (opts.selectionScenarios !== undefined) {
      throw new Error('selfImprove: selectionScenarios requires method')
    }
    if (opts.hostedTenant && !opts.searchLedger) {
      throw new Error(
        'selfImprove: hostedTenant ships the search ledger; pass searchLedger (docs/search-ledger.md)',
      )
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
  if (budget?.generations !== undefined) {
    throw new Error(
      'selfImprove: method owns its rounds; budget.generations applies only to proposer mode',
    )
  }
  if (budget?.populationSize !== undefined) {
    throw new Error(
      'selfImprove: method owns its candidates; budget.populationSize applies only to proposer mode',
    )
  }
  if (
    budget?.candidateConcurrency !== undefined ||
    budget?.maxImprovementShots !== undefined ||
    opts.analyzeGeneration !== undefined ||
    opts.findings !== undefined ||
    opts.policy !== undefined ||
    opts.premeasuredBaseline !== undefined ||
    opts.searchLedger !== undefined
  ) {
    throw new Error(
      'selfImprove: candidateConcurrency, maxImprovementShots, analyzeGeneration, findings, policy, premeasuredBaseline, and searchLedger apply only to proposer mode',
    )
  }
}

function splitMethodPartitions<TScenario extends Scenario>(
  searchScenarios: TScenario[],
  explicitSelection: TScenario[] | undefined,
  fraction: number,
  unitByScenario?: ReadonlyMap<string, string>,
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
    if (unitByScenario) {
      const selectedUnits = new Set([...selectionIds].map((id) => unitByScenario.get(id)))
      if (train.some((scenario) => selectedUnits.has(unitByScenario.get(scenario.id)))) {
        throw new Error('selfImprove: training and selection share independent units')
      }
    }
    return {
      train,
      selection: explicitSelection.map((scenario) => byId.get(scenario.id)!),
    }
  }
  if (searchScenarios.length < 2) {
    throw new Error('selfImprove: method requires at least two non-final scenarios')
  }
  if (unitByScenario) {
    const split = splitTrainHoldout(searchScenarios, fraction, unitByScenario)
    return { train: split.train, selection: split.holdout }
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

/** 32-bit FNV-1a over raw UTF-16 code units, read as an unsigned int and used
 *  only to order scenarios deterministically.
 *
 *  Frozen: the order it produces assigns scenarios to partitions, so a change
 *  re-partitions decisions already recorded. It masks no byte, unlike
 *  `fnv1a32` in `src/partition-held-out.ts`, so the two disagree on any
 *  non-ASCII id and cannot be shared. */
function stableScenarioHash(value: string): number {
  let hash = 2166136261 >>> 0
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

/** Deterministic split by scenario identity, or by source identity for new-unit claims. */
function splitTrainHoldout<TScenario extends Scenario>(
  scenarios: TScenario[],
  fraction: number,
  unitByScenario?: ReadonlyMap<string, string>,
): { train: TScenario[]; holdout: TScenario[] } {
  if (unitByScenario) {
    const units = [...new Set(scenarios.map((scenario) => unitByScenario.get(scenario.id)!))].sort(
      (a, b) => stableScenarioHash(a) - stableScenarioHash(b) || (a < b ? -1 : a > b ? 1 : 0),
    )
    if (units.length < 2)
      throw new Error('selfImprove: splitting needs at least two independent units')
    const count = Math.max(1, Math.min(units.length - 1, Math.round(units.length * fraction)))
    const finalUnits = new Set(units.slice(0, count))
    return {
      holdout: scenarios.filter((scenario) => finalUnits.has(unitByScenario.get(scenario.id)!)),
      train: scenarios.filter((scenario) => !finalUnits.has(unitByScenario.get(scenario.id)!)),
    }
  }
  const sorted = [...scenarios].sort((a, b) => stableScenarioHash(a.id) - stableScenarioHash(b.id))
  const nHoldout = Math.max(1, Math.min(sorted.length - 1, Math.round(sorted.length * fraction)))
  return {
    holdout: sorted.slice(0, nHoldout),
    train: sorted.slice(nHoldout),
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
export function selfImprove<TScenario extends Scenario, TArtifact>(
  opts: SelfImproveMethodOptions<TScenario, TArtifact>,
): Promise<SelfImproveMethodResult<TScenario, TArtifact>>
export function selfImprove<TScenario extends Scenario, TArtifact>(
  opts: SelfImproveProposerOptions<TScenario, TArtifact>,
): Promise<SelfImproveProposerResult<TScenario, TArtifact>>
export function selfImprove<TScenario extends Scenario, TArtifact>(
  opts: SelfImproveOptions<TScenario, TArtifact>,
): Promise<SelfImproveResult<TScenario, TArtifact>>
export async function selfImprove<TScenario extends Scenario, TArtifact>(
  opts:
    | SelfImproveOptions<TScenario, TArtifact>
    | SelfImproveMethodOptions<TScenario, TArtifact>
    | SelfImproveProposerOptions<TScenario, TArtifact>,
): Promise<SelfImproveResult<TScenario, TArtifact>> {
  opts = {
    ...opts,
    judge: captureJudge(opts.judge),
    ...(opts.claim || opts.finalEvidence
      ? {
          claim: opts.claim && defineEvaluationClaim(opts.claim),
          finalEvidence: opts.finalEvidence && captureFinalEvidencePolicy(opts.finalEvidence),
          scenarios: structuredClone(opts.scenarios),
          selectionScenarios: opts.selectionScenarios && structuredClone(opts.selectionScenarios),
          budget: opts.budget && structuredClone(opts.budget),
        }
      : {}),
  }
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
    return await runSelfImprove(
      opts as SelfImproveOptions<TScenario, TArtifact>,
      costLedger,
      startedAt,
      runDir,
      storage,
    )
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
  const maxConcurrency = budget.maxConcurrency ?? 2
  const holdoutFraction = budget.holdoutFraction ?? 0.25
  const holdoutMode = budget.holdout ?? 'measured'
  const holdoutDeferred = holdoutMode === 'deferred'
  const expectUsage = opts.expectUsage ?? 'assert'
  const unitByScenario = opts.claim ? evaluationUnitMap(opts.claim, opts.scenarios) : undefined
  const splitUnitByScenario =
    opts.claim?.generalization === 'new-units' ? unitByScenario : undefined

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
      : splitTrainHoldout(opts.scenarios, holdoutFraction, splitUnitByScenario)

  if (train.length === 0) {
    throw new Error(
      'selfImprove: train split is empty. Reduce holdoutFraction or pass more scenarios.',
    )
  }
  if (holdout.length === 0 && !holdoutDeferred) {
    throw new Error('selfImprove: holdout split is empty. Pass more scenarios.')
  }

  if (opts.claim?.generalization === 'new-units') {
    assertIndependentEvaluationSplit(opts.claim, holdout, train)
  }
  if (opts.finalEvidence) {
    if (holdoutDeferred) throw new Error('final evidence requires measured holdout')
    if (opts.method) await reserveFinalEvidence(opts.finalEvidence, opts.claim, holdout, train)
  }

  if (opts.method) {
    const partitions = splitMethodPartitions(
      train,
      opts.selectionScenarios,
      budget.selectionFraction ?? 0.25,
      splitUnitByScenario,
    )
    return runSelfImproveMethod({
      opts: { ...opts, method: opts.method },
      train: partitions.train,
      selection: partitions.selection,
      holdout,
      costLedger,
      storage,
      runDir,
      startedAt,
    })
  }
  const generations = budget.generations ?? 3
  const populationSize = budget.populationSize ?? 2
  if (generations > 0 && !opts.proposer) {
    throw new Error(
      'selfImprove: method or proposer is required when budget.generations is greater than zero',
    )
  }
  const proposer: SurfaceProposer<ProposalFinding> = opts.proposer ?? {
    kind: 'baseline-only',
    propose: async () => [],
  }

  const gate: Gate<TArtifact, TScenario> =
    opts.gate ??
    defaultProductionGate<TArtifact, TScenario>({
      holdoutScenarios: holdout,
      deltaThreshold: opts.claim?.minimumEffect ?? 0.05,
      independentUnitByScenarioId: opts.claim ? evaluationUnitMap(opts.claim, holdout) : undefined,
    })

  if (opts.onProgress) {
    opts.onProgress({ kind: 'baseline.started', scenarios: opts.scenarios.length })
  }

  const shipper =
    opts.hostedTenant && opts.searchLedger
      ? startSearchShipper({
          tenant: opts.hostedTenant,
          ledger: opts.searchLedger.ledger,
          runKind: 'optimization',
        })
      : undefined
  const result = await runImprovementLoop<TScenario, TArtifact>({
    scenarios: train,
    baselineSurface: opts.baselineSurface,
    premeasuredBaseline: opts.premeasuredBaseline,
    dispatchWithSurface: opts.agent,
    dispatchRef: opts.dispatchRef,
    proposer,
    judges: [opts.judge],
    populationSize,
    maxGenerations: generations,
    candidateConcurrency: budget.candidateConcurrency,
    reps: budget.reps,
    maxImprovementShots: budget.maxImprovementShots,
    holdoutScenarios: holdout,
    claim: opts.claim,
    finalEvidence: opts.finalEvidence,
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
    cellRetry: opts.cellRetry,
    costLedger,
    expectUsage,
    labeledStore: opts.labeledStore,
    captureSource: opts.captureSource,
    analyzeGeneration: opts.analyzeGeneration,
    findings: opts.findings,
    policy: opts.policy,
    searchLedger: opts.searchLedger,
  }).finally(() => shipper && shipBestEffort(() => shipper.stop(), opts.searchLedger!.ledger.path))

  // Deferred holdout ran zero holdout cells, so the summary stats come from
  // the improvement-set (search) campaigns — labeled as such on the result
  // type — and `lift` is omitted rather than fabricated from empty campaigns.
  const reportSplit: RunSplitTag = holdoutDeferred ? 'search' : 'holdout'
  const reportBaselineCampaign = holdoutDeferred
    ? result.baselineCampaign
    : result.baselineOnHoldout
  const reportWinnerCampaign = holdoutDeferred
    ? winnerSearchCampaign(result)
    : result.winnerOnHoldout
  const reportUnitMap = opts.claim
    ? evaluationUnitMap(opts.claim, holdoutDeferred ? train : holdout)
    : undefined
  const report = pairedCompositeSummary(reportBaselineCampaign, reportWinnerCampaign, reportUnitMap)
  const baseline = report.baseline
  const winnerStats = report.winner

  // Repetitions refine a declared unit's mean without increasing the sample size.
  let power: PowerPreflight | undefined
  const baselineHoldoutComposites = holdoutDeferred ? [] : report.baselineComposites
  if (baselineHoldoutComposites.length >= 3) {
    // The shared judge's systematic bias remains outside this variance estimate.
    power = powerPreflight({
      baselineComposites: baselineHoldoutComposites,
      deltaThreshold: opts.claim?.minimumEffect ?? 0.05,
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
      ...cellsToRunRecords(
        reportBaselineCampaign.cells,
        'baseline',
        runDir,
        opts.baselineSurface,
        reportSplit,
        opts.model,
      ),
      ...(reportWinnerCampaign === reportBaselineCampaign
        ? []
        : cellsToRunRecords(
            reportWinnerCampaign.cells,
            'winner',
            runDir,
            result.winnerSurface,
            reportSplit,
            opts.model,
          )),
    ],
    baselineCandidateId: 'baseline',
    independentUnitByScenarioId: reportUnitMap,
    decisionThreshold: opts.claim?.minimumEffect ?? 0.05,
    ...(reportWinnerCampaign === reportBaselineCampaign ? {} : { candidateCandidateId: 'winner' }),
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
      independentUnitByScenarioId: holdoutDeferred ? undefined : reportUnitMap,
    }),
    storage,
    hostedClient: opts.hostedTenant ? createHostedClient(opts.hostedTenant) : undefined,
  })
  if (opts.onProvenance) opts.onProvenance(provenance)

  const summary: SelfImproveProposerResult<TScenario, TArtifact> = {
    ...(opts.claim ? { claim: opts.claim } : {}),
    ...(result.finalEvidence ? { finalEvidence: result.finalEvidence } : {}),
    mode: 'proposer',
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
    searchHistory: result.searchHistory,
    insight,
    ...(power ? { power } : {}),
    raw: result,
  }

  return summary
}
