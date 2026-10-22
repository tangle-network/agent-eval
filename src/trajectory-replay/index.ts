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
  runReplayBatch,
} from './batch'
export { seededSample } from './batch-fix'
export type {
  CaseResources,
  CorpusSpec,
  CwdSource,
  EnumerationResult,
  ExcludedCase,
  ReplayableCase,
  ReplayExclusionReason,
  ResourceResolution,
} from './corpus'
export type {
  ReplayExecBackend,
  ReplayExecBackendFactory,
  ReplayExecResult,
  ReplayExecSession,
} from './exec'
export {
  classifyVerdict,
  type FindingReplayability,
  type FindingReplaySource,
  type FindingVerification,
  type FindingVerificationStatus,
  type ResolvedFindingReplay,
  type VerifiableFinding,
  type VerifyFindingsOptions,
  type VerifyFindingsRun,
  verifyFindings,
} from './findings'
export type {
  ChatCompletionCaller,
  ChatOutcome,
  ChatUsage,
  FailedFixAttempt,
  FixGenerationOutcome,
  FixPromptInput,
} from './fix'
export type {
  FixArmExecution,
  FixArmExecutor,
  FixLoopAttemptRecord,
  FixLoopOptions,
  FixLoopResult,
} from './fix-loop'
export {
  type DockerImagePreparerOptions,
  dockerImagePreparer,
  type ImagePreparation,
  type ImagePreparer,
} from './image-preparer'
export {
  classifyObservation,
  type DecodedTrajectory,
  decodeRecordedTurns,
  finalRecordedOutcome,
  type RecordedFinalOutcome,
  type RecordedObservationKind,
  type RecordedTrajectoryStep,
  type RecordedTrajectoryTurn,
} from './steps'
export {
  type ArmExecutionResult,
  type IngestedTrajectory,
  PREFIX_DIVERGENCE_TOLERANCE_PCT,
  type PrefixDivergence,
  type PrefixDivergenceKind,
  type PrefixReplayResult,
  type ReplayArmVerdict,
  type ReplayVerdict,
  type ReplayVerifyOptions,
  replayVerify,
  type SandboxCounterfactualRunnerOptions,
} from './verify'
export {
  type AnalystReplayFinding,
  type IncorrectStepsSubject,
  type ReplayFindingOptions,
  type ReplayFindingResult,
  type ResolvedReplayInvocation,
  replayVerifyFinding,
} from './wire'
