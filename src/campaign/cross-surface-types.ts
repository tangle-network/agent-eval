import type { PairedArmsComparison } from '../paired-arms'
import type { PairedBootstrapResult } from '../statistics'

/** Whether one candidate attempt produced a usable executable outcome. */
export type CrossSurfaceAttemptCompleteness = 'complete' | 'missing' | 'invalid'

/** One independently proposed change on one caller-defined surface. */
export interface CrossSurfaceComponent {
  componentId: string
  surfaceId: string
  /** Explicitly controls whether this component may anchor the best-single arm. */
  bestSingleEligible: boolean
}

/** Immutable identity for a single candidate or a materialized composition. */
export interface CrossSurfaceCandidate {
  candidateId: string
  componentIds: string[]
  contentHash: string
  artifactBytes: number
}

/** Per-component trace evidence captured during one task attempt. */
export interface CrossSurfaceComponentEvidence {
  componentId: string
  /** null means the trace could not establish whether the component fired. */
  fired: boolean | null
  /** null means the trace could not establish whether the component changed behavior. */
  effectObserved: boolean | null
}

/**
 * Canonical per-task input row. Consumers may extend this interface with
 * receipt, trace, retry, or failure details; the report preserves the original
 * row object rather than projecting those details away.
 */
export interface CrossSurfaceTaskRow {
  taskId: string
  candidateId: string
  /** Repeated here so every persisted row remains self-describing. */
  componentIds: string[]
  completeness: CrossSurfaceAttemptCompleteness
  pass: boolean | null
  score: number | null
  /**
   * Per-attempt deployment measurements. Every declared metric must have a
   * known, non-negative value. Proposal, analysis, and selection spend belongs
   * in the search ledger rather than being spread across task cells.
   */
  cost: Record<string, number | null>
  componentEvidence: CrossSurfaceComponentEvidence[]
  /** Required for missing or invalid attempts; forbidden for complete attempts. */
  rejectReason: string | null
}

export interface CrossSurfaceBootstrapPolicy {
  seed: number
  resamples: number
  confidence: number
}

/** Predeclared candidate eligibility and composition policy. */
export interface CrossSurfaceSelectionPolicy {
  minimumFiringTasks: number
  minimumEffectTasks: number
  requireObservedFiring: boolean
  requireObservedEffect: boolean
  /** Only named metrics are constrained; all declared metrics are still reported. */
  maximumMedianCostRatioToBaseline: Record<string, number>
  /** A smaller terminal bundle is reported but cannot become the selected arm. */
  minimumBundleComponents: number
}

export interface AnalyzeCrossSurfaceInteractionsInput<
  TRow extends CrossSurfaceTaskRow = CrossSurfaceTaskRow,
> {
  components: readonly CrossSurfaceComponent[]
  candidates: readonly CrossSurfaceCandidate[]
  rows: readonly TRow[]
  baselineCandidateId: string
  /** Exact shared task axis and its canonical output order. */
  taskOrder: readonly string[]
  /** Canonical materialization order for component sets and the naive stack. */
  componentOrder: readonly string[]
  /** Final deterministic tie-break; lower index wins. */
  candidateOrder: readonly string[]
  /** Declares every cost key and the order used for cost tie-breaks. */
  costMetricOrder: readonly string[]
  bootstrap: CrossSurfaceBootstrapPolicy
  selection: CrossSurfaceSelectionPolicy
}

export interface CrossSurfaceDistribution {
  n: number
  min: number
  median: number
  mean: number
  max: number
  total: number
}

export interface CrossSurfaceEvidenceBreakdown {
  componentId: string
  observedTaskIds: string[]
  notObservedTaskIds: string[]
  unobservedTaskIds: string[]
}

export interface CrossSurfaceCandidateEvidence {
  byComponent: CrossSurfaceEvidenceBreakdown[]
  allObservedTaskIds: string[]
  someObservedTaskIds: string[]
  noneObservedTaskIds: string[]
  unobservedTaskIds: string[]
}

export type CrossSurfaceIneligibilityReason =
  | 'missing_attempt'
  | 'invalid_attempt'
  | 'baseline_outcome_missing'
  | 'benefit_not_greater_than_regression'
  | 'firing_below_minimum'
  | 'firing_unobserved'
  | 'effect_below_minimum'
  | 'effect_unobserved'
  | 'cost_limit_exceeded'

export interface CrossSurfaceEligibility {
  eligible: boolean
  reasons: CrossSurfaceIneligibilityReason[]
}

export interface CrossSurfaceCandidateOutcome {
  resolvedTaskIds: string[]
  failedTaskIds: string[]
  missingTaskIds: string[]
  invalidTaskIds: string[]
  benefitTaskIds: string[]
  regressionTaskIds: string[]
  comparisonMissingTaskIds: string[]
  netBenefit: number
}

export interface CrossSurfaceCandidateSummary {
  candidate: CrossSurfaceCandidate
  outcome: CrossSurfaceCandidateOutcome
  score: CrossSurfaceDistribution | null
  costs: Record<string, CrossSurfaceDistribution>
  firing: CrossSurfaceCandidateEvidence
  effect: CrossSurfaceCandidateEvidence
  /** Reuses the package's paired McNemar/risk-difference/bootstrap statistics. */
  comparisonToBaseline: PairedArmsComparison | null
  /** null only for the fixed baseline. */
  eligibility: CrossSurfaceEligibility | null
}

export interface CrossSurfaceRelativeCost {
  treatmentMedian: number
  comparatorMedian: number
  medianDelta: number
  /** null when the comparator median is zero but the treatment median is not. */
  medianRatio: number | null
}

export interface CrossSurfaceCandidateComparison {
  comparatorCandidateId: string
  treatmentCandidateId: string
  winsTaskIds: string[]
  regressionTaskIds: string[]
  missingTaskIds: string[]
  paired: PairedArmsComparison
  relativeCost: Record<string, CrossSurfaceRelativeCost>
}

export interface CrossSurfacePairEvidence {
  bothTaskIds: string[]
  leftOnlyTaskIds: string[]
  rightOnlyTaskIds: string[]
  neitherTaskIds: string[]
  unobservedTaskIds: string[]
}

export interface CrossSurfaceInteractionTask {
  taskId: string
  /** Composition minus the additive expectation from the baseline and singles. */
  passInteraction: number | null
  scoreInteraction: number | null
}

export interface CrossSurfaceInteractionEffect {
  perTask: CrossSurfaceInteractionTask[]
  n: number
  nMissing: number
  meanPassInteraction: number | null
  meanScoreInteraction: number | null
  passBootstrap: PairedBootstrapResult | null
  scoreBootstrap: PairedBootstrapResult | null
}

export type CrossSurfacePairIncompatibilityReason =
  | 'constituent_not_ready'
  | 'pair_incomplete'
  | 'baseline_regression'
  | 'interference'
  | 'no_incremental_resolution'
  | 'firing_below_minimum'
  | 'firing_unobserved'
  | 'effect_below_minimum'
  | 'effect_unobserved'
  | 'cost_limit_exceeded'

export interface CrossSurfacePairCompatibility {
  compatible: boolean
  reasons: CrossSurfacePairIncompatibilityReason[]
  betterSingleCandidateId: string
}

export interface CrossSurfacePairwiseEntry {
  componentIds: [string, string]
  singleCandidateIds: [string, string]
  compositionCandidateId: string
  benefitTaskIds: string[]
  regressionTaskIds: string[]
  synergyTaskIds: string[]
  interferenceTaskIds: string[]
  incrementalVsConstituents: [CrossSurfaceCandidateComparison, CrossSurfaceCandidateComparison]
  relativeCostToBaseline: Record<string, CrossSurfaceRelativeCost>
  firing: CrossSurfacePairEvidence
  effect: CrossSurfacePairEvidence
  interaction: CrossSurfaceInteractionEffect
  compatibility: CrossSurfacePairCompatibility
}

export interface CrossSurfaceRankedSingle {
  rank: number
  candidateId: string
  componentId: string
}

export interface CrossSurfaceBestSingleSelection {
  candidateId: string
  componentId: string
  ranking: CrossSurfaceRankedSingle[]
}

export interface CrossSurfaceNaiveStackSelection {
  candidateId: string
  componentIds: string[]
}

export type CrossSurfaceAdditionRejectionReason =
  | 'pair_incompatible'
  | 'full_bundle_not_evaluated'
  | 'bundle_incomplete'
  | 'baseline_regression'
  | 'no_incremental_resolution'
  | 'incremental_regression'
  | 'firing_below_minimum'
  | 'firing_unobserved'
  | 'effect_below_minimum'
  | 'effect_unobserved'
  | 'cost_limit_exceeded'

export interface CrossSurfaceAdditionDecision {
  additionCandidateId: string
  additionComponentId: string
  bundleCandidateId: string | null
  incrementalResolutionTaskIds: string[]
  incrementalRegressionTaskIds: string[]
  incrementalMedianCost: Record<string, number> | null
  eligible: boolean
  selected: boolean
  reasons: CrossSurfaceAdditionRejectionReason[]
}

export interface CrossSurfaceCompositionStep {
  fromCandidateId: string
  retainedComponentIds: string[]
  considered: CrossSurfaceAdditionDecision[]
  selectedCandidateId: string | null
}

/** One deterministic growth path starting from a compatible two-surface seed. */
export interface CrossSurfaceInteractionPath {
  seedCandidateId: string
  terminalCandidateId: string
  terminalComponentIds: string[]
  qualified: boolean
  steps: CrossSurfaceCompositionStep[]
}

export interface CrossSurfaceInteractionAwareSelection {
  /** Compatible pair that seeded the selected deterministic growth path. */
  seedCandidateId: string
  /** Candidate reached by the winning path, even if the minimum size is not met. */
  terminalCandidateId: string
  terminalComponentIds: string[]
  /** null when no path produced a qualifying multi-component bundle. */
  selectedCandidateId: string | null
  qualified: boolean
  /** Every compatible pair seed is retained so seed choice cannot hide an interaction. */
  evaluatedPaths: CrossSurfaceInteractionPath[]
  /** Convenience alias for the winning path's steps. */
  steps: CrossSurfaceCompositionStep[]
}

export interface CrossSurfaceSelections {
  bestSingle: CrossSurfaceBestSingleSelection | null
  naiveStack: CrossSurfaceNaiveStackSelection | null
  interactionAware: CrossSurfaceInteractionAwareSelection | null
}

export interface CrossSurfaceInteractionReport<
  TRow extends CrossSurfaceTaskRow = CrossSurfaceTaskRow,
> {
  taskIds: string[]
  componentIds: string[]
  candidateIds: string[]
  costMetrics: string[]
  /** Canonical candidate × task order; no input row is dropped. */
  rows: TRow[]
  missingAttempts: TRow[]
  invalidAttempts: TRow[]
  candidates: CrossSurfaceCandidateSummary[]
  pairwise: CrossSurfacePairwiseEntry[]
  selections: CrossSurfaceSelections
}
