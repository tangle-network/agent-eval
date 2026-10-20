/** Optimization method inputs, provenance, results, and comparison contracts. */

import type { CostLedgerHandle } from '../../cost-ledger'
import type { CampaignEvidenceContext } from '../../experiment/campaign-evidence'
import type { EvaluationClaim, EvaluationUnitSummary } from '../../experiment/claim'
import type { EvidenceReceipt } from '../../experiment/evidence-receipt'
import type { PairedPromotionDecision } from '../../paired-promotion-decision'
import type { ExternalOptimizerWireCounts } from '../external-optimizer-contracts'
import type {
  ExternalOptimizerExecutionSummary,
  ExternalOptimizerObservationSummary,
} from '../external-optimizer-observations'
import type { FinalEvidencePolicy, FinalEvidenceUse } from '../final-evidence'
import type { GepaCandidatePopulationSummary } from '../gepa-candidate-population'
import type { ComparisonCost, OptimizationTokenUsage } from '../optimization-cost'
import type { RunCampaignOptions } from '../run-campaign'
import type {
  SearchHistoryAdmissionOptions,
  SearchHistoryCoverage,
  SearchHistoryReceipt,
} from '../search-history-receipt'
import type { DispatchContext, JudgeConfig, MutableSurface, Scenario } from '../types'

/** Shared campaign settings applied to every optimization method. */
export type OptimizationMethodRunOptions<TScenario extends Scenario, TArtifact> = Omit<
  RunCampaignOptions<TScenario, TArtifact>,
  'costCeiling' | 'costLedger' | 'dispatch' | 'judges' | 'runDir' | 'scenarios' | 'seed'
>

export interface OptimizationPackageSource {
  kind: 'package'
  /** Whether package identity was inspected or supplied by caller code. */
  evidence: 'observed' | 'declared'
  package: string
  version: string
  sourceUrl?: string
  revision?: string
  /** SHA-256 of all installed module files observed before the run. */
  sourceSha256?: string
}

export interface OptimizationModuleSource {
  module: string
  sourceSha256: string
}

export interface OptimizationPythonRuntime {
  implementation: string
  version: string
}

export interface OptimizationMethodProvenance {
  /** External optimizer package. */
  source: OptimizationPackageSource
  /** Python bridge package that invoked the optimizer. */
  bridge?: OptimizationPackageSource
  /** Custom engine modules imported by the optimizer. */
  modules?: OptimizationModuleSource[]
  /** Python implementation used by the bridge process. */
  python?: OptimizationPythonRuntime
  /** Exact model identifier configured for optimizer-owned model calls. */
  optimizerModel?: string
  /** Stable public identity of the execution-owner callback. */
  optimizerCallRef?: string
  runId: string
  /** Content identity shared by compatible resumptions. */
  compatibleRunId?: string
  resumed: boolean
  /** Whether the run seed reached every external engine configuration. */
  seedApplied?: boolean
  /** Evaluations the local callback metered — the trusted count. */
  evaluationCount: number
  /**
   * Evaluation total the external optimizer reported from its own counters.
   * A difference from `evaluationCount` means upstream skipped, cached, or
   * double-counted work; inspect before trusting upstream-derived budgets.
   */
  upstreamReportedEvaluations?: number
  artifactDir: string
  tokenUsage?: OptimizationTokenUsage
  /** Candidates submitted to the callback, per-case scores, and refusals. */
  observations?: ExternalOptimizerObservationSummary
  /** Exact accepted GEPA candidates, parent indices, and selection scores. */
  gepaCandidatePopulation?: GepaCandidatePopulationSummary
  /** Opaque Runtime execution evidence for every invoked optimizer-model call. */
  modelExecutions?: ExternalOptimizerExecutionSummary
  /** Anthropic-endpoint proxy traffic from agent CLI engines, when enabled. */
  anthropicEndpoint?: ExternalOptimizerWireCounts
}

/** Shared inputs for one optimization method. Final test data is absent. */
export interface OptimizationMethodInput<TScenario extends Scenario, TArtifact> {
  /** Surface every method starts from. */
  readonly baselineSurface: MutableSurface
  /** Evidence used to author or fit candidates. */
  readonly trainScenarios: readonly TScenario[]
  /** Data used for candidate acceptance, early stopping, and model selection. */
  readonly selectionScenarios: readonly TScenario[]
  /** Runs one scenario with a candidate surface. */
  readonly dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: DispatchContext,
  ) => Promise<TArtifact>
  /** Scores artifacts produced by `dispatchWithSurface`. */
  readonly judges: readonly JudgeConfig<TArtifact, TScenario>[]
  /** Method-specific artifacts are written below this directory. */
  readonly runDir: string
  readonly seed: number
  /** Shared defaults for every method. A method may override them explicitly. */
  readonly runOptions: Readonly<OptimizationMethodRunOptions<TScenario, TArtifact>>
  /** Durable spend account shared by every method and final scoring. */
  readonly costLedger: CostLedgerHandle
  /** Invokes each method at the shared execution boundary, including composed children. */
  invokeMethod?(
    method: OptimizationMethod<TScenario, TArtifact>,
    input: OptimizationMethodInput<TScenario, TArtifact>,
  ): Promise<OptimizationMethodResult>
  /** Maps this method's local surface into the complete outer candidate. */
  readonly surfaceToRoot?: (surface: MutableSurface) => MutableSurface
}

/** Exact child results; costs and usage remain attributable to their owning methods. */
export interface OptimizationMethodComposition {
  kind: 'scoped' | 'sequential'
  baselineSurfaceHash: string
  stages: Array<{
    name: string
    baselineSurfaceHash: string
    result: OptimizationMethodResult
  }>
}

export interface OptimizationMethodResult {
  /** Surface selected without using the final test partition. */
  winnerSurface: MutableSurface
  composition?: OptimizationMethodComposition
  /** Optimization spend. Excludes final test scoring. */
  cost: ComparisonCost
  /** Optimization duration. Excludes final test scoring. */
  durationMs?: number
  /** Exact external implementation and run identity, when the method uses one. */
  provenance?: OptimizationMethodProvenance
  /** Bounded proof envelope over the canonical SearchLedger for this optimization. */
  searchHistory?: SearchHistoryReceipt
}

/** A complete optimization method, including candidate generation and selection. */
export interface OptimizationMethod<TScenario extends Scenario = Scenario, TArtifact = unknown> {
  /** Unique, trimmed display name. Its normalized form must also be unique. */
  name: string
  optimize: (
    input: OptimizationMethodInput<TScenario, TArtifact>,
  ) => Promise<OptimizationMethodResult>
}

export interface OptimizationMethodScore {
  evidence?: { baseline: EvidenceReceipt; winner: EvidenceReceipt }
  name: string
  /** Mean final-test composite of the baseline (identical across methods). */
  baselineComposite: number
  /** Mean final-test composite of this method's selected surface. */
  winnerComposite: number
  /** Mean final-test lift across independent units (winner minus baseline). */
  lift: number
  /** Deciding interval, adjusted for every registered contrast. */
  liftCi: { low: number; high: number }
  decision: PairedPromotionDecision
  /** Search spend reconciled with recorded method calls. Excludes final test scoring. */
  optimizationCost: ComparisonCost
  /** Optimization duration reported by the method. Excludes final test scoring. */
  durationMs?: number
  /** Exact external implementation and run identity, when reported by the method. */
  provenance?: OptimizationMethodProvenance
  /** Paired final-test values used to compute lift and its interval. */
  scenarioScores: Array<{
    scenarioId: string
    baselineComposite: number
    winnerComposite: number
    lift: number
  }>
  /** Scenario means averaged within each registered source unit before inference. */
  unitScores: Array<{
    unitId: string
    scenarios: number
    baselineComposite: number
    winnerComposite: number
    lift: number
  }>
  winnerSurface: MutableSurface
  composition?: OptimizationMethodComposition
  /** 1-based, by descending lift. */
  rank: number
}

export interface OptimizationMethodPairwise {
  /** Higher-ranked method. */
  a: string
  b: string
  /** Mean final-test delta across independent units (a − b). */
  deltaMean: number
  low: number
  high: number
  /** Favored only when the full paired decision clears the registered effect; null is inconclusive. */
  favored: string | null
  decision: PairedPromotionDecision
}

export interface OptimizationMethodComparison {
  claim?: EvaluationClaim
  finalEvidence?: FinalEvidenceUse
  /** Sorted by descending lift; `rank` set accordingly. */
  scores: OptimizationMethodScore[]
  best: OptimizationMethodScore
  /** Best observed method versus each alternative, with simultaneous paired decisions. */
  pairwise: OptimizationMethodPairwise[]
  testScenarioIds: string[]
  units: EvaluationUnitSummary
  observationUnit: 'scenario' | 'registered'
  /** Complete scenario-replicate pairs per contrast, before unit aggregation. */
  pairedCellN: number
  /** Sum of method reports reconciled against each method's recorded calls. */
  optimizationCost: ComparisonCost
  /** Baseline and distinct winner scoring on the final test partition. */
  testCost: ComparisonCost
  /** Optimization plus final test scoring. */
  totalCost: ComparisonCost
  /** Caller-requested simultaneous coverage across all reported contrasts. */
  confidence: number
  /** Bonferroni-adjusted confidence used for each bootstrap interval. */
  intervalConfidence: number
  /** Method-vs-baseline plus all possible method-vs-method contrasts. */
  comparisonCount: number
  /** Deterministic bootstrap and campaign seed. */
  seed: number
  /** Bootstrap draws used for each interval. */
  resamples: number
  /** Agent runs averaged within each test scenario before resampling scenarios. */
  reps: number
  /** Coverage of every method's canonical search history. */
  searchHistory: SearchHistoryCoverage
}

export interface CompareOptimizationMethodsOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch' | 'judges' | 'scenarios'>,
    SearchHistoryAdmissionOptions {
  /** Explicit caller authority and environment for receipts over actual final measurements. */
  evidence?: CampaignEvidenceContext
  claim?: EvaluationClaim
  finalEvidence?: FinalEvidencePolicy
  methods: OptimizationMethod<TScenario, TArtifact>[]
  baselineSurface: MutableSurface
  /** Evidence used by every optimizer to author or fit candidates. */
  trainScenarios: TScenario[]
  /** Candidate acceptance, early-stopping, and optimizer-selection data. */
  selectionScenarios: TScenario[]
  /** Untouched final comparison data. Never passed to an optimization method. */
  testScenarios: TScenario[]
  /** Scores a surface on a scenario. The methods and final test share this function. */
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: DispatchContext,
  ) => Promise<TArtifact>
  judges: JudgeConfig<TArtifact, TScenario>[]
  /** Bootstrap resamples for the lift intervals. Default is at least 2000 and
   *  rises when the requested simultaneous confidence needs finer tails. */
  resamples?: number
  /** Shared defaults for each method's train and selection campaigns. */
  optimizationRunOptions?: OptimizationMethodRunOptions<TScenario, TArtifact>
  /** Number of optimization methods to run concurrently. Default 1. */
  optimizationConcurrency?: number
  /** Simultaneous confidence across method-vs-baseline and method-vs-method contrasts.
   *  Each bootstrap interval is Bonferroni-adjusted. Default 0.95. */
  confidence?: number
  /** Shared spend limit across every method's optimizer and evaluation calls plus final scoring. */
  costCeiling?: number
}
