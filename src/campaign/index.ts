/**
 * @experimental
 *
 * `@tangle-network/agent-eval/campaign` — measurement + improvement loop.
 *
 * `runCampaign` is the measurement primitive (a surface scored over scenarios);
 * `runImprovementLoop` is the driver-agnostic improvement loop on top of it.
 * See `docs/design/loop-taxonomy.md` for the role vocabulary (driver / worker
 * / measurement) and the dataset flywheel.
 */

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
export { type AceDriverOptions, aceDriver } from './drivers/ace'
export { type EvolutionaryDriverOptions, evolutionaryDriver } from './drivers/evolutionary'
export {
  countSentenceEdits,
  extractH2Sections,
  type GepaDriverConstraints,
  type GepaDriverOptions,
  gepaDriver,
} from './drivers/gepa'
// ── Improvement drivers ──────────────────────────────────────────────
export { type HaloDriverOptions, haloDriver } from './drivers/halo'
export { type MemoryCurationDriverOptions, memoryCurationDriver } from './drivers/memory'
export {
  type ProposePatchesArgs,
  parseSkillPatchResponse,
  type RejectedEdit,
  type SkillOptDriver,
  type SkillOptDriverOptions,
  type SkillOptEvidence,
  SkillPatchParseError,
  skillOptDriver,
} from './drivers/skill-opt'
export { type TraceAnalystDriverOptions, traceAnalystDriver } from './drivers/trace-analyst'
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
  type CompareDriversOptions,
  compareDrivers,
  type DriverComparison,
  type DriverEntry,
  type DriverPairwise,
  type DriverScore,
  gepaParetoEntry,
  gepaReflectionEntry,
  type OptimizerEntryConfig,
  skillOptEntry,
} from './presets/compare-drivers'
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
export { type RunCampaignOptions, runCampaign } from './run-campaign'
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
  ImprovementDriver,
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
  OptimizerConfig,
  ParetoParent,
  ProposeContext,
  ProposedCandidate,
  RedactionStatus,
  Scenario,
  ScenarioAggregate,
  SessionScript,
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
