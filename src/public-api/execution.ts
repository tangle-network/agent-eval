// ── engine ────────────────────────────────────────────────────────────
// Running evals: the campaign engine, rollout minting, execution
// drivers, and experiment bookkeeping.

export type { ActiveLearningOptions, SynthesisTarget } from '../active-learning'
export { proposeSynthesisTargets } from '../active-learning'

export type { BoundedProcessInput, BoundedProcessResult } from '../bounded-process'
export { DEFAULT_BOUNDED_PROCESS_TIMEOUT_MS, runBoundedProcess } from '../bounded-process'

export type {
  CampaignCellFailureReceipt,
  CampaignCellRetryPolicy,
  RunCampaignOptions,
} from '../campaign/run-campaign'
export { runCampaign } from '../campaign/run-campaign'
export { quotaExhaustedUntil, transientDispatchFailure } from '../campaign/transient-failure'

export type { CampaignResult } from '../campaign/types'

export { ProductClient } from '../client'

export type { CommandRunner, DirEntry, RunCommandInput, RunCommandResult } from '../command-runner'
export { LOCAL_COMMAND_RUNNER_DEFAULT_CAP_MS, localCommandRunner } from '../command-runner'

export type {
  ControlActionOutcome,
  ControlBudget,
  ControlContext,
  ControlDecision,
  ControlEvalResult,
  ControlRunResult,
  ControlRuntimeConfig,
  ControlRuntimeError,
  ControlStep,
  StopDecision,
} from '../control-runtime'
export { objectiveEval, runAgentControlLoop, subjectiveEval } from '../control-runtime'

export type { DiscoveredPersona, DiscoverPersonasOptions } from '../discover-personas'
export { discoverPersonas } from '../discover-personas'

export type {
  CampaignFactoryParams,
  CampaignIntegrityPolicy,
  CampaignRunContext,
  CampaignRunOutcome,
  CampaignScenario,
  CampaignVariant,
  EvalCampaignOptions,
  EvalCampaignResult,
  FailedRun,
} from '../eval-campaign'
export { runEvalCampaign } from '../eval-campaign'

export type {
  ExperimentRep,
  ExperimentStats,
  ImprovementThresholds,
  ImprovementVerdictResult,
} from '../improvement-verdict'
export { improvementVerdict } from '../improvement-verdict'

export { hashJson, manifestContentDigest } from '../pre-registration'

export type {
  LlmReviewerConfig,
  ProposeFn,
  ProposeInput,
  ProposeOutput,
  ProposeReviewConfig,
  ProposeReviewReport,
  Review,
  ReviewFn,
  ReviewInput,
  ReviewMemoryEntry,
  ReviewMemoryStore,
  Verification,
  VerifyFn,
} from '../propose-review'
export {
  createLlmReviewer,
  inMemoryReviewStore,
  jsonlReviewStore,
  runProposeReview,
} from '../propose-review'
export type {
  ProposeReviewControlAction,
  ProposeReviewControlConfig,
  ProposeReviewControlResult,
  ProposeReviewControlState,
} from '../propose-review-control'
export { runProposeReviewAsControlLoop } from '../propose-review-control'

export type { ReflectionContext, ReflectionProposal, TrialTrace } from '../reflective-mutation'
export { buildReflectionPrompt, parseReflectionResponse } from '../reflective-mutation'

export type {
  ExperimentPlan,
  ExperimentResult,
  FailureMode,
  Researcher,
  SteeringChange,
} from '../researcher'

export type {
  MintedRolloutLine,
  MintRolloutOptions,
  MintRolloutResult,
  RolloutSearchLineage,
  ScorePreference,
} from '../rollout/index'
export { mintRolloutRows } from '../rollout/index'

export type {
  InterimReleaseConfidence,
  InterimReleaseConfidenceInput,
  PairedEvalueOptions,
  PairedEvalueSequence,
  PairedEvalueStep,
  SequentialDecision,
} from '../sequential'
export { evaluateInterimReleaseConfidence, pairedEvalueSequence } from '../sequential'
