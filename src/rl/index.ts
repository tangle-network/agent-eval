/**
 * RL/data bridge.
 *
 * This subpath groups everything that turns eval output into training signal:
 * stable adapters/rewards, dataset packaging, trainer-format exporters,
 * process rewards, and closed-loop campaign research. Keeping it off the root
 * import path makes the default API smaller without hiding useful capability.
 */

/** Advanced budget allocation across (variant, scenario) cells. */
export type {
  CellObservation,
  CurriculumAllocation,
  VarianceCurriculumOptions,
} from './active-curriculum'
/** Advanced adaptation eval — does the policy actually learn from feedback? */
export * from './adaptation-eval'
/** Adversarial mutation contract consumed by the fuzz harness. */
export * from './adversarial'
export type {
  ClaimIntegrityPolicy,
  ClaimIntegritySystemOneOptions,
  ClaimIntegritySystemOneQuestions,
  ClaimIntegrityVerdict,
  FarmingOptions,
  IntegrityClaim,
  IntegrityEvidence,
  IntegritySignal,
  IntegritySignalId,
  IntegritySignalKind,
  RefereeVerdict,
  ScopeCondition,
  ScopeOperator,
  ScopeRule,
  ScopeValue,
  SourceExcerpt,
  SourceScope,
  SourceScopeRefereeAnswer,
  TrajectoryEvent,
} from './claim-integrity'
/** Claim integrity: whether a checker-verified research claim is a result about its source statement or only about the checker. */
export {
  checkerReadSignal,
  claimIntegrityDigest,
  claimIntegritySystemOneReview,
  claimIntegrityTraceQuestions,
  claimIntegrityVerdict,
  farmingSignal,
  GRADER_REFERENCE_PHRASES,
  graderReferenceSignal,
  monitorSignal,
  parseSourceScopeReferee,
  refereeSignal,
  ruleHolds,
  scopeSignals,
  sourceScopeRefereeMessages,
  systemOneSignal,
} from './claim-integrity'
export type {
  ComputeBestOfNOptions,
  ComputeBestOfNResult,
  ComputeCurve,
  ComputeCurveBudget,
  ComputeCurvePoint,
  ParetoPointInput,
  RunComputeCurveOptions,
  SelfConsistencyOptions,
  SelfConsistencyResult,
} from './compute-curves'
/** @stable Compute curves: best-of-N, self-consistency, Pareto frontier across budgets. */
export { bestOfN, paretoCostScoreFrontier } from './compute-curves'
export type {
  ContaminationProbeInput,
  ContaminationProbeOptions,
  ContaminationProbeReport,
  ScenarioPerturbation,
  ScenarioPerturbationKind,
} from './contamination'
/** @stable Held-out perturbation probes for benchmark contamination (paired Wilcoxon). */
export { runContaminationProbe } from './contamination'
export type { CorpusAppendResult, CorpusRecord, HarvestOptions } from './corpus'
/** @stable Durable corpus: every eval run appends graded trajectories by default; harvest → buildRlDataset (datasets for free). */
export { readCorpus } from './corpus'
export type {
  DatasetFormat,
  RewardKind,
  RewardStats,
  RlDatasetBundle,
  RlDatasetConfig,
  RlDatasetManifest,
  RlDatasetStats,
} from './dataset'
/** @stable Publishable/sellable dataset bundle: format exporters + provenance + a Datasheet-for-Datasets card. */
export { buildRlDataset, validateDatasetFormats } from './dataset'
export type {
  DpoExportRow,
  DpoLineContext,
  DpoLookups,
  GrpoExportRow,
  GrpoLookups,
  PrmExportRow,
  PrmLineContext,
  PrmLookups,
  RolloutLineContext,
  SftExportRow,
  SftLookups,
  StepRewardJsonlRow,
  TrainingLineSelectionOptions,
} from './exporters'
/** Trainer-format exporters (HuggingFace datasets, JSONL, parquet). */
export { toDpoRows, toGrpoRows, toPrmRows, toSftJsonl, toSftRowsWithLookups } from './exporters'
export type {
  OffPolicyContributionCounts,
  OffPolicyEstimate,
  OffPolicyOptions,
  OffPolicyTrajectory,
} from './off-policy'
/** @stable Off-policy value estimation: IPS, SNIPS, doubly-robust. */
export {
  doublyRobust,
  inverseProbabilityWeighting,
  selfNormalizedImportanceWeighting,
} from './off-policy'
/** Researcher that re-weights rubrics by deployment outcome correlation. */
export * from './predictive-validity-researcher'
/** @stable (chosen, rejected) preference triples for DPO / KTO / PPO. */
export * from './preferences'
export type {
  ExtractStepRewardsOptions,
  PrmTrainingTriple,
  RunwiseStepSummary,
  StepReward,
  StepScorer,
} from './process-reward'
/** Step-level rewards and process-reward training pairs. */
export { prmTrainingPairs } from './process-reward'
/** Reward-hacking signatures: reward divergence, distribution shift, judge drift. */
export * from './reward-hacking'
/** Closed-loop campaign runner: eval → preferences → mutate → re-eval. */
export * from './rl-campaign'
export type { AdapterContext } from './run-record-adapters'
/** @stable Canonical `RunRecord` adapters: trials → records, verification reports → records. */
export { campaignToRunRecords } from './run-record-adapters'
export type {
  BehaviorFeatures,
  EasyModeOptions,
  EasyModeReport,
  FeatureDivergence,
  FeatureShift,
  FidelityReport,
  FidelityVerdict,
  SimFidelityOptions,
} from './sim-fidelity'
/** Simulator fidelity between simulated and production RunRecords. */
export { bucketLabel } from './sim-fidelity'
export type {
  BradleyTerryFit,
  BradleyTerryRating,
  BuildPairwiseFromCampaignInput,
  EloOptions,
  PairwiseOutcome,
} from './tournament'
/** @stable Bradley-Terry MLE + online Elo for pairwise tournament ratings. */
export { buildPairwiseFromCampaign, fitBradleyTerry } from './tournament'
export type {
  VerifiableReward,
  VerifiableRewardExtractionOptions,
  VerifiableRewardSource,
} from './verifiable-reward'
/** @stable Verifiable reward extraction (compile / test / schema) with judge-noise filtering. */
export { extractVerifiableReward, extractVerifiableRewardsFromRecords } from './verifiable-reward'
export type {
  BuildVerifiedFindingRowArgs,
  CaseVerdictDetail,
  DatasetTrajectoryStep,
  FixOutcome,
  GoldLabelEntry,
  NormalizedStep,
  RecordedPrefixDivergence,
  ReplayBatchCase,
  ReplayBatchFix,
  ReplayBatchReportFile,
  VerifiedFindingFix,
  VerifiedFindingRow,
  VerifiedFindingsCorpusSource,
  VerifiedFindingsDataset,
  VerifiedFindingsSource,
  VerifiedFindingsSummary,
} from './verified-findings-dataset'
/** Execution-verified gold labels joined into RL-ready rows (replay-verify batches → trainer input). */
export { loadVerifiedFindingsDataset } from './verified-findings-dataset'

// ── Deployment-outcome store (predictive-validity calibration) ──────
// Promoted to public so external consumers don't have to inline the
// `InMemoryOutcomeStore` + `DeploymentOutcome` shapes that
// `predictive-validity-researcher` already consumes. Closes the gap
// physim's `validate-rubrics.ts` was working around by re-implementing.

/** @stable In-memory + filesystem stores for deployment outcomes;
 *  consumed by `predictive-validity-researcher` to calibrate the gate
 *  against observed downstream metrics, not just held-out judge scores. */
export {
  type DeploymentOutcome,
  FileSystemOutcomeStore,
  type FileSystemOutcomeStoreOptions,
  InMemoryOutcomeStore,
  type OutcomeStore,
} from '../meta-eval/outcome-store'
