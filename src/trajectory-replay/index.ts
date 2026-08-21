/**
 * Trajectory replay — re-execute a recorded shell trajectory and produce a
 * verdict about what really happened.
 *
 * The primitive: replay steps 1..k-1 of a recorded trajectory inside the image
 * it ran in, execute step k, and compare the result against what the recording
 * says happened. That turns a claim about a run into an executed verdict, and
 * it needs no running agent loop — only a recording, an image, and a way to
 * run a command. Layers, bottom up:
 *
 *   steps            the recorded step and its observation grammar
 *   exec             the execution boundary (backend, factory, sh wrapping)
 *   verify           one case: prefix replay + arm A (+ arm B) → ReplayVerdict
 *   corpus           labeled corpora → replayable cases and exclusion reasons
 *   image-preparer   derive a replay-ready image from a recorded one
 *   fix / fix-loop   generate and iterate arm-B corrections
 *   batch            every replayable case → replayability + fix-flip rates
 *   wire / findings  one analyst finding → an executed, receipted proof
 *
 * The execution backend is always injected: this package never depends on a
 * sandbox client, a container runtime, or a model provider.
 */

export {
  type ReplayBatchCaseRow,
  type ReplayBatchFixResult,
  type ReplayBatchOptions,
  type ReplayBatchReport,
  renderBatchReport,
  runReplayBatch,
  seededSample,
} from './batch'
export {
  type CaseResources,
  type CorpusSpec,
  type CwdSource,
  type EnumerationResult,
  type ExcludedCase,
  enumerateReplayableCases,
  goldIncorrectSteps,
  parseCorpusFlag,
  type ReplayableCase,
  type ReplayExclusionReason,
  type ResourceResolution,
  readLabelEntries,
  resolveCaseResources,
} from './corpus'
export {
  type ReplayExecBackend,
  type ReplayExecBackendFactory,
  type ReplayExecResult,
  type ReplayExecSession,
  wrapActionForExec,
} from './exec'
export {
  classifyVerdict,
  type FindingReplayability,
  type FindingReplaySource,
  type FindingVerification,
  type FindingVerificationStatus,
  findingReplayStep,
  findingTrajectoryId,
  type ResolvedFindingReplay,
  readFindingsFile,
  renderVerifiedFindingsSection,
  resolveFindingReplayability,
  type VerifiableFinding,
  type VerifyFindingsOptions,
  type VerifyFindingsRun,
  verifyFindings,
} from './findings'
export {
  buildFixPrompt,
  buildRetryFixPrompt,
  type ChatCompletionCaller,
  type ChatOutcome,
  type ChatUsage,
  clipText,
  countScriptCommands,
  extractFixCommand,
  type FailedFixAttempt,
  type FixGenerationOutcome,
  type FixPromptInput,
  generateFixCommand,
} from './fix'
export {
  type FixArmExecution,
  type FixArmExecutor,
  type FixLoopAttemptRecord,
  type FixLoopOptions,
  type FixLoopResult,
  runFixLoop,
} from './fix-loop'
export {
  type DockerImagePreparerOptions,
  derivedImageTag,
  dockerImagePreparer,
  type ImagePreparation,
  type ImagePreparer,
} from './image-preparer'
export {
  assertReplayableTrajectory,
  classifyObservation,
  type DecodedTrajectory,
  decodeRecordedTurns,
  deriveFailureSignature,
  FORMAT_ERROR_OBSERVATION_PREFIX,
  finalRecordedOutcome,
  isElidedField,
  isRecordedTimeout,
  isSubmitAction,
  isSubmitOnlyAction,
  parseObservationOutput,
  parseRecordedReturncode,
  type RecordedFinalOutcome,
  type RecordedObservationKind,
  type RecordedTrajectoryStep,
  type RecordedTrajectoryTurn,
  SUBMIT_ACTION_SIGNATURE,
  TIMEOUT_OBSERVATION_MARKER,
  unreadableExitCount,
} from './steps'
export {
  type ArmExecutionResult,
  classifyPrefixStep,
  type IngestedTrajectory,
  ingestRecordedTrajectory,
  PREFIX_DIVERGENCE_TOLERANCE_PCT,
  type PrefixDivergence,
  type PrefixDivergenceKind,
  type PrefixReplayResult,
  type ReplayArmVerdict,
  type ReplayVerdict,
  type ReplayVerifyOptions,
  replayVerify,
  SandboxCounterfactualRunner,
  type SandboxCounterfactualRunnerOptions,
  summarizePrefixReplay,
} from './verify'
export {
  type AnalystReplayFinding,
  type IncorrectStepsSubject,
  parseIncorrectStepsSubject,
  type ReplayFindingOptions,
  type ReplayFindingResult,
  type ResolvedReplayInvocation,
  replayVerifyFinding,
  resolveFindingInvocation,
} from './wire'
