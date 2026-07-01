/**
 * `@tangle-network/agent-eval/campaign` — measurement + improvement loop.
 *
 * `runCampaign` is the measurement primitive (a surface scored over scenarios);
 * `runImprovementLoop` is the proposer-agnostic improvement loop on top of it.
 */

// ── Judge builders (single-call bridge to a canonical JudgeConfig) ────
export type { LlmJudgeDimension, LlmJudgeOptions } from '../llm-judge'
export { llmJudge } from '../llm-judge'
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
export {
  FsLabeledScenarioStore,
  type FsLabeledScenarioStoreOptions,
  LabeledScenarioStoreError,
} from './labeled-store/fs-adapter'
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
  defaultRenderDiff,
  type RunImprovementLoopOptions,
  type RunImprovementLoopResult,
  runImprovementLoop,
} from './presets/run-improvement-loop'
export {
  type RunOptimizationOptions,
  type RunOptimizationResult,
  runOptimization,
  surfaceHash,
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
// ── Surface proposers ────────────────────────────────────────────────
export { type HaloProposerOptions, haloProposer } from './proposers/halo'
export { type MemoryCurationProposerOptions, memoryCurationProposer } from './proposers/memory'
export {
  type PolicyEditProposerOptions,
  policyEditProposer,
} from './proposers/policy-edit'
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
  type EmitLoopProvenanceArgs,
  type EmitLoopProvenanceResult,
  emitLoopProvenance,
  type LoopProvenanceBackend,
  type LoopProvenanceCandidate,
  type LoopProvenanceRecord,
  loopProvenanceSpans,
  provenanceRecordPath,
  provenanceSpansPath,
  surfaceContentHash,
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
export { type CampaignBreakdown, campaignBreakdown, campaignMeanComposite } from './score-utils'
export {
  type ApplySkillPatchResult,
  applySkillPatch,
  patchEditCount,
  type SkillPatch,
  type SkillPatchOp,
  type SkillPatchRejection,
} from './skill-patch'
export { type CampaignStorage, fsCampaignStorage, inMemoryCampaignStorage } from './storage'
export type {
  CampaignAggregates,
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignResult,
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
  SessionScript,
  SurfaceProposer,
  TraceSpan,
} from './types'
export { isProposedCandidate, labelTrustRank } from './types'
// ── Worktree adapter (VCS-pluggable; code-tier surfaces) ─────────────
export {
  type GitWorktreeAdapterOptions,
  gitWorktreeAdapter,
  resolveWorktreePath,
  type Worktree,
  type WorktreeAdapter,
  WorktreeAdapterError,
} from './worktree'
