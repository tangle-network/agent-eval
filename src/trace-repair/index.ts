/**
 * TB-Repair continuation layer: the mini-swe-agent scaffold as the
 * Terminal-Bench-2 corpus recorded it, plus the pinned policy that runs it
 * forward from a container state so the intervention arm and both controls are
 * measured under one configuration.
 */

export {
  assertArmSymmetry,
  CONTINUATION_POLICY_DEFAULTS,
  type ContinuationEnvironment,
  type ContinuationEnvironmentFactory,
  type ContinuationEnvironmentRequest,
  type ContinuationExecResult,
  type ContinuationModel,
  type ContinuationModelRequest,
  type ContinuationModelResponse,
  ContinuationPolicyViolationError,
  ContinuationSymmetryError,
  continuationPolicyDigest,
  continuationSeed,
  type DefineContinuationPolicyInput,
  definePinnedContinuationPolicy,
  type PinnedContinuationPolicy,
  type RunContinuationOptions,
  runContinuation,
  totalCost,
  totalUsage,
} from './continuation-policy'

export {
  type ContinuationArm,
  type ContinuationEnvironmentDescription,
  type ContinuationExecRecord,
  type ContinuationExitStatus,
  type ContinuationMessage,
  type ContinuationModelCall,
  type ContinuationRollout,
  type ContinuationStepRecord,
  type ContinuationUsageTotals,
  type RecordedStep,
  type RecordedToolCall,
  rolloutDigest,
  rolloutRecordedSteps,
  toRecordedSteps,
} from './continuation-records'

export {
  createDockerContinuationEnvironment,
  type DockerContinuationEnvironmentOptions,
  dockerRunArgs,
  nodeProcessRunner,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from './docker-environment'

export {
  type CommandOutput,
  MINI_SWE_SYSTEM_MESSAGE,
  OUTPUT_ELISION_THRESHOLD,
  OUTPUT_ELISION_WINDOW,
  type ParsedAction,
  parseAction,
  renderFormatErrorObservation,
  renderInstanceMessage,
  renderObservation,
  renderTimeoutObservation,
  SUBMIT_SENTINEL,
  submissionOf,
} from './mini-swe-scaffold'
