/**
 * @packageDocumentation
 *
 * Root barrel — broad compatibility surface.
 *
 * Reach for focused subpaths when they fit: `/contract`, `/campaign`,
 * `/analyst`, `/traces`, `/reporting`, `/rl`, `/prm`, `/meta-eval`,
 * `/belief-state`, `/wire`, and `/testing`.
 */

// ── Core types ───────────────────────────────────────────────────────

export type { ActionExecutionPolicy, ActionPolicyDecision } from './action-policy'
export { evaluateActionPolicy } from './action-policy'
export type {
  AgentInterfaceProfileLike,
  AgentProfileCell,
  AgentProfileCellInput,
  AgentProfileCellSchemaVersion,
  AgentProfileDimensionValue,
  AgentProfileHarness,
  AgentProfileJson,
  AgentProfileJsonObject,
  AgentProfileKind,
  AgentProfileSource,
  AgentProfileSourceInput,
} from './agent-profile-cell'
export {
  AGENT_PROFILE_KINDS,
  AgentProfileCellValidationError,
  agentProfileCellHashMaterial,
  agentProfileCellKey,
  assertRunAgentProfileCell,
  buildAgentInterfaceProfileCell,
  buildAgentProfileCell,
  groupRunsByAgentProfileCell,
  requireAgentProfileCell,
  toAgentProfileJson,
  validateAgentProfileCell,
  verifyAgentProfileCell,
} from './agent-profile-cell'
export { type CreateAnalystAiConfig, createAnalystAi } from './analyst/ax-service'
// ── Analyst (registry + findings) ─────────────────────────────────────
// Consumer-facing happy path only: build a registry (or take the default
// kinds), pass it to analyzeRuns/selfImprove, read AnalystFinding[], persist
// with FindingsStore, or bind a ChatClient for analyst LLM calls. Deeper
// machinery like finding-signature/subject parsers, tolerant JSON coercion, tool
// groups, prose recovery, and judge/verifier adapters live on the `/analyst`
// subpath (`@tangle-network/agent-eval/analyst`) to keep this surface legible.
export type {
  ChatCallOpts,
  ChatClient,
  ChatRequest,
  ChatResponse,
  ChatTransport,
  CliBridgeTransportOpts,
  CreateChatClientOpts,
  DirectProviderTransportOpts,
  MockTransportOpts,
  RouterTransportOpts,
  SandboxSdkTransportOpts,
} from './analyst/chat-client'
export { createChatClient } from './analyst/chat-client'
export {
  buildDefaultAnalystRegistry,
  type DefaultAnalystRegistryOptions,
} from './analyst/default-registry'
export type {
  CanonicalRawAnalystFinding,
  RawAnalystEvidence,
  RawAnalystFinding,
} from './analyst/finding-signature'
export type { FindingSubject, FindingSubjectKind } from './analyst/finding-subject'
export {
  type DiffPolicy,
  defaultIsMaterial,
  diffFindings,
  type FindingsDiff,
  FindingsStore,
  type PersistedFinding,
} from './analyst/findings-store'
export {
  type CreateTraceAnalystKindOpts,
  createTraceAnalystKind,
  renderPriorFindings,
  renderUpstreamFindings,
  type TraceAnalystGolden,
  type TraceAnalystKindSpec,
} from './analyst/kind-factory'
export {
  DEFAULT_TRACE_ANALYST_KINDS,
  FAILURE_MODE_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
  KNOWLEDGE_GAP_KIND_SPEC,
  KNOWLEDGE_POISONING_KIND_SPEC,
} from './analyst/kinds'
export { SKILL_USAGE_ANALYST, SkillUsageAnalyst } from './analyst/kinds/skill-usage'
export type {
  FindingToPolicyEditOptions,
  PolicyEdit,
  PolicyEditAdmission,
  PolicyEditAdmissionOptions,
  PolicyEditAxis,
  PolicyEditCandidateRecord,
  PolicyEditChange,
  PolicyEditExpectedGain,
  PolicyEditGainDirection,
  PolicyEditGainUnit,
  PolicyEditInit,
  PolicyEditRisk,
  PolicyEditSchemaVersion,
  PolicyEditSource,
  PolicyEditTarget,
  PolicyEditTargetSurface,
} from './analyst/policy-edit'
export {
  admitPolicyEdit,
  applyPolicyEditToSurface,
  computePolicyEditId,
  isPolicyEdit,
  makePolicyEdit,
  makePolicyEditCandidateRecord,
  POLICY_EDIT_AXES,
  POLICY_EDIT_CANDIDATE_RECORD_SCHEMA,
  POLICY_EDIT_TARGET_SURFACES,
  PolicyEditValidationError,
  policyEditFromFinding,
  policyEditsFromFindings,
  scorePolicyEditReadiness,
  validatePolicyEdit,
  validatePolicyEditCandidateRecord,
} from './analyst/policy-edit'
export {
  type AnalystHooks,
  AnalystRegistry,
  type AnalystRegistryOptions,
  type BudgetPolicy,
  type RegistryRunOpts,
} from './analyst/registry'
export {
  type Analyst,
  type AnalystContext,
  type AnalystCost,
  type AnalystFinding,
  type AnalystInputKind,
  type AnalystRequirements,
  type AnalystRunEvent,
  type AnalystRunInputs,
  type AnalystRunResult,
  type AnalystRunSummary,
  type AnalystSeverity,
  type AnalystUsageReceipt,
  computeFindingId,
  type EvidenceRef,
  makeFinding,
} from './analyst/types'
export type {
  AutoPrClient,
  FileChange,
  GhCliClientOptions,
  HttpGithubClientOptions,
  ProposeAutomatedPullRequestInput,
  ProposeAutomatedPullRequestResult,
  RepoRef,
} from './auto-pr'
export { ghCliClient, httpGithubClient } from './auto-pr'
export { BenchmarkRunner } from './benchmark'
export type {
  AssertCapabilityHeadroomOptions,
  CapabilityHeadroomOptions,
  CapabilityHeadroomResult,
  HeadroomClass,
  HeadroomInput,
  TaskHeadroom,
} from './capability-headroom'
// ── Capability-headroom gate (calibrate-before-measure) ─────────────
// A capability A/B can only detect the capability on tasks the
// capability-absent baseline FAILS. Classifies per-task headroom from
// baseline outcomes (fail-closed on unknowns) and guards the comparison
// behind a minimum-gap assert.
export { assertCapabilityHeadroom, capabilityHeadroom } from './capability-headroom'
// ── Client / driver / judges / executor / benchmark / registry / reporter ─
export { ProductClient, runE2EWorkflow } from './client'
export type {
  ClusterBootstrapInterval,
  ClusteredBinaryCluster,
  ClusteredMatchedPair,
  ClusteredPairedBinaryOptions,
  ClusteredPairedBinaryResult,
  ClusteredPairedBinaryStatistics,
  ClusterSignFlipAlternative,
  ClusterSignFlipResult,
} from './clustered-paired-binary'
export { clusteredPairedBinary } from './clustered-paired-binary'
export type {
  ControlActionFailureMode,
  ControlActionOutcome,
  ControlBudget,
  ControlContext,
  ControlDecision,
  ControlEvalResult,
  ControlRunResult,
  ControlRuntimeConfig,
  ControlRuntimeError,
  ControlSeverity,
  ControlStep,
  ControlStopPolicies,
  StopDecision,
} from './control-runtime'
export {
  allCriticalPassed,
  objectiveEval,
  runAgentControlLoop,
  stopOnNoProgress,
  stopOnRepeatedAction,
  subjectiveEval,
} from './control-runtime'
export type {
  DetectorEvent,
  DetectorSeverity,
  DetectorSignal,
  ErrorStreakOptions,
  NoProgressOptions,
  RepeatedActionOptions,
  StreamingDetector,
} from './detectors'
export {
  errorStreakDetector,
  noProgressDetector,
  observeAll,
  repeatedActionDetector,
} from './detectors'
export type { AgentDriverConfig, DecideNextUserTurnOpts, WorkerDriverContext } from './driver'
export {
  AgentDriver,
  buildDriverSystemPrompt,
  buildWorkerDriverSystemPrompt,
  decideNextUserTurn,
} from './driver'
export type { AgentEvalErrorCode } from './errors'
// Error taxonomy — every error this package throws as part of its public
// contract extends AgentEvalError. Pattern-match by `instanceof` or by the
// stable string `code` on the base.
export {
  AgentEvalError,
  CaptureIntegrityError,
  ConfigError,
  JudgeError,
  NotFoundError,
  ReplayError,
  ValidationError,
  VerificationError,
} from './errors'
export type { ExecutorConfig } from './executor'
export { executeScenario } from './executor'
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
export {
  assignFeedbackSplit,
  controlRunToFeedbackTrajectory,
  createFeedbackTrajectory,
  FileSystemFeedbackTrajectoryStore,
  feedbackTrajectoriesToDatasetScenarios,
  feedbackTrajectoriesToOptimizerRows,
  feedbackTrajectoryToDatasetScenario,
  feedbackTrajectoryToOptimizerRow,
  InMemoryFeedbackTrajectoryStore,
  parseFeedbackTrajectoriesJsonl,
  renderPreferenceMemoryMarkdown,
  replayFeedbackTrajectories,
  replayFeedbackTrajectory,
  serializeFeedbackTrajectoriesJsonl,
  summarizePreferenceMemory,
  withAssignedFeedbackSplit,
} from './feedback-trajectory'
// ── Backend-integrity guard ───────────────────────────────────────────
// Distinguish "agent failed" from "eval ran blind against a stub or
// unconfigured backend." Required after every canonical eval so a 0/N
// pass-rate never silently masks a misconfigured runtime.
export type { BackendIntegrityReport } from './integrity/backend-integrity'
export {
  assertRealAgentReceipts,
  assertRealBackend,
  BackendIntegrityError,
  summarizeAgentReceiptIntegrity,
  summarizeBackendIntegrity,
} from './integrity/backend-integrity'
// Pre-hoc complement to assertRealBackend: verify the campaign's models are
// served by the router BEFORE spending tokens, so a dead default surfaces as a
// config error instead of a stub run.
export {
  assertModelsServed,
  type ModelPreflight,
  ModelsUnreachableError,
  type PreflightModelsOptions,
  type PreflightOutcome,
  preflightModels,
} from './integrity/preflight'
export {
  type AssertSingleBackendOptions,
  assertSingleBackend,
  type BackendDescriptor,
  type SingleBackendDivergence,
  SingleBackendError,
  type SingleBackendField,
  type SingleBackendReport,
} from './integrity/single-backend'
// ── Judge families (cross-family enforcement) ────────────────────────
export {
  type AssertCrossFamilyOptions,
  assertCrossFamily,
  CrossFamilyError,
  type JudgeFamily,
  judgeFamily,
} from './judge-families'
export {
  adversarialJudge,
  codeExecutionJudge,
  coherenceJudge,
  createCustomJudge,
  createDomainExpertJudge,
  defaultJudges,
  JudgeParseError,
} from './judges'
export * from './knowledge'
export type {
  LiveProofArtifact,
  LiveProofConfig,
  LiveProofContext,
  LiveProofResult,
} from './live-proof'
export { runLiveProof } from './live-proof'
export {
  estimateCost,
  estimateTokens,
  isModelPriced,
  MetricsCollector,
  MODEL_PRICING,
  resolveModelPricing,
  TokenCounter,
} from './metrics'
export type {
  ComparePairedArmsOptions,
  MatchedPair,
  PairArmsOptions,
  PairArmsResult,
  PairedArmRow,
  PairedArmsComparison,
  PairedCorrectness,
  PairedMetricDelta,
} from './paired-arms'
// ── Matched-pair arm comparison ──────────────────────────────────────
// Pairs run-record-like rows across two arms by pairKey (multi-rep items
// match on repKey identity, leftovers reported) and composes the paired
// estimators from `statistics` (mcnemar + pairedRiskDifference for
// pass/fail, pairedBootstrap + wilcoxonSignedRank per metric). Arm names
// are parameters — no domain literal ships here.
export { comparePairedArms, pairArms } from './paired-arms'
export type {
  PrReviewAuditCase,
  PrReviewBenchmarkSummary,
  PrReviewComment,
  PrReviewMatchedFinding,
  PrReviewOutcome,
  PrReviewReferenceFinding,
  PrReviewScore,
  PrReviewScoreWeights,
  PrReviewSeverity,
  PrReviewSource,
} from './pr-review-benchmark'
export {
  aggregatePrReviewScore,
  commentsForSource,
  DEFAULT_PR_REVIEW_SCORE_WEIGHTS,
  scorePrReviewComments,
  scorePrReviewSource,
  summarizePrReviewBenchmark,
} from './pr-review-benchmark'
export { ScenarioRegistry } from './registry'
export { formatBenchmarkReport, formatDriverReport, printDriverSummary } from './reporter'
// ── Rollout — `tangle.rollout.v1` ────────────────────────────────────
// THE canonical rollout serialization: schema + ledger + minting from
// RunRecord × trace (joined on runId, realness-gate carried into the
// reward), harness-store readers, exporters, and the release pipeline.
// Full surface on the `@tangle-network/agent-eval/rollout` subpath.
export {
  assertRolloutLine,
  type ChatMessage,
  type ChatToolCall,
  isRolloutLine,
  isTrainableSplit,
  type MintRolloutOptions,
  type MintRolloutResult,
  mintRolloutRows,
  type RewardRow,
  ROLLOUT_FORMAT,
  ROLLOUT_SCHEMA,
  type RolloutCapture,
  type RolloutLine,
  type RolloutRole,
  type RolloutScrubber,
  type RolloutSplit,
  type RolloutStep,
  rolloutReward,
  type SftExportOptions,
  type SftRow,
  type ToolDef,
  toJsonl,
  toRewardRows,
  toSftRows,
  validateRolloutLine,
} from './rollout/index'
export type {
  ControlRunToRunRecordOptions,
  RunEvidenceMetadata,
} from './run-evidence'
export {
  controlRunToRunRecord,
  scoreFromEvals,
} from './run-evidence'
export type {
  CliffsMagnitude,
  CorpusAgreementOptions,
  CorpusAgreementPerDimension,
  CorpusAgreementReport,
  CorpusScoreRecord,
  McNemarResult,
  PairedBootstrapOptions,
  PairedBootstrapResult,
  PairedSignTestResult,
  ProportionInterval,
  RiskDifferenceResult,
  SignTestAlternative,
  WeightedCompositeInput,
  WeightedCompositeResult,
} from './statistics'
// ── Statistics ───────────────────────────────────────────────────────
export {
  benjaminiHochberg,
  bonferroni,
  cliffsDelta,
  cohensD,
  confidenceInterval,
  corpusInterRaterAgreement,
  corpusInterRaterAgreementFromJudgeScores,
  holm,
  interpretCliffs,
  interRaterReliability,
  mannWhitneyU,
  mcnemar,
  mcnemarPower,
  mcnemarRequiredN,
  normalizeScores,
  pairedBootstrap,
  pairedMde,
  pairedRiskDifference,
  pairedSignTest,
  pairedTTest,
  partialCredit,
  passAtK,
  pearsonR,
  ranks,
  requiredSampleSize,
  spearmanR,
  weightedComposite,
  weightedMean,
  wilcoxonSignedRank,
  wilson,
} from './statistics'
// ── Supervisor-run analysis ──────────────────────────────────────────
// Single-rollout trace analysis, one dimension up: a supervision tree's
// steer count, spawn waves, concurrency, idle wall, cost by role and
// accepted-vs-rejected accounting, with `Measured<T>` keeping a missing
// artifact distinct from a measured zero. Nodes are `tangle.rollout.v1`
// rows joined by `parent_rollout_id` — not a parallel shape.
// Full surface on the `@tangle-network/agent-eval/supervisor-run` subpath.
export {
  analyzeSupervisorRun,
  analyzeSupervisorRunSources,
  claudeCodeSupervisorRunReader,
  isUnavailable,
  type Measured,
  readClaudeCodeSupervisorRun,
  renderSupervisorRunHeadline,
  renderSupervisorRunMarkdown,
  rollupSupervisorRuns,
  type SourceLimits,
  SUPERVISOR_RUN_SCHEMA,
  type SupervisorRunReader,
  type SupervisorRunReport,
  type SupervisorRunRollup,
  type SupervisorRunSources,
  type SupervisorRunTree,
  showMeasured,
  supervisorRunRolloutLines,
  type Unavailable,
  writeSupervisorRunReport,
} from './supervisor-run/index'
// ── Trace analyst surface (Ax RLM over OTLP-JSONL) ───────────────────
// Direct re-export of the trace-analyst submodule so consumers don't have
// to reach into subpaths. Used by agent canonical evals via the
// `autoresearch` block (analyzeTraces + OtlpFileTraceStore).
export * from './trace-analyst'
export type {
  BehavioralMetrics,
  BehavioralTokenSequence,
  SuboptimalCode,
  SuboptimalSignal,
} from './trace-analyst/behavioral-metrics'
export { computeTraceMetrics } from './trace-analyst/behavioral-metrics'
export type {
  ToolMatcher,
  TreatmentClass,
  TreatmentGate,
  TreatmentGateInput,
  TreatmentGateOptions,
} from './treatment-gate'
// ── Treatment-applied gate (manipulation/validity precondition) ──────
// Generalized from a benchmark's search-fired check: did a tool-treatment's
// tool actually fire this run? Mirrors `gateRealness`'s pure-predicate shape;
// consumes `computeTraceMetrics(spans).toolHistogram`. The tool matcher is a
// parameter — no domain literal. Excluded runs partition onto the existing
// objective-exclusion pattern, not a new classification enum.
export {
  classifyTreatment,
  gateTreatmentApplied,
  gateTreatmentFromMetrics,
  gateTreatmentFromSpans,
  gateTreatmentFromToolSpans,
} from './treatment-gate'
export type {
  ArtifactCheck,
  ArtifactResult,
  BenchmarkReport,
  BenchmarkRunnerConfig,
  CheckResult,
  CollectedArtifacts,
  CompletionCriterion,
  DriverResult,
  DriverState,
  EvalResult,
  FeedbackPattern,
  JudgeConfig,
  JudgeFn,
  JudgeInput,
  JudgeRubric,
  JudgeScore,
  PersonaConfig,
  PersonaRigor,
  ProductClientConfig,
  RouteMap,
  RubricDimension,
  Scenario,
  ScenarioFile,
  ScenarioResult,
  TestResult,
  Turn,
  TurnMetrics,
  TurnResult,
} from './types'

// ── Core primitives ──────────────────────────────────────────────────

export type { AntiSlopConfig, AntiSlopIssue, AntiSlopReport, SlopCategory } from './anti-slop'
export { analyzeAntiSlop, createAntiSlopJudge } from './anti-slop'
export type {
  Artifact as ArtifactCheckArtifact,
  ArtifactValidator,
  ValidationContext,
  ValidationIssue,
  ValidationResult,
} from './artifact-validator'
export {
  byteLengthRange,
  composeValidators,
  containsAll,
  jsonHasKeys,
  regexMatch,
} from './artifact-validator'
export type {
  CompletionRequirement,
  CompletionVerdict,
  CorrectnessChecker,
  LlmCorrectnessCheckerOpts,
  ProducedProposal,
  ProducedState,
  RequirementCheck,
  SatisfiedBy,
  TaskGold,
} from './completion-verifier'
export {
  completionVerdict,
  createLlmCorrectnessChecker,
  createTokenRecallChecker,
  parseCorrectnessResponse,
  verifyCompletion,
} from './completion-verifier'
export { ConvergenceTracker } from './convergence'
export type {
  DualAgentBenchConfig,
  DualAgentReport,
  DualAgentRound,
  DualAgentScenario,
  DualAgentScenarioResult,
} from './dual-agent-bench'
export { DualAgentBench } from './dual-agent-bench'
export type { EvalToolDef, MakeEvalToolsConfig } from './eval-tools'
export { makeEvalTools, toOpenAiTool } from './eval-tools'
export type {
  HarnessAdapter,
  HarnessExperimentConfig,
  HarnessExperimentResult,
  HarnessIntervention,
  HarnessRunRequest,
  HarnessRunResult,
  HarnessScenario,
  HarnessSelection,
  HarnessVariant,
  HarnessVariantReport,
  MeasurementPolicy,
  WorkflowTopology,
} from './harness-optimizer'
export {
  DEFAULT_HARNESS_OBJECTIVES,
  runHarnessExperiment,
  selectHarnessVariant,
  summarizeHarnessResults,
} from './harness-optimizer'
export type { EnsembleAggregate, JudgeVerdict } from './judge-ensemble'
export { aggregateJudgeVerdicts } from './judge-ensemble'
export type { EnsembleJudgeOptions } from './judge-panel'
export { ensembleJudge } from './judge-panel'
export type {
  JudgeFleetOptions,
  SandboxJudgeKind,
  SandboxJudgeResult,
  SandboxJudgeSpec,
} from './judge-runner'
export {
  compilerJudge,
  JudgeRunner,
  linterJudge,
  runJudgeFleet,
  securityJudge,
  testJudge,
} from './judge-runner'
export type { LlmJudgeDimension, LlmJudgeOptions } from './llm-judge'
export { llmJudge } from './llm-judge'
export type { Playbook, PlaybookEntry } from './playbook'
export { distillPlaybook, renderPlaybookMarkdown } from './playbook'
export type {
  ArtifactEventLike,
  ProposalEventLike,
  RuntimeEventLike,
  ToolCallEventLike,
} from './produced-state'
export { extractProducedState } from './produced-state'
export type { PromptHandle } from './prompt-registry'
export { hashContent, PromptRegistry } from './prompt-registry'
export type {
  LlmJsonCall,
  LlmReviewerConfig,
  ProposeFn,
  ProposeInput,
  ProposeOutput,
  ProposeReviewConfig,
  ProposeReviewReport,
  ProposeReviewShot,
  Review,
  ReviewFn,
  ReviewInput,
  ReviewMemoryEntry,
  ReviewMemoryStore,
  Verification,
  VerifyFn,
} from './propose-review'
export {
  createLlmReviewer,
  inMemoryReviewStore,
  jsonlReviewStore,
  runProposeReview,
} from './propose-review'
export type {
  ProposeReviewControlAction,
  ProposeReviewControlConfig,
  ProposeReviewControlResult,
  ProposeReviewControlState,
} from './propose-review-control'
export {
  controlFailureClassFromVerification,
  runProposeReviewAsControlLoop,
} from './propose-review-control'
export type { RunCriticOptions, RunTrace } from './run-critic'
export { RunCritic } from './run-critic'
export type { RunScore, RunScoreWeights } from './run-score'
export { aggregateRunScore, clamp01, DEFAULT_RUN_SCORE_WEIGHTS } from './run-score'
export type { SteeringBundle, SteeringDelta, SteeringRolePrompt } from './steering'
export { mergeSteeringBundle, renderSteeringText } from './steering'
export type {
  AxSteeringOptimizerConfig,
  SteeringOptimizationResult,
  SteeringOptimizationRow,
  SteeringOptimizationSelector,
  SteeringOptimizerBackend,
  SteeringOptimizerConfig,
} from './steering-optimizer'
export { AxGepaSteeringOptimizer, PairwiseSteeringOptimizer } from './steering-optimizer'
export type {
  InspectorContext,
  WorkspaceAssertion,
  WorkspaceAssertionResult,
  WorkspaceInspector,
  WorkspaceSnapshot,
} from './workspace-inspector'
export {
  fileContains,
  fileExists,
  InMemoryWorkspaceInspector,
  rowCount,
  rowWhere,
  runAssertions,
} from './workspace-inspector'

// ── Trace-first chassis ──────────────────────────────────────────────

export * from './trace'

// `knowledge` and `trace` remain re-exported at root because
// they're load-bearing for the capture-integrity story documented in the
// README. Every other module is reachable only through its subpath
// (`/rl`, `/pipelines`, `/meta-eval`, `/prm`, `/builder-eval`, `/traces`).

// ── Producers ────────────────────────────────────────────────────────

export { BudgetBreachError, BudgetGuard } from './budget-guard'
export type {
  FailureClass,
  FailureClassification,
  FailureContext,
  FailureRule,
} from './failure-taxonomy'
export {
  classifyFailure,
  DEFAULT_RULES as DEFAULT_FAILURE_RULES,
  FAILURE_CLASSES,
} from './failure-taxonomy'
export type {
  BlendWeights,
  FieldDestination,
  HiddenCriteriaGrader,
  HiddenGradeResult,
  HiddenLeak,
  JudgeScoreInput,
  NoLeakOptions,
  RoutedField,
} from './hidden-criteria-grading'
export {
  agentVisibleFields,
  assertNoHiddenLeak,
  blendHeldout,
  defaultBlendWeights,
  gradeOnHidden,
  hiddenGrade,
  isHiddenDestination,
  routeFields,
  withHeldoutBlend,
} from './hidden-criteria-grading'
export type {
  ProjectRuntimeTrajectoryEvidenceOptions,
  RuntimeTrajectoryEvidenceProjection,
  RuntimeTrajectoryEvidenceSummary,
  RuntimeTrajectoryHookEvent,
  RuntimeTrajectoryRecord,
  RuntimeTrajectoryRunRecord,
} from './runtime-trajectory'
export {
  parseRuntimeTrajectoryHookEvent,
  projectRuntimeTrajectoryEvidence,
} from './runtime-trajectory'
export type {
  HarnessConfig,
  SandboxDriver,
  SandboxHarnessResult,
  SandboxResult,
  SubprocessSandboxDriverOptions,
  TestOutputParser,
} from './sandbox-harness'
export {
  composeParsers,
  DockerSandboxDriver,
  jestTestParser,
  pytestTestParser,
  SandboxHarness,
  SubprocessSandboxDriver,
  vitestTestParser,
} from './sandbox-harness'
export type {
  TestGradedRunOptions,
  TestGradedRunResult,
  TestGradedScenario,
} from './test-graded-scenario'
export { runTestGradedScenario } from './test-graded-scenario'
export type { ToolStats, ToolUseMetrics, ToolUseOptions } from './tool-use-metrics'
export { computeToolUseMetrics } from './tool-use-metrics'
export type { Trajectory, TrajectoryStep } from './trajectory'
export { buildTrajectory } from './trajectory'

// ── Canned pipelines (views over the trace corpus) — subpath: /pipelines ─

// ── Auxiliary statistical + decision modules ─────────────────────────

export type { AgentProfile, HarnessType, ProfileAxisSpec } from './agent-profile'
export {
  agentProfileHash,
  agentProfileId,
  agentProfileModelId,
  CODING_HARNESSES,
  expandProfileAxes,
  HARNESS_NATIVE_MODEL,
  harnessAxisOf,
} from './agent-profile'
export type { BaselineOptions, BaselineReport, MetricSamples, MetricVerdict } from './baseline'
export { compareToBaseline, iqr, welchsTTest } from './baseline'
export type {
  ChannelRollup,
  CostChannel,
  CostLedgerEntry,
  CostLedgerFilter,
  CostLedgerHandle,
  CostLedgerOptions,
  CostLedgerPersistence,
  CostLedgerSummary,
  CostReceipt,
  CostReceiptInput,
  CostResult,
  CostUsage,
  CustomTokenPricing,
  MaximumCharge,
  PaidCallResult,
  PendingCostCall,
  PendingCostCallView,
  RunPaidCallInput,
} from './cost-ledger'
export {
  CostAccountingIncompleteError,
  CostCallConflictError,
  CostCeilingReachedError,
  CostLedger,
  CostLedgerPersistenceError,
  CostReceiptCaptureError,
  CostReservationExceededError,
  costForTokenPricing,
  costForUsage,
  modelPriceKey,
} from './cost-ledger'
export type { CostEntry, CostSummary, ScenarioCost, TokenSpec } from './cost-tracker'
export { CostTracker } from './cost-tracker'
export type {
  CandidateComparison,
  RunRecordBackend,
  RunRecordFilter,
} from './eval-trace-store'
export {
  EvalTraceStore,
  inMemoryRunRecordBackend,
  jsonlRunRecordBackend,
  runScore,
} from './eval-trace-store'
export type {
  CreateExperimentInput,
  Experiment,
  ExperimentProvenance,
  ExperimentRep,
  ExperimentStats,
  ExperimentStore,
  ExperimentTrackerOptions,
  ExperimentVerdict,
  ImprovementThresholds,
  ImprovementVerdictResult,
  ProvenanceReader,
} from './experiment-tracker'
export {
  computeExperimentStats,
  ExperimentTracker,
  fileExperimentStore,
  gitProvenanceReader,
  improvementVerdict,
  inMemoryExperimentStore,
} from './experiment-tracker'
export { type LeaderboardOptions, type LeaderboardRow, leaderboard } from './leaderboard'
export type { MuffledFinder, MuffledFinding, ScanOptions } from './muffled-gate-scanner'
export {
  DEFAULT_FINDERS,
  findAutoMatchNoExpectation,
  findConstructorCwdDropped,
  findFallbackToPass,
  findLiteralTruePass,
  findSkipCountsAsPass,
  formatFindings,
  scanForMuffledGates,
  UNIVERSAL_FINDERS,
} from './muffled-gate-scanner'
export type { Oracle, OracleObservation, OracleReport, OracleResult } from './oracle'
export {
  evaluateOracles,
  jsonShape,
  notBlocked,
  regexMatches,
  textInSnapshot,
  urlContains,
} from './oracle'
export type { Direction, Objective, ParetoResult } from './pareto'
export { dominates, paretoFrontier } from './pareto'
export type {
  HeldOutPartition,
  PartitionHeldOutOptions,
} from './partition-held-out'
export {
  assignHeldOutTag,
  fnv1a32,
  hashToUnit,
  partitionHeldOut,
} from './partition-held-out'
// ── Eval scorecard — (persona × profile) score timeline ──────────────
export type {
  CellVerdict,
  DiffScorecardOptions,
  RecordRunsOptions,
  Scorecard,
  ScorecardCell,
  ScorecardCellDiff,
  ScorecardDiff,
  ScorecardEntry,
  ScorecardLogLine,
} from './scorecard'
export {
  appendScorecard,
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  recordRuns,
  recordRunsToScorecard,
} from './scorecard'
export type { SeriesConvergenceOptions, SeriesConvergenceResult } from './series-convergence'
export { analyzeSeries } from './series-convergence'
export type { Slo, SloCheckResult, SloComparator, SloReport, SloSeverity } from './slo'
export { checkSlos, DEFAULT_AGENT_SLOS } from './slo'
export type {
  ContinuityCheck,
  ContinuityCheckResult,
  ContinuityReport,
  ContinuitySnapshotPair,
} from './state-continuity'
export {
  collectionPreserved,
  keyPreserved,
  scoreContinuity,
  statusAdvanced,
} from './state-continuity'

// ── Verdict ──────────────────────────────────────────────────────────
// Validator-output primitive. Substrate-level type; agent-runtime's
// Validator<Output, Verdict> defaults to this. See src/verdict.ts.

// ── UI audit finding ─────────────────────────────────────────────────
// Substrate primitive for UI auditor outputs. Consumers (agent-runtime's
// ui-auditor profile, ship gates, dashboards) read findings from here.
// See src/ui-finding.ts.
export type {
  UiFinding,
  UiFindingScreenshot,
  UiFindingSeverity,
  UiLens,
} from './ui-finding'
export { UI_FINDING_SEVERITIES, UI_LENSES } from './ui-finding'
export type { DefaultVerdict } from './verdict'

// ── Trust surface ────────────────────────────────────────────────────

export type { BehaviorAssertion, CallExpectation, Expectation, MatcherResult } from './behavior-dsl'
export { expectAgent, runExpectations } from './behavior-dsl'
export type { ContractMetric, ContractReport, ThresholdContract } from './ci-gate'
export { evaluateContract, renderMarkdownReport } from './ci-gate'
export type { CanaryLeak } from './contamination-guard'
export {
  canaryLeakView,
  checkBehavioralCanary,
  checkCanaries,
  HoldoutAuditor,
  runBehavioralCanaries,
} from './contamination-guard'
export type {
  DatasetDifficulty,
  DatasetManifest,
  DatasetProvenance,
  DatasetScenario,
  DatasetSplit,
  SliceOptions,
} from './dataset'
export { Dataset, HoldoutLockedError, hashScenarios } from './dataset'
export type {
  CalibrationResult,
  CandidateScore,
  ContinuousAgreement,
  ContinuousAgreementOptions,
  ContinuousCalibrationResult,
  GoldenItem,
  PositionalBiasResult,
  SelfPreferenceResult,
  VerbosityBiasResult,
} from './judge-calibration'

export {
  calibrateJudge,
  calibrateJudgeContinuous,
  continuousAgreement,
  positionalBias,
  selfPreference,
  verbosityBias,
} from './judge-calibration'
export type {
  JudgeReplayResult,
  LangfuseEnvelope,
  LangfuseGeneration,
  LangfuseScore,
} from './observability'
export {
  replayTraceThroughJudge,
  toLangfuseEnvelope,
  toPrometheusText,
} from './observability'
export type {
  Mutator,
  ParaphraseRobustnessScenarioInput,
  ParaphraseRobustnessScenarioResult,
  RobustnessResult,
} from './paraphrase'
export {
  DEFAULT_MUTATORS,
  lowercaseMutator,
  paraphraseRobustness,
  paraphraseRobustnessScenarios,
  politenessPrefixMutator,
  sentenceReorderMutator,
  typoMutator,
  whitespaceCollapseMutator,
} from './paraphrase'
export type {
  RedTeamCase,
  RedTeamCategory,
  RedTeamFinding,
  RedTeamPayload,
  RedTeamReport,
} from './red-team'
export {
  DEFAULT_RED_TEAM_CORPUS,
  redTeamDataset,
  redTeamReport,
  scoreRedTeamOutput,
  toolNamesForRun,
} from './red-team'
export type { ImageData, VisualDiffOptions, VisualDiffResult } from './visual-diff'
export { pixelDeltaRatio, visualDiff } from './visual-diff'

// ── builder-of-builders eval — subpath: /builder-eval ───────────────────

// ── Tier 1 — meta-eval correlation, PRM, bisector ────────────────────

export type { BisectOptions, BisectResult, BisectStep } from './bisector'
export {
  bisect,
  commitBisect,
  promptBisect,
} from './bisector'
// meta-eval and prm are reachable through their subpaths: /meta-eval, /prm

// ── Tier 2 — counterfactual + cross-trace diff + pre-registration ────

export type {
  CounterfactualContext,
  CounterfactualMutation,
  CounterfactualResult,
  CounterfactualRunner,
} from './counterfactual'
export { attributeCounterfactuals, runCounterfactual } from './counterfactual'
export type {
  AlignmentOp,
  CrossTraceDiff,
  CrossTraceDiffOptions,
  StepAttribution,
} from './cross-trace-diff'
export { crossTraceDiff } from './cross-trace-diff'
export type {
  HypothesisManifest,
  HypothesisResult,
  SignedManifest,
  SignedManifestAlgo,
} from './pre-registration'
export {
  canonicalize,
  evaluateHypothesis,
  hashJson,
  signManifest,
  verifyManifest,
} from './pre-registration'

// ── Tier 3 — self-play + causal + active learning + RM export ───────

export type { ActiveLearningOptions, SynthesisReason, SynthesisTarget } from './active-learning'
export { proposeSynthesisTargets } from './active-learning'
export type {
  CausalAttributionReport,
  FactorContribution,
  FactorialCell,
  InteractionContribution,
} from './causal-attribution'
export { causalAttribution } from './causal-attribution'
export type { ExportedRewardModel, InferenceScorer } from './reward-model-export'
export {
  exportRewardModel,
  loadScorerFromGrader,
  replayScorerOverCorpus,
} from './reward-model-export'
export type {
  CandidateScenario,
  EvolutionRound,
  ScoredTarget,
  SelfPlayOptions,
  SelfPlayProposer,
  SelfPlayScorer,
} from './self-play'
export { runSelfPlay } from './self-play'

// ── LLM client, multi-layer verifier, semantic concept judge, error-count ─

export type {
  CommandRunner,
  DirEntry,
  RunCommandInput,
  RunCommandResult,
} from './command-runner'
export { localCommandRunner } from './command-runner'
export type {
  DeployFamily,
  DeployGateLayerInput,
  DeployRunner,
  DeployRunResult,
  ViteDeployRunnerInput,
  WranglerDeployRunnerInput,
} from './deploy-gate-layer'
export { deployGateLayer, viteDeployRunner, wranglerDeployRunner } from './deploy-gate-layer'
export type {
  ErrorCountPattern,
  ExtractOptions,
  ExtractResult,
} from './error-count-extractor'
export {
  ERROR_COUNT_PATTERNS,
  extractErrorCount,
} from './error-count-extractor'
export type {
  FlowAction,
  FlowLayerEnv,
  FlowLayerFactoryInput,
  FlowRunner,
  FlowRunnerStepResult,
  FlowSpec,
  FlowStep,
} from './flow-layer'
export { flowLayer } from './flow-layer'
export type {
  IntentMatchInput,
  IntentMatchOptions,
  IntentMatchResult,
} from './intent-match-judge'
export {
  createIntentMatchJudge,
  INTENT_MATCH_JUDGE_VERSION,
  runIntentMatchJudge,
} from './intent-match-judge'
export type {
  KeywordConceptSpec,
  KeywordCoverageFinding,
  KeywordCoverageOptions,
  KeywordCoverageResult,
} from './keyword-coverage-judge'
export {
  extractAssetUrls,
  htmlContainsElement,
  runKeywordCoverageJudge,
  runKeywordCoverageJudgeUrl,
} from './keyword-coverage-judge'
export type {
  LlmCallMetadata,
  LlmCallRequest,
  LlmCallResult,
  LlmClientOptions,
  LlmMessage,
  LlmRouteRequirements,
  LlmUsage,
} from './llm-client'
export {
  assertLlmRoute,
  backoffMs,
  callLlm,
  callLlmJson,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  isTransientLlmError,
  LlmCallError,
  LlmClient,
  LlmResponseError,
  LlmRouteAssertionError,
  maximumChargeForLlmRequest,
  probeLlm,
  stripFencedJson,
} from './llm-client'
export type {
  Finding,
  Layer,
  LayerResult,
  LayerStatus,
  Severity,
  VerificationReport,
  VerifyContext,
  VerifyOptions,
} from './multi-layer-verifier'
export {
  gradeSemanticStatus,
  MultiLayerVerifier,
} from './multi-layer-verifier'
export type {
  AdapterRun,
  MergeOptions,
  MultiToolchainLayerConfig,
} from './multi-toolchain-layer'
export { mergeLayerResults, multiToolchainLayer } from './multi-toolchain-layer'
export type {
  ReferenceEquivalenceJudgeInput,
  ReferenceEquivalenceJudgeOptions,
  ReferenceEquivalenceJudgeResult,
  ReferenceEquivalenceScenario,
} from './reference-equivalence-judge'
export {
  createReferenceEquivalenceJudge,
  REFERENCE_EQUIVALENCE_INPUT_LIMITS,
  REFERENCE_EQUIVALENCE_JUDGE_VERSION,
  runReferenceEquivalenceJudge,
} from './reference-equivalence-judge'
// ── Reference replay ─────────────────────────────────────────────────
export {
  compareReferenceReplay,
  decideReferenceReplayPromotion,
  decideReferenceReplayRunPromotion,
  defaultReferenceReplayMatcher,
  inMemoryReferenceReplayStore,
  jsonlReferenceReplayStore,
  runReferenceReplay,
  scoreReferenceReplay,
} from './reference-replay'
export type {
  CreateDefaultReviewerOptions,
  ReviewerMemoryEntry,
  ReviewerOutput,
  ReviewerPromptInput,
  ReviewerSoftFailDefaults,
  ReviewerVerificationSummary,
} from './reviewer'
export { buildReviewerPrompt, createDefaultReviewer } from './reviewer'
export type {
  ConceptComplexity,
  ConceptFinding,
  ConceptSpec,
  ConceptWeightStrategy,
  SemanticConceptJudgeInput,
  SemanticConceptJudgeOptions,
  SemanticConceptJudgeResult,
} from './semantic-concept-judge'
export {
  createSemanticConceptJudge,
  DEFAULT_COMPLEXITY_WEIGHTS,
  runSemanticConceptJudge,
  SEMANTIC_CONCEPT_JUDGE_VERSION,
} from './semantic-concept-judge'

// ── Paper-grade primitives ───────────────────────────────────────────

export * as benchmarks from './benchmarks/index'
export type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
  BenchmarkFamily,
  BenchmarkResponder,
  BenchmarkScenario,
  BenchmarkSource,
  BenchmarkTaskKind,
} from './benchmarks/types'
export {
  BENCHMARK_SPLIT_SEED,
  deterministicSplit as benchmarkDeterministicSplit,
} from './benchmarks/types'
export type {
  CanaryAlert,
  CanaryKind,
  CanaryOptions,
  CanaryReport,
  CanarySeverity,
} from './canary'
export { runCanaries } from './canary'
// ── Concurrency + persistence + telemetry primitives for evolution loops ──
export { Mutex, mapConcurrent } from './concurrency'
export type {
  DescriptionLengthCandidate,
  DescriptionLengthConfig,
  DescriptionLengthDecision,
  DescriptionLengthEvidence,
  DescriptionLengthRejectionCode,
} from './description-length-gate'
export {
  DescriptionLengthGate,
  dataDescriptionBits,
  modelDescriptionBits,
} from './description-length-gate'
export type {
  DiscoveredPersona,
  DiscoverPersonasOptions,
} from './discover-personas'
export { discoverPersonas } from './discover-personas'
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
export { runEvalCampaign } from './eval-campaign'
export type {
  GoldenSeverity,
  GoldenSpec,
  MatchResult,
} from './golden-matcher'
export {
  DEFAULT_SEVERITY_WEIGHTS,
  matchGoldens,
  precision as goldenPrecision,
  weightedRecall,
} from './golden-matcher'
export type {
  GateDecision,
  GateEvidence,
  HeldOutGateConfig,
  HeldOutGateRejectionCode,
} from './held-out-gate'
export { HeldOutGate } from './held-out-gate'
export type {
  JudgeRetryOutcome,
  JudgeRetryPolicy,
} from './judge-retry'
export { withJudgeRetry } from './judge-retry'
export { LockedJsonlAppender } from './locked-jsonl-appender'
export type { OrthogonalityInput, OrthogonalityResult } from './orthogonality'
export { passOrthogonality } from './orthogonality'
// Pareto extensions (paretoFrontier + dominates already exported above)
export { crowdingDistance, paretoFrontierWithCrowding, scalarScore } from './pareto'
export type {
  BootstrapOptions,
  BootstrapResult,
  JudgeReplayGateArgs,
  Verdict,
} from './promotion-gate'
export { bootstrapCi, judgeReplayGate } from './promotion-gate'
// ── Prompt evolution + golden matcher + orthogonality + promotion-gate ──
export type {
  ReferenceMatchResult,
  ReferenceReplayAdapter,
  ReferenceReplayAdapterFn,
  ReferenceReplayAdapterLike,
  ReferenceReplayAggregate,
  ReferenceReplayCandidate,
  ReferenceReplayCase,
  ReferenceReplayCaseRun,
  ReferenceReplayExecutionScenario,
  ReferenceReplayItem,
  ReferenceReplayMatch,
  ReferenceReplayMatcher,
  ReferenceReplayMatchStrategy,
  ReferenceReplayPromotionDecision,
  ReferenceReplayPromotionPolicy,
  ReferenceReplayRun,
  ReferenceReplayRunContext,
  ReferenceReplayRunOptions,
  ReferenceReplayRunStore,
  ReferenceReplayScenario,
  ReferenceReplayScenarioScore,
  ReferenceReplayScore,
  ReferenceReplayScoreOptions,
  ReferenceReplaySplit,
  ReferenceReplaySplitComparison,
} from './reference-replay'
export type { ReferenceReplaySteeringRowsOptions } from './reference-replay-steering'
export {
  referenceReplayRunsToSteeringRows,
  referenceReplayScenarioToRunScore,
} from './reference-replay-steering'
export type {
  ReflectionContext,
  ReflectionProposal,
  TrialTrace,
} from './reflective-mutation'
export {
  buildReflectionPrompt,
  DEFAULT_MUTATION_PRIMITIVES,
  parseReflectionResponse,
} from './reflective-mutation'
export type {
  ActionableSideInfo,
  AsiSeverity,
  ReleaseConfidenceAxis,
  ReleaseConfidenceAxisName,
  ReleaseConfidenceInput,
  ReleaseConfidenceIssue,
  ReleaseConfidenceMetrics,
  ReleaseConfidenceScorecard,
  ReleaseConfidenceStatus,
  ReleaseConfidenceThresholds,
  ReleaseTraceEvidence,
} from './release-confidence'
export { assertReleaseConfidence, evaluateReleaseConfidence } from './release-confidence'
export type { RenderReleaseReportOptions } from './release-report'
export { renderReleaseReport } from './release-report'
export type {
  ReplayCacheEntry,
  ReplayCacheStats,
  ReplayFetchOptions,
} from './replay'
export {
  createReplayFetch,
  iterateRawCalls,
  ReplayCache,
  ReplayCacheMissError,
} from './replay'
export type {
  CallbackResearcherOptions,
  ExperimentPlan,
  ExperimentResult,
  FailureMode,
  Researcher,
  SteeringChange,
} from './researcher'
export { CallbackResearcher, NoopResearcher } from './researcher'
// RL/data bridge primitives live on @tangle-network/agent-eval/rl.
export type {
  JudgeScoresRecord,
  RunCostProvenance,
  RunJudgeMetadata,
  RunOutcome,
  RunRecord,
  RunSplitTag,
  RunTokenUsage,
} from './run-record'
export {
  isRunRecord,
  modelHasSnapshot,
  parseRunRecordSafe,
  RunRecordValidationError,
  resolveRunCostProvenance,
  roundTripRunRecord,
  validateRunRecord,
} from './run-record'
export type {
  CreateSandboxPoolOpts,
  PoolSlot,
  SandboxPool,
  SlotFactory,
} from './sandbox-pool'
export { createSandboxPool } from './sandbox-pool'
export type {
  InterimReleaseConfidence,
  InterimReleaseConfidenceInput,
  PairedEvalueOptions,
  PairedEvalueSequence,
  PairedEvalueStep,
  SequentialDecision,
} from './sequential'
export {
  evaluateInterimReleaseConfidence,
  pairedEvalueSequence,
} from './sequential'
export type {
  GainDistributionBin,
  GainDistributionFigureSpec,
  GainDistributionOptions,
  ParetoFigureSpec,
  ParetoPoint,
  ResearchReport,
  ResearchReportCandidate,
  ResearchReportDecision,
  ResearchReportMethodology,
  ResearchReportOptions,
  ResearchReportRecommendation,
  SummaryTable,
  SummaryTableOptions,
  SummaryTableRow,
} from './summary-report'
export {
  gainHistogram,
  paretoChart,
  RESEARCH_REPORT_HARD_PAIR_FLOOR,
  researchReport,
  summaryTable,
} from './summary-report'

// ── OTEL pipeline + traced wrappers ─────────────────────────────────

export type { OtelPipelineHandle, OtelPipelineOptions } from './otel-pipeline'
export { isOtelConfigured, withOtelPipeline } from './otel-pipeline'
export type { TracedAnalystOptions } from './traced-analyst'
export { tracedAnalyzeTraces } from './traced-analyst'
export type { TracedJudgeOptions } from './traced-judges'
export { traceJudge, traceJudgeEnsemble } from './traced-judges'

// ── Teacher→student GEPA distillation ────────────────────────────────
// Distill a cheap single-shot analyst's prompt toward an expensive workflow's
// gold verdicts. Composes runImprovementLoop + gepaProposer + the gate.

export type {
  AgreementResult,
  BuildAgreementJudgeOptions,
  CompareLabels,
  FieldAgreementSpec,
} from './campaign/distillation/agreement-judge'
export { buildAgreementJudge, fieldAgreement } from './campaign/distillation/agreement-judge'
export type {
  GoldScenario,
  GoldSplit,
  SplitGoldOptions,
} from './campaign/distillation/gold-scenarios'
export {
  loadGoldScenarios,
  parseGoldJsonl,
  splitGold,
} from './campaign/distillation/gold-scenarios'
export type {
  ParseStudentLabel,
  RenderStudentPrompt,
  RunDistillationOptions,
  RunDistillationResult,
} from './campaign/distillation/run-distillation'
export {
  defaultParseStudentLabel,
  defaultRenderStudentPrompt,
  runDistillation,
} from './campaign/distillation/run-distillation'

// Prompt-profile builder utilities are namespaced under `profile`. The
// canonical public `AgentProfile` type is exported above from
// `@tangle-network/agent-interface` via `./agent-profile`.
export * as profile from './profile/index'

// ── Cost governance — model seating chart + program cost report ─────────

export type { CostReport, ModelCostRollup } from './cost-report'
export { attachCostToReport, costReport } from './cost-report'
export type { ModelSeats, SeatName, SeatPresetName } from './model-seats'
export { resolveSeat, SeatUnsetError, seatPresets } from './model-seats'

// Ax RLM trace analyst — subpath: /traces (re-exported alongside trace store).

export type {
  AttestationProvenance,
  AttestationVerification,
  AttestedReport,
} from './attestation'
export { ATTESTATION_ALGORITHM, attest, verifyAttestation } from './attestation'
// ── Perf — infra-performance benchmarking substrate ──────────────────
// Journeys × axes scenario matrix, record-integrity contracts, and the
// percentile ratchet (summarize → baseline → gate). Scores LATENCY /
// RELIABILITY over flat metric records; the judge-panel BenchmarkRunner
// (./benchmark) scores QUALITY. Also on the `/perf` subpath.
// Product-owned benchmark bundles: portable product runs for agent-lab research.
export type {
  AgentProfileRuntimeReceipt,
  ProductBenchmarkArm,
  ProductBenchmarkArtifactPaths,
  ProductBenchmarkBudgets,
  ProductBenchmarkExportOptions,
  ProductBenchmarkExportResult,
  ProductBenchmarkManifest,
  ProductBenchmarkProfileRef,
  ProductBenchmarkRecord,
  ProductBenchmarkRepoRef,
  ProductBenchmarkRunInput,
  ProductBenchmarkScenario,
  ProductBenchmarkSingleRunExportOptions,
  ProductBenchmarkSplit,
  ProductBenchmarkSubstrateVersions,
  ProductBenchmarkValidationReport,
  RuntimeResolution,
} from './product-benchmark'
export {
  assertProductBenchmarkRun,
  buildProductBenchmarkManifest,
  exportProductBenchmark,
  exportProductBenchmarkRuns,
  findProductBenchmarkArtifacts,
  productBenchmarkIntegrityFailures,
  productBenchmarkMutableSurfaces,
  productBenchmarkRepoIdentity,
  productBenchmarkSplits,
  readProductBenchmarkManifest,
  readProductBenchmarkRecords,
  runRecordToProductBenchmarkRecord,
  validateProductBenchmarkManifest,
  validateProductBenchmarkRecord,
  validateProductBenchmarkRun,
} from './product-benchmark'
// ── Anytime-valid sequential testing (e-process core) ────────────────
// The betting test-martingale behind the sequential gates. Gate-level
// machinery (sequentialPairedGate, sequentialDecide) lives on the /campaign
// subpath alongside the other gates.
export type { EProcess, EProcessOptions, EProcessState, EProcessStep } from './statistics'
export { eProcess, mulberry32 } from './statistics'
// ── Trace contracts — finite-trace temporal assertions over spans ────
// Dual-use: one serializable contract checks recorded eval traces AND the
// OTLP-flattened production stream. Evaluators are `evaluateTraceContract` /
// `checkTraceContracts` because ci-gate owns the root `evaluateContract` name.
export type {
  ContractCheckResult,
  ContractJudgeOptions,
  ContractRule,
  ContractRuleKind,
  ContractSpan,
  ContractVerdict,
  ContractViolation,
  SerializedRegex,
  SpanPredicate,
  TextMatcher,
  TraceContract,
} from './trace-contracts'
export {
  checkTraceContracts,
  contractJudge,
  evaluateTraceContract,
  matchSpan,
  TraceContractBuilder,
  traceContract,
} from './trace-contracts'
export type {
  CachedJudge,
  CachedJudgeOptions,
  VerdictCacheStats,
  VerdictCacheStore,
} from './verdict-cache'
export {
  cachedJudge,
  canonicalJson,
  contentHash,
  fileVerdictCache,
  inMemoryVerdictCache,
} from './verdict-cache'
