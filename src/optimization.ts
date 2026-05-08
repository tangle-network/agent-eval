export { runEvalCampaign } from './eval-campaign'
export type {
  CampaignFactoryParams,
  CampaignIntegrityPolicy,
  CampaignRunContext,
  CampaignRunner,
  CampaignRunOutcome,
  CampaignScenario,
  CampaignVariant,
  EvalCampaignOptions,
  EvalCampaignResult,
  FailedRun,
} from './eval-campaign'

export {
  defaultMultiShotObjectives,
  runMultiShotOptimization,
  trialTraceFromMultiShotTrial,
} from './multi-shot-optimization'
export type {
  ActionableSideInfo,
  AsiSeverity,
  MultiShotGateConfig,
  MultiShotGateResult,
  MultiShotMutateAdapter,
  MultiShotOptimizationConfig,
  MultiShotOptimizationResult,
  MultiShotRun,
  MultiShotRunInput,
  MultiShotRunner,
  MultiShotScore,
  MultiShotScorer,
  MultiShotSplit,
  MultiShotTrace,
  MultiShotTrialResult,
  MultiShotVariant,
} from './multi-shot-optimization'

export {
  runPromptEvolution,
  InMemoryTrialCache,
} from './prompt-evolution'
export type {
  EvolvableVariant,
  GenerationReport,
  MutateAdapter,
  PromptEvolutionConfig,
  PromptEvolutionEvent,
  PromptEvolutionResult,
  ScenarioAggregate,
  ScoreAdapter,
  TrialCache,
  TrialResult,
  VariantAggregate,
} from './prompt-evolution'

export {
  buildReflectionPrompt,
  DEFAULT_MUTATION_PRIMITIVES,
  parseReflectionResponse,
} from './reflective-mutation'
export type {
  ReflectionContext,
  ReflectionProposal,
  TrialTrace,
} from './reflective-mutation'

export {
  CallbackResearcher,
  NoopResearcher,
} from './researcher'
export type {
  CallbackResearcherOptions,
  ExperimentPlan,
  ExperimentResult,
  FailureMode,
  Researcher,
  SteeringChange,
} from './researcher'

export {
  FileSystemFeedbackTrajectoryStore,
  InMemoryFeedbackTrajectoryStore,
  assignFeedbackSplit,
  controlRunToFeedbackTrajectory,
  createFeedbackTrajectory,
  feedbackTrajectoriesToDatasetScenarios,
  feedbackTrajectoriesToOptimizerRows,
  feedbackTrajectoryToDatasetScenario,
  feedbackTrajectoryToOptimizerRow,
  parseFeedbackTrajectoriesJsonl,
  replayFeedbackTrajectories,
  replayFeedbackTrajectory,
  renderPreferenceMemoryMarkdown,
  serializeFeedbackTrajectoriesJsonl,
  summarizePreferenceMemory,
  withAssignedFeedbackSplit,
} from './feedback-trajectory'
export type {
  FeedbackArtifactType,
  FeedbackAttempt,
  FeedbackLabel,
  FeedbackLabelKind,
  FeedbackLabelSource,
  FeedbackOptimizerRow,
  FeedbackOutcome,
  FeedbackReplayAdapter,
  FeedbackReplayResult,
  FeedbackSeverity,
  FeedbackSplitPolicy,
  FeedbackTask,
  FeedbackTrajectory,
  FeedbackTrajectoryFilter,
  FeedbackTrajectoryStore,
  PreferenceMemoryEntry,
  ProposedSideEffect,
} from './feedback-trajectory'
