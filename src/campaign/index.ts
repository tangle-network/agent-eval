/**
 * `@tangle-network/agent-eval/campaign` — measurement + improvement loop.
 *
 * `runCampaign` is the measurement primitive (a surface scored over scenarios);
 * `runImprovementLoop` is the proposer-agnostic improvement loop on top of it.
 */

export {
  makeProposalFinding,
  type ProposalFinding,
  type ProposalFindingOrigin,
} from '../analyst/types'
export type { CostLedgerHandle, PendingCostCallView } from '../cost-ledger'
// ── Judge builders (single-call bridge to a canonical JudgeConfig) ────
export type { LlmJudgeDimension, LlmJudgeOptions } from '../llm-judge'
export { llmJudge } from '../llm-judge'
export type {
  ReferenceEquivalenceJudgeOptions,
  ReferenceEquivalenceScenario,
} from '../reference-equivalence-judge'
export { createReferenceEquivalenceJudge } from '../reference-equivalence-judge'
// ── Meta-loop: optimize the analyst's OWN prompt as a surface ─────────
export {
  type BuildTraceAnalystSurfaceDispatchOptions,
  buildTraceAnalystSurfaceDispatch,
  type TraceAnalystArtifact,
  type TraceAnalystScenario,
  traceAnalystQualityJudge,
} from './analyst-surface'
// ── Auto-PR ──────────────────────────────────────────────────────────
export {
  type OpenAutoPrOptions,
  type OpenAutoPrResult,
  openAutoPr,
} from './auto-pr'
export {
  type CacheIssueReason,
  type CacheRead,
  readCachedCell,
} from './cell-cache'
export { cellCachePath } from './cell-schedule'
export {
  assertCampaignDesign,
  assertCampaignSplitIdentity,
  campaignScenarioIdentity,
  campaignSplitDigest,
  campaignSplitDigestFromIdentities,
} from './coverage'
// ── Cross-surface interaction matrix + frozen bundle selection ──────
export { analyzeCrossSurfaceInteractions } from './cross-surface-interaction'
export type {
  AnalyzeCrossSurfaceInteractionsInput,
  CrossSurfaceAdditionDecision,
  CrossSurfaceAdditionRejectionReason,
  CrossSurfaceAttemptCompleteness,
  CrossSurfaceBestSingleSelection,
  CrossSurfaceBootstrapPolicy,
  CrossSurfaceCandidate,
  CrossSurfaceCandidateComparison,
  CrossSurfaceCandidateEvidence,
  CrossSurfaceCandidateOutcome,
  CrossSurfaceCandidateSummary,
  CrossSurfaceComponent,
  CrossSurfaceComponentEvidence,
  CrossSurfaceCompositionStep,
  CrossSurfaceDistribution,
  CrossSurfaceEligibility,
  CrossSurfaceEvidenceBreakdown,
  CrossSurfaceIneligibilityReason,
  CrossSurfaceInteractionAwareSelection,
  CrossSurfaceInteractionEffect,
  CrossSurfaceInteractionPath,
  CrossSurfaceInteractionReport,
  CrossSurfaceInteractionTask,
  CrossSurfaceNaiveStackSelection,
  CrossSurfacePairCompatibility,
  CrossSurfacePairEvidence,
  CrossSurfacePairIncompatibilityReason,
  CrossSurfacePairwiseEntry,
  CrossSurfaceRankedSingle,
  CrossSurfaceRelativeCost,
  CrossSurfaceSelectionPolicy,
  CrossSurfaceSelections,
  CrossSurfaceTaskRow,
} from './cross-surface-types'
export type {
  ExternalOptimizerExecutionSummary,
  ExternalOptimizerObservationArtifact,
  ExternalOptimizerObservationSummary,
  ExternalOptimizerSubmittedCandidate,
} from './external-optimizer-observations'
export { readExternalOptimizerObservationArtifact } from './external-optimizer-observations'
export type {
  ExternalOptimizerCallbackLimits,
  ExternalOptimizerChatRequest,
  ExternalOptimizerEndpointFormat,
  ExternalOptimizerEvaluationObservation,
  ExternalOptimizerEvaluationRefusalReason,
  ExternalOptimizerModelBudget,
  ExternalOptimizerModelCall,
  ExternalOptimizerModelCallRequest,
  ExternalOptimizerModelCallResult,
  ExternalOptimizerModelExecutionObservation,
  ExternalOptimizerProcessLimits,
  ExternalOptimizerRunnerCommand,
  ExternalTextCandidate,
} from './external-optimizer-process'
export {
  DEFAULT_EXTERNAL_OPTIMIZER_CALLBACK_LIMITS,
  DEFAULT_EXTERNAL_OPTIMIZER_PROCESS_LIMITS,
  resolveExternalOptimizerCallbackLimits,
  resolveExternalOptimizerProcessLimits,
} from './external-optimizer-process'
export { decodeExternalTextCandidate } from './external-text-evaluation'
export {
  type ExternalOptimizationExample,
  type ExternalTextEvaluationResponse,
  type ExternalTextOptimizationMethodConfig,
  type ExternalTextOptimizerContext,
  type ExternalTextOptimizerResult,
  externalTextOptimizationMethod,
} from './external-text-optimization'
// ── Fixture UX / dry-run planning ────────────────────────────────────
export {
  discoverEvalFixtures,
  type EvalFixture,
  type EvalFixtureFile,
  type EvalFixtureLoadOptions,
  type EvalFixtureRunPlan,
  type EvalFixtureScenario,
  type EvalFixtureValidationMode,
  type LoadEvalFixtureScenariosOptions,
  loadEvalFixture,
  loadEvalFixtureScenarios,
  type PlanEvalFixtureRunOptions,
  planEvalFixtureRun,
} from './fixtures'
// ── Gates ────────────────────────────────────────────────────────────
export { composeGate } from './gates/compose'
export {
  type DefaultProductionGateCheck,
  type DefaultProductionGateOptions,
  type DefaultProductionRewardHackingOptions,
  defaultProductionGate,
} from './gates/default-production-gate'
export { type HeldOutGateOptions, heldOutGate } from './gates/heldout-gate'
export {
  type NeutralizationGateOptions,
  neutralizationGate,
} from './gates/neutralization-gate'
export {
  type PowerPreflight,
  type PowerPreflightOptions,
  powerPreflight,
} from './gates/power-preflight'
export {
  type AxisEvidence,
  type AxisVerdict,
  type BuildEvidenceVectorOptions,
  buildEvidenceVector,
  type EvidenceVector,
  type ObjectiveSource,
  type ParetoSignificanceGateOptions,
  type PromotionObjective,
  type PromotionPolicy,
  paretoPolicy,
  paretoSignificanceGate,
} from './gates/promotion-policy'
export {
  type SequentialDecideFn,
  type SequentialDecideOptions,
  type SequentialDecision,
  type SequentialObservation,
  type SequentialPairedGate,
  type SequentialPairedGateOptions,
  type SequentialStreamState,
  sequentialDecide,
  sequentialPairedGate,
} from './gates/sequential'
export {
  type DimensionRegression,
  detectScale,
  dimensionRegressions,
  type HeldoutSignificance,
  type HeldoutSignificanceOptions,
  heldoutSignificance,
  type PairedHoldout,
  pairHoldout,
} from './gates/statistical-heldout'
export type {
  GepaCandidatePopulationArtifact,
  GepaCandidatePopulationCandidate,
  GepaCandidatePopulationSummary,
  GepaCandidateSelectionScore,
} from './gepa-candidate-population'
export { readGepaCandidatePopulationArtifact } from './gepa-candidate-population'
export {
  type GepaAdaptiveEngineRun,
  type GepaEngineOptions,
  type GepaEngineRun,
  type GepaOptimizationMethodConfig,
  type GepaOptimizationRecipe,
  type GepaRunnerCommand,
  gepaOptimizationMethod,
} from './gepa-optimization-method'
// ── Grounded reflection + run hygiene (lifted from agent-lab R357/R358) ──
export {
  classifyUngroundedLiterals,
  type RolloutArgumentDiff,
  type RolloutArgumentDiffOptions,
  type RolloutCall,
  rolloutArgumentDiff,
  type ScoredRollout,
  type UngroundedLiteralReport,
} from './grounded-reflection'
export {
  FsLabeledScenarioStore,
  type FsLabeledScenarioStoreOptions,
  LabeledScenarioStoreError,
} from './labeled-store/fs-adapter'
export { neutralizeText } from './neutralize'
export type {
  OpenAICompatibleOptimizerModel,
  OptimizerModelBudget,
} from './optimizer-model'
export {
  type CrowdedFrontierParentOptions,
  crowdedFrontierParent,
  type ParentSelectionContext,
  type ParentSelector,
} from './parent-selection'
// ── Presets (the documented public surface) ──────────────────────────
export {
  type CompareOptimizationMethodsOptions,
  type ComparisonCost,
  combineComparisonCosts,
  compareOptimizationMethods,
  costFromLedgerSummary,
  type OptimizationMethod,
  type OptimizationMethodComparison,
  type OptimizationMethodInput,
  type OptimizationMethodPairwise,
  type OptimizationMethodProvenance,
  type OptimizationMethodResult,
  type OptimizationMethodRunOptions,
  type OptimizationMethodScore,
  type OptimizationPackageSource,
  type OptimizationTokenUsage,
  optimizationTokenUsageFromSummary,
} from './presets/compare-optimization-methods'
export {
  makePlaybackDispatch,
  type PlaybackContext,
  type PlaybackDriver,
  type PlaybackStep,
  renderScoreboardMarkdown,
  type ScoreboardRenderOptions,
  type ScoreboardRow,
  type ScoreboardSummary,
  scoreboardSummary,
  scoreUserStory,
  type UserStory,
  type UserStoryVerdict,
  userStoryScoreboard,
} from './presets/playback'
export { type RunEvalOptions, runEval } from './presets/run-eval'
export {
  type RunImprovementLoopOptions,
  type RunImprovementLoopResult,
  runImprovementLoop,
} from './presets/run-improvement-loop'
export {
  type PremeasuredOptimizationBaseline,
  type RunOptimizationOptions,
  type RunOptimizationResult,
  runOptimization,
} from './presets/run-optimization'
export {
  type ProfileDispatchFn,
  ProfileMatrixError,
  type ProfileSummary,
  type RunProfileMatrixOptions,
  type RunProfileMatrixResult,
  runProfileMatrix,
  type ScenarioRollup,
} from './presets/run-profile-matrix'
export {
  type CreateProfileMatrixPlanOptions,
  createProfileMatrixPlan,
  type FinalizedProfileMatrixResult,
  type FinalizeProfileMatrixOptions,
  finalizeProfileMatrix,
  type ProfileMatrixCoverage,
  type ProfileMatrixPlan,
  type ProfileMatrixRow,
  type ProfileMatrixSegmentResult,
  type RunProfileMatrixSegmentOptions,
  runProfileMatrixSegment,
} from './presets/segmented-profile-matrix'
export {
  type JsonPolicyEditTargetSurface,
  type LlmPolicyEditProposerOptions,
  llmPolicyEditProposer,
  type PolicyEditHistoryProjectionOptions,
  projectPolicyEditHistory,
} from './proposers/llm-policy-edit'
export { type PolicyEditProposerOptions, policyEditProposer } from './proposers/policy-edit'
// ── Loop provenance (durable record + OTLP spans) ────────────────────
export {
  type BuildLoopProvenanceArgs,
  buildLoopProvenanceRecord,
  campaignMeasurementDigest,
  canonicalDigest,
  type EmitLoopProvenanceArgs,
  type EmitLoopProvenanceResult,
  emitLoopProvenance,
  type LoopProvenanceArgsFromResult,
  type LoopProvenanceBackend,
  type LoopProvenanceCandidate,
  type LoopProvenanceEvidence,
  type LoopProvenanceOptimizationMethod,
  type LoopProvenanceRecord,
  loopProvenanceArgsFromResult,
  loopProvenanceSpans,
  provenanceRecordPath,
  provenanceSpansPath,
  verifyLoopProvenanceRecord,
} from './provenance'
export {
  type CampaignCellFailureReceipt,
  type CampaignCellRetryPolicy,
  type CampaignRunPlan,
  type CampaignRunPlanCell,
  type PlanCampaignRunOptions,
  planCampaignRun,
  type RunCampaignOptions,
  runCampaign,
} from './run-campaign'
export { resolveRunDir, tangleTracesRoot } from './run-dir.js'
// ── Discriminative holdout selection (drop saturated ties) ───────────
export {
  type DiscriminationScore,
  type ScenarioSignal,
  scoreDiscrimination,
  selectDiscriminative,
} from './scenario-selection'
export {
  type CampaignBreakdown,
  campaignBreakdown,
  campaignMeanComposite,
  compareRankKeys,
} from './score-utils'
// ── Compact proof over the canonical improvement-search ledger ───────
export {
  assertCompleteSearchHistory,
  assertSearchHistoryMatchesReplay,
  type CreateSearchHistoryReceiptInput,
  createSearchHistoryReceipt,
  type SearchHistoryAuditSummary,
  type SearchHistoryCoverage,
  type SearchHistoryCoverageRow,
  type SearchHistoryPolicy,
  type SearchHistoryReceipt,
  SearchHistoryRequiredError,
  searchHistoryCoverageRow,
  verifySearchHistoryReceipt,
} from './search-history-receipt'
// ── Durable improvement-search audit log ────────────────────────────
export {
  FileSearchLedger,
  type OpenSearchLedgerOptions,
  openSearchLedger,
  type SearchAccountingAudit,
  type SearchArtifactRef,
  type SearchAttemptAccounting,
  type SearchCandidateDecidedEvent,
  type SearchCandidateLineage,
  type SearchCandidateRegisteredEvent,
  type SearchCandidateSlot,
  type SearchCandidateSlotClosedEvent,
  type SearchCandidateSurface,
  type SearchCompletedEvent,
  type SearchCostAccounting,
  type SearchFailureReason,
  type SearchLedger,
  type SearchLedgerAppendResult,
  SearchLedgerConflictError,
  type SearchLedgerEntry,
  SearchLedgerError,
  type SearchLedgerEvent,
  type SearchLedgerHash,
  SearchLedgerIntegrityError,
  type SearchLedgerReplay,
  type SearchLedgerTrustedHeadMode,
  type SearchModelIdentity,
  type SearchOperationKind,
  type SearchOperationRecordedEvent,
  type SearchPlan,
  type SearchPlanExtendedEvent,
  type SearchPlannedEvent,
  type SearchPlannedOperation,
  type SearchPlannedTask,
  type SearchSourceRef,
  type SearchSurfaceEffect,
  type SearchSurfaceEvidence,
  type SearchSurfaceKind,
  type SearchTaskAttemptedEvent,
  type SearchTaskOutcome,
  type SearchTokenAccounting,
  validateSearchLedgerEvent,
} from './search-ledger'
export {
  type MeasuredSearchCandidate,
  type ProposedSearchCandidate,
  recordCandidatePopulationSearch,
  type SearchExecutionIdentity,
  type SearchLedgerBinding,
  SearchRecorder,
  type SearchRecorderOptions,
  type SearchRunIdentity,
} from './search-ledger-recording'
export {
  acquireSingleRunLock,
  type SingleRunLock,
  type SingleRunLockOptions,
} from './single-run-lock'
export {
  type SkillOptOptimizationMethodConfig,
  type SkillOptRunnerCommand,
  type SkillOptTrainerConfig,
  skillOptOptimizationMethod,
} from './skillopt-optimization-method'
export {
  type CampaignStorage,
  createRunCostLedger,
  fsCampaignStorage,
  inMemoryCampaignStorage,
} from './storage'
// ── Code-surface content identity ────────────────────────────────────
export {
  assertCodeSurfaceIdentity,
  codeSurfaceIdentityMaterial,
  componentSurfaceIdentityMaterial,
  renderSurfaceDiff,
  surfaceContentHash,
  surfaceHash,
} from './surface-identity'
export {
  isTransientTransportFailure,
  type TransientFailureOptions,
  transientDispatchFailure,
} from './transient-failure'
export type {
  CampaignAggregates,
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignResult,
  CampaignScenarioIdentity,
  CampaignTokenUsage,
  CampaignTraceWriter,
  CodeSurface,
  ComponentSurface,
  DispatchContext,
  DispatchFn,
  Gate,
  GateCheckStatus,
  GateContext,
  GateContribution,
  GateDecision,
  GateResult,
  GenerationCandidate,
  GenerationRecord,
  JudgeAggregate,
  JudgeConfig,
  JudgeDimension,
  JudgeScore,
  LabeledScenarioRecord,
  LabeledScenarioSampleArgs,
  LabeledScenarioSource,
  LabeledScenarioStore,
  LabeledScenarioWrite,
  LabelTrust,
  MutableSurface,
  OptimizerConfig,
  ParetoParent,
  ProposalTrackContext,
  ProposeContext,
  ProposedCandidate,
  RedactionStatus,
  Scenario,
  ScenarioAggregate,
  ScoredSurfaceOutcome,
  SessionScript,
  SurfaceProposer,
  TraceSpan,
} from './types'
export { isProposedCandidate, labelTrustRank } from './types'
export type {
  AutoevalsScoreLike,
  AutoevalsScorerLike,
  PhoenixEvaluationResultLike,
  PhoenixEvaluatorLike,
} from './upstream-evaluators'
export { autoevalsScorerJudge, phoenixEvaluatorJudge } from './upstream-evaluators'
// ── Worktree adapter (VCS-pluggable; code-tier surfaces) ─────────────
export {
  type CodeSurfaceVerification,
  type GitWorktreeAdapterOptions,
  gitWorktreeAdapter,
  resolveWorktreePath,
  verifyCodeSurface,
  type Worktree,
  type WorktreeAdapter,
  WorktreeAdapterError,
} from './worktree'
