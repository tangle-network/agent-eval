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
export type { SeriesDistribution } from '../statistics'
// ── The search kernel: policies, allocation, executor and proposer ports ──
export { type SearchAllocator, type SearchCellPlan, uniform } from './allocation'
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
export {
  buildCellSchedule,
  type CellScheduleSlot,
  cellCachePath,
} from './cell-schedule'
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
// ── Per-node statistics of a search ─────────────────────────────────────
export {
  type EstimateNodeCellsInput,
  estimateNode,
  estimateNodeFromCells,
  type NodePosterior,
  SEARCH_ESTIMATOR,
  type SearchPosterior,
  searchCellSetDigest,
  searchPosterior,
} from './estimate-node'
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
export type { FinalEvidencePolicy, FinalEvidenceUse } from './final-evidence'
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
export {
  externalSurface,
  type GepaEvaluationImport,
  type GepaPopulationImport,
  importExternalEvaluations,
  importGepaPopulation,
  recordGepaSearch,
} from './gepa-search-import'
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
export {
  scopedOptimizationMethod,
  sequentialOptimizationMethod,
} from './optimization-method-composition'
export type {
  OpenAICompatibleOptimizerModel,
  OptimizerModelBudget,
} from './optimizer-model'
// ── Presets (the documented public surface) ──────────────────────────
export {
  type CompareOptimizationMethodsOptions,
  type ComparisonCost,
  combineComparisonCosts,
  compareOptimizationMethods,
  costFromLedgerSummary,
  type OptimizationMethod,
  type OptimizationMethodComparison,
  type OptimizationMethodComposition,
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
} from './score-utils'
// ── Compact proof over a search ledger ─────────────────────────────────
export {
  assertCompleteSearchHistory,
  assertSearchHistoryMatchesState,
  type CreateSearchHistoryReceiptInput,
  createSearchHistoryReceipt,
  type SearchHistoryAdmissionOptions,
  type SearchHistoryAuditSummary,
  type SearchHistoryCoverage,
  type SearchHistoryCoverageRow,
  type SearchHistoryPolicy,
  type SearchHistoryReceipt,
  SearchHistoryRequiredError,
  searchHistoryCoverageRow,
  verifySearchHistoryArtifact,
  verifySearchHistoryReceipt,
} from './search-history-receipt'
export {
  type RunSearchOptions,
  runSearch,
  SEARCH_KERNEL_SOURCE,
  type SearchArtifactCodec,
  type SearchCellResult,
  type SearchCellWork,
  type SearchExecutor,
  type SearchLane,
  type SearchProposalBlob,
  type SearchProposalRequest,
  type SearchProposalResult,
  type SearchProposedChild,
  type SearchProposerPort,
  type SearchRunResult,
  searchExpansionIndex,
  searchPolicyView,
} from './search-kernel'
// ── Search ledger: nodes, edges and cells of one search ────────────────
export {
  FileSearchLedger,
  type NodeEstimate,
  type OpenSearchLedgerOptions,
  openSearchLedger,
  parseSearchLedgerLine,
  replaySearchLedgerText,
  SEARCH_LEDGER_SCHEMA,
  type SearchArtifactKind,
  type SearchArtifactRef,
  type SearchAttemptAccounting,
  type SearchAudit,
  type SearchBudget,
  type SearchCancelReason,
  type SearchCandidateSurface,
  type SearchCellAllocatedEvent,
  type SearchCellCancelledEvent,
  type SearchCellSettledEvent,
  type SearchCellStage,
  type SearchClaim,
  type SearchClaimPower,
  type SearchClosedEvent,
  type SearchCloseReason,
  type SearchCostAccounting,
  type SearchEdgeAttribution,
  type SearchEdgeOperator,
  type SearchEdgeRecordedEvent,
  type SearchEstimateMethod,
  type SearchExecutionIdentity,
  type SearchFailureReason,
  type SearchLedger,
  type SearchLedgerAppendResult,
  SearchLedgerConflictError,
  type SearchLedgerEntry,
  SearchLedgerError,
  type SearchLedgerEvent,
  type SearchLedgerHash,
  SearchLedgerIntegrityError,
  type SearchLedgerTrustedHeadMode,
  type SearchModelIdentity,
  type SearchNodeDecidedEvent,
  type SearchNodeDecision,
  type SearchNodeRef,
  type SearchNodeRegisteredEvent,
  type SearchNodeStatus,
  type SearchOpenedEvent,
  type SearchOperationKind,
  type SearchOperationRecordedEvent,
  type SearchOperationStartedEvent,
  type SearchProposer,
  type SearchProposerKind,
  type SearchReservation,
  type SearchSourceRef,
  type SearchSplit,
  type SearchSplits,
  type SearchSplitTasks,
  type SearchSurfaceEffect,
  type SearchSurfaceEvidence,
  type SearchSurfaceKind,
  type SearchTask,
  type SearchTaskOutcome,
  type SearchTokenAccounting,
  type SearchTraceRef,
  type SearchUnknown,
  validateSearchLedgerEvent,
} from './search-ledger'
export {
  type AllocateSearchCellInput,
  developmentClaim,
  type RecordSearchEdgeInput,
  type RegisterSearchNodeInput,
  type SearchLedgerBinding,
  type SearchOpening,
  SearchRecorder,
  type SearchRecorderOptions,
  type SearchRunIdentity,
  type SettleSearchCellInput,
  searchEdgeId,
  surfaceDiff,
  surfaceNode,
} from './search-ledger-recording'
export {
  crowdedFrontierParent,
  incumbent,
  type SearchExpansion,
  type SearchPolicy,
  type SearchPolicyView,
} from './search-policy'
export {
  type SearchCell,
  type SearchCompletion,
  type SearchDecisionRecord,
  type SearchNode,
  type SearchOperation,
  type SearchScoredCell,
  type SearchSpend,
  SearchState,
  SearchStateView,
  type SearchUnitScore,
  searchCellId,
  searchNodeId,
  searchTaskSetDigest,
  searchUnitScores,
} from './search-state'
// ── The agent's view: renderSearchSummary and the train-only proposer view ─
export {
  renderSearchSummary,
  type SearchProposerView,
  type SearchSummaryOptions,
  searchProposerView,
} from './search-summary'
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
  surfaceDispatchRef,
  surfaceHash,
} from './surface-identity'
export {
  isTransientTransportFailure,
  quotaExhaustedUntil,
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
