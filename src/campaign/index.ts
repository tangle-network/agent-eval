export {
  callbackGovernor,
  fsLineageStore,
  type Governor,
  type GovernorContext,
  type GovernorOp,
  type HeuristicGovernorOptions,
  heuristicGovernor,
  Lineage,
  type LineageEdge,
  type LineageGraph,
  type LineageNode,
  type LineageNodeInput,
  type LineageStore,
  lineageNodeId,
  memLineageStore,
  type RunLineageOptions,
  type RunLineageResult,
  type RunLineageSeed,
  type RunLineageStepResult,
  runLineage,
} from './lineage'

/**
 * `@tangle-network/agent-eval/campaign` — measurement + improvement loop.
 *
 * `runCampaign` is the measurement primitive (a surface scored over scenarios);
 * `runImprovementLoop` is the proposer-agnostic improvement loop on top of it.
 */

// ── Surface proposers ────────────────────────────────────────────────
export {
  POLICY_EDIT_CANDIDATE_RECORD_SCHEMA,
  type PolicyEditCandidateRecord,
  validatePolicyEditCandidateRecord,
} from '../analyst/policy-edit'
export type { CostLedgerHandle } from '../cost-ledger'
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
  type AnalystArtifact,
  type AnalystScenario,
  type BuildAnalystSurfaceDispatchOptions,
  buildAnalystSurfaceDispatch,
  type FailureModeRecallJudgeOptions,
  failureModeRecallJudge,
} from './analyst-surface'
// ── Auto-PR ──────────────────────────────────────────────────────────
export {
  type OpenAutoPrOptions,
  type OpenAutoPrResult,
  openAutoPr,
} from './auto-pr'
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
  type DefaultProductionGateOptions,
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
// ── Presets (the documented public surface) ──────────────────────────
export {
  type CompareProposersOptions,
  compareProposers,
  type FapoEntryConfig,
  fapoEscalationEntry,
  gepaParetoEntry,
  gepaReflectionEntry,
  type OptimizerEntryConfig,
  type ProposerComparison,
  type ProposerEntry,
  type ProposerPairwise,
  type ProposerScore,
  skillOptEntry,
} from './presets/compare-proposers'
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
  type RunLineageLoopOptions,
  type RunLineageLoopResult,
  type RunLineageLoopSeed,
  runLineageLoop,
  type SurfaceScore,
} from './presets/run-lineage-loop'
export {
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
  type AcceptedEdit,
  type RunSkillOptOptions,
  type RunSkillOptResult,
  runSkillOpt,
  type SkillOptEpochRecord,
} from './presets/run-skill-opt'
export { type AceProposerOptions, aceProposer } from './proposers/ace'
export {
  type CompositeProposerOptions,
  compositeProposer,
} from './proposers/composite'
export { type EvolutionaryProposerOptions, evolutionaryProposer } from './proposers/evolutionary'
export {
  extractFapoAttributionSignals,
  type FapoAttributionSignals,
  type FapoFailureCluster,
  type FapoOptimizationLevel,
  type FapoProposerOptions,
  type FapoReviewInput,
  type FapoReviewIssue,
  type FapoReviewResult,
  type FapoScopeContract,
  fapoProposer,
  type JsonPrimitive,
  type JsonValue,
  type ParameterCandidate,
  type ParameterChange,
  type ParameterSweepProposerOptions,
  parameterSweepProposer,
} from './proposers/fapo'
export {
  countSentenceEdits,
  extractH2Sections,
  type GepaProposerConstraints,
  type GepaProposerOptions,
  gepaProposer,
} from './proposers/gepa'
export { type HaloProposerOptions, haloProposer } from './proposers/halo'
export {
  DEFAULT_POLICY_EDIT_HISTORY_LIMITS,
  type JsonPolicyEditTargetSurface,
  type LlmPolicyEditProposerOptions,
  llmPolicyEditProposer,
  type PolicyEditCandidateSummary,
  type PolicyEditFindingInput,
  type PolicyEditFindingSource,
  type PolicyEditHistoryCandidateContext,
  type PolicyEditHistoryGenerationContext,
  type PolicyEditHistoryProjectionOptions,
  type PolicyEditObjective,
  type PolicyEditOutcomeContext,
  projectPolicyEditHistory,
} from './proposers/llm-policy-edit'
export { type MemoryCurationProposerOptions, memoryCurationProposer } from './proposers/memory'
export {
  type PolicyEditProposerOptions,
  policyEditProposer,
} from './proposers/policy-edit'
export {
  assertPolicyEditAuthorContextBudget,
  type PolicyEditAuthorScenarioRow,
  type SelectPolicyEditAuthorRowsOptions,
  type SerializedJsonBudget,
  selectPolicyEditAuthorRows,
} from './proposers/policy-edit-author-context'
export {
  type ProposePatchesArgs,
  parseSkillPatchResponse,
  type RejectedEdit,
  type SkillOptEvidence,
  type SkillOptProposer,
  type SkillOptProposerOptions,
  SkillPatchParseError,
  skillOptProposer,
} from './proposers/skill-opt'
export { type TraceAnalystProposerOptions, traceAnalystProposer } from './proposers/trace-analyst'
// ── Loop provenance (durable record + OTLP spans) ────────────────────
export {
  type BuildLoopProvenanceArgs,
  buildLoopProvenanceRecord,
  campaignMeasurementDigest,
  type EmitLoopProvenanceArgs,
  type EmitLoopProvenanceResult,
  emitLoopProvenance,
  type LoopProvenanceArgsFromResult,
  type LoopProvenanceBackend,
  type LoopProvenanceCandidate,
  type LoopProvenanceEvidence,
  type LoopProvenanceRecord,
  loopProvenanceArgsFromResult,
  loopProvenanceSpans,
  provenanceRecordPath,
  provenanceSpansPath,
  verifyLoopProvenanceRecord,
} from './provenance'
export {
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
export { type CampaignBreakdown, campaignBreakdown, campaignMeanComposite } from './score-utils'
// ── Durable improvement-search audit log ────────────────────────────
export {
  FileSearchLedger,
  type OpenSearchLedgerOptions,
  openSearchLedger,
  SEARCH_LEDGER_SCHEMA,
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
  type SearchModelIdentity,
  type SearchOperationKind,
  type SearchOperationRecordedEvent,
  type SearchPlan,
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
  acquireSingleRunLock,
  type SingleRunLock,
  type SingleRunLockOptions,
} from './single-run-lock'
export {
  type ApplySkillPatchResult,
  applySkillPatch,
  patchEditCount,
  type SkillPatch,
  type SkillPatchOp,
  type SkillPatchRejection,
} from './skill-patch'
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
  renderSurfaceDiff,
  surfaceContentHash,
  surfaceHash,
} from './surface-identity'
export { isTransientTransportFailure, type TransientFailureOptions } from './transient-failure'
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
  DispatchContext,
  DispatchFn,
  Gate,
  GateContext,
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
  Mutator,
  OptimizationProposer,
  OptimizerConfig,
  ParetoParent,
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
