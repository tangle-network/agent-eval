/**
 * TB-Repair layers: the mini-swe-agent scaffold as the Terminal-Bench-2 corpus
 * recorded it, the pinned policy that runs it forward from a container state so
 * the intervention arm and both controls are measured under one configuration,
 * and the admission pre-pass that fixes the denominator before any analyst
 * reads a row.
 */

export {
  ADMISSION_CONFIG_DEFAULTS,
  type AdmissionConfig,
  type AdmissionConfigInput,
  type AdmissionControlObservation,
  type AdmissionControlRequest,
  type AdmissionControlRunner,
  type AdmissionDivergence,
  type AdmissionEndStateOracle,
  type AdmissionOutcome,
  type AdmissionPrefixReplay,
  type AdmissionPrefixReplayer,
  type AdmissionProvenance,
  type AdmissionReport,
  type AdmissionTestVerdict,
  admittedCount,
  admittedRowIds,
  assertDenominatorIntact,
  type DenominatorIntactInput,
  noOpInjectionStep,
  type RunAdmissionOptions,
  resolveAdmissionConfig,
  runAdmission,
} from './admission'

export {
  ADMISSION_EXCLUSION_MEANING,
  ADMISSION_EXCLUSION_ORDER,
  ADMISSION_ROW_KEYS,
  ADMISSION_STRATA,
  type AdmissionCheckRecord,
  type AdmissionControlArm,
  AdmissionDenominatorError,
  type AdmissionExclusionReason,
  AdmissionIndependenceError,
  type AdmissionNoOpInjection,
  type AdmissionRolloutSummary,
  type AdmissionRow,
  type AdmissionRowVerdict,
  type AdmissionStratum,
  assertAnalystIndependent,
  assertChainReconciles,
  buildDenominatorChain,
  type DenominatorChain,
  type DenominatorChainArtifact,
  type DenominatorStage,
  isPreStratumReason,
  stratumOf,
} from './admission-records'

export {
  type AdmissionArtifact,
  admissionArtifact,
  type RenderAdmissionOptions,
  renderAdmissionReport,
} from './admission-report'

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
