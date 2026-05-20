// ── Core types ───────────────────────────────────────────────────────

export type { ActionExecutionPolicy, ActionPolicyDecision } from './action-policy'
export { evaluateActionPolicy } from './action-policy'
export type {
  JudgeAdapterOpts,
  RunCriticAdapterOpts,
  SemanticConceptJudgeAdapterOpts,
  TraceAnalystAdapterOpts,
  VerifierAdapterOpts,
} from './analyst/adapters'
export {
  createJudgeAdapter,
  createRunCriticAdapter,
  createSemanticConceptJudgeAdapter,
  createTraceAnalystAdapter,
  createVerifierAdapter,
  liftSeverity,
} from './analyst/adapters'
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
export type { RawAnalystFinding } from './analyst/finding-signature'
export {
  ANALYST_SEVERITIES,
  parseRawFinding,
  RAW_FINDING_SCHEMA_PROMPT,
  RawAnalystFindingSchema,
} from './analyst/finding-signature'
export type {
  FindingSubject,
  FindingSubjectKind,
} from './analyst/finding-subject'
export {
  FINDING_SUBJECT_GRAMMAR_PROMPT,
  FINDING_SUBJECT_KINDS,
  FindingSubjectStringSchema,
  KIND_EXPECTED_SUBJECTS,
  parseFindingSubject,
  renderFindingSubject,
} from './analyst/finding-subject'
export type { DiffPolicy, FindingsDiff, PersistedFinding } from './analyst/findings-store'
export { defaultIsMaterial, diffFindings, FindingsStore } from './analyst/findings-store'
export type {
  CreateTraceAnalystKindOpts,
  TraceAnalystGolden,
  TraceAnalystKindSpec,
} from './analyst/kind-factory'
export { createTraceAnalystKind, renderPriorFindings } from './analyst/kind-factory'
export {
  DEFAULT_TRACE_ANALYST_KINDS,
  FAILURE_MODE_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
  KNOWLEDGE_GAP_KIND_SPEC,
  KNOWLEDGE_POISONING_KIND_SPEC,
} from './analyst/kinds'
export type {
  AnalystHooks,
  AnalystRegistryOptions,
  BudgetPolicy,
  RegistryRunOpts,
} from './analyst/registry'
export { AnalystRegistry } from './analyst/registry'
export type { TraceToolGroupName } from './analyst/tool-groups'
export { buildTraceToolsForGroup } from './analyst/tool-groups'
// ── Analyst registry ─────────────────────────────────────────────────
// Generic contract + registry over agent-eval's existing analyzers
// (analyzeTraces, MultiLayerVerifier, RunCritic, SemanticConceptJudge,
// JudgeFn). One envelope, one runner, model-agnostic, transport-agnostic.
export type {
  Analyst,
  AnalystContext,
  AnalystCost,
  AnalystFinding,
  AnalystInputKind,
  AnalystRequirements,
  AnalystRunEvent,
  AnalystRunInputs,
  AnalystRunResult,
  AnalystRunSummary,
  AnalystSeverity,
  EvidenceRef,
} from './analyst/types'
export { computeFindingId, makeFinding } from './analyst/types'
// ── Production loop primitive ────────────────────────────────────────
// Closes the eval → prod → eval cycle: ingest production traces,
// cluster failures, run evolve on the offending cluster, gate the
// candidate, open a PR with the improved prompt.
/**
 * @experimental — surface may evolve as production agents wire it in.
 * Pin the patch version if you depend on it.
 */
export type {
  AutoPrClient,
  FileChange,
  GhCliClientOptions,
  HttpGithubClientOptions,
  ProposeAutomatedPullRequestInput,
  ProposeAutomatedPullRequestResult,
  RepoRef,
} from './auto-pr'
export {
  ghCliClient,
  httpGithubClient,
  proposeAutomatedPullRequest,
} from './auto-pr'
export { BenchmarkRunner } from './benchmark'
// ── Client / driver / judges / executor / benchmark / registry / reporter ─
export { ProductClient, runE2EWorkflow } from './client'
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
export type { AgentDriverConfig } from './driver'
export { AgentDriver } from './driver'
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
export type {
  IntegrationGateSurface,
  IntegrationInvokeFailureInput,
  IntegrationManifestGateInput,
} from './integration-gates'
export {
  integrationAsi,
  integrationGateEvals,
  integrationInvokeFailedPayload,
  integrationManifestResolvedPayload,
  integrationManifestValidatedPayload,
} from './integration-gates'
export {
  adversarialJudge,
  codeExecutionJudge,
  coherenceJudge,
  createCustomJudge,
  createDomainExpertJudge,
  defaultJudges,
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
  MetricsCollector,
  MODEL_PRICING,
  TokenCounter,
} from './metrics'
/**
 * @experimental
 */
export type {
  FailureClusterConfig,
  ProductionEvolveConfig,
  ProductionLoopCronConfig,
  ProductionLoopDecision,
  ProductionLoopRenderContext,
  ProductionLoopResult,
  ProductionShipConfig,
  RunProductionLoopOptions,
} from './production-loop'
export { runProductionLoop } from './production-loop'
export { ScenarioRegistry } from './registry'
export { formatBenchmarkReport, formatDriverReport, printDriverSummary } from './reporter'
export type {
  ControlRunToRunRecordOptions,
  RunEvidenceMetadata,
} from './run-evidence'
export {
  controlRunToRunRecord,
  scoreFromEvals,
} from './run-evidence'
export type {
  CorpusAgreementOptions,
  CorpusAgreementPerDimension,
  CorpusAgreementReport,
  CorpusScoreRecord,
} from './statistics'
// ── Statistics ───────────────────────────────────────────────────────
export {
  cohensD,
  confidenceInterval,
  corpusInterRaterAgreement,
  corpusInterRaterAgreementFromJudgeScores,
  interRaterReliability,
  mannWhitneyU,
  normalizeScores,
  pairedTTest,
  partialCredit,
  weightedMean,
  wilcoxonSignedRank,
} from './statistics'
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
export { ConvergenceTracker } from './convergence'
export type {
  DualAgentBenchConfig,
  DualAgentReport,
  DualAgentRound,
  DualAgentScenario,
  DualAgentScenarioResult,
} from './dual-agent-bench'
export { DualAgentBench } from './dual-agent-bench'
export type {
  HostedJudgeConfig,
  HostedJudgeDimension,
  HostedJudgeRequest,
  HostedJudgeResponse,
  HostedRunCriticConfig,
  HostedRunScoreRequest,
  HostedRunScoreResponse,
} from './eval-api'
export type {
  Experiment,
  ExperimentStore,
  Run as ExperimentRun,
  RunConfig,
  RunDiff,
} from './experiment-tracker'

export { ExperimentTracker, InMemoryExperimentStore } from './experiment-tracker'
export type {
  D1ExperimentStoreOptions,
  D1Like,
  D1PreparedStatementLike,
} from './experiment-tracker-d1'
export { D1ExperimentStore } from './experiment-tracker-d1'
export type { FileSystemExperimentStoreOptions } from './experiment-tracker-fs'
export { FileSystemExperimentStore } from './experiment-tracker-fs'
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
export type { Playbook, PlaybookEntry } from './playbook'
export { distillPlaybook, renderPlaybookMarkdown } from './playbook'
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

// `knowledge`, `governance`, and `trace` remain re-exported at root because
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

export type { BaselineOptions, BaselineReport, MetricSamples, MetricVerdict } from './baseline'
export { compareToBaseline, iqr, welchsTTest } from './baseline'
export type { CostEntry, CostSummary, ScenarioCost, TokenSpec } from './cost-tracker'
export { CostTracker } from './cost-tracker'
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
export { benjaminiHochberg, bonferroni, requiredSampleSize } from './power-analysis'
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

// ── Governance templates ─────────────────────────────────────────────

export * from './governance'

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
  LlmCallRequest,
  LlmCallResult,
  LlmClientOptions,
  LlmMessage,
  LlmRouteRequirements,
  LlmUsage,
} from './llm-client'
export {
  assertLlmRoute,
  callLlm,
  callLlmJson,
  LlmCallError,
  LlmClient,
  LlmRouteAssertionError,
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
export type {
  CodeMutationOutcome,
  CodeMutationRunner,
  CreateSandboxCodeMutatorOpts,
} from './code-mutator'
export { createSandboxCodeMutator } from './code-mutator'
export type { CompositePolicy, CreateCompositeMutatorOpts } from './composite-mutator'
export { createCompositeMutator } from './composite-mutator'
// ── Concurrency + persistence + telemetry primitives for evolution loops ──
export { Mutex } from './concurrency'
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
  CostLedgerGeneration,
  CostLedgerSnapshot,
  LineageKind,
  LineageKindResolver,
  LineageNode,
  MutationAttempt,
  MutationChannel,
  TrialAttempt,
} from './evolution-telemetry'
export {
  CostLedger,
  LineageRecorder,
  MutationTelemetry,
  TrialTelemetry,
} from './evolution-telemetry'
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
export { JsonlTrialCache } from './jsonl-trial-cache'
export type {
  JudgeRetryOutcome,
  JudgeRetryPolicy,
} from './judge-retry'
export { withJudgeRetry } from './judge-retry'
export { LockedJsonlAppender, resetLockedAppendersForTesting } from './locked-jsonl-appender'
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
  defaultMultiShotObjectives,
  runMultiShotOptimization,
  trialTraceFromMultiShotTrial,
} from './multi-shot-optimization'
export type { OrthogonalityInput, OrthogonalityResult } from './orthogonality'
export { passOrthogonality } from './orthogonality'
export type {
  PairedBootstrapOptions,
  PairedBootstrapResult,
} from './paired-stats'
export {
  bhAdjust,
  pairedBootstrap,
  pairedWilcoxon,
} from './paired-stats'
// Pareto extensions (paretoFrontier + dominates already exported above)
export { crowdingDistance, paretoFrontierWithCrowding, scalarScore } from './pareto'
export type {
  BootstrapOptions,
  BootstrapResult,
  JudgeReplayGateArgs,
  Verdict,
} from './promotion-gate'
export { bootstrapCi, judgeReplayGate } from './promotion-gate'
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
  TrialResult as PromptTrialResult,
  VariantAggregate,
} from './prompt-evolution'
// ── Prompt evolution + golden matcher + orthogonality + promotion-gate ──
export {
  InMemoryTrialCache,
  runPromptEvolution,
} from './prompt-evolution'
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
export {
  assertReleaseConfidence,
  evaluateReleaseConfidence,
  releaseTraceEvidenceFromMultiShotTrials,
} from './release-confidence'
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
// RL primitives — adapters, rewards, preferences, OPE, PRM, contamination,
// tournaments, adversarial, compute curves, auto-research — live on the
// dedicated subpath: @tangle-network/agent-eval/rl
export type {
  RunJudgeMetadata,
  RunOutcome,
  RunRecord,
  RunSplitTag,
  RunTokenUsage,
} from './run-record'
export {
  isRunRecord,
  parseRunRecordSafe,
  RunRecordValidationError,
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
export type {
  AggregatorMode,
  TrialAggregate,
} from './trial-aggregator'
export { aggregateTrialsByMode } from './trial-aggregator'

// Ax RLM trace analyst — subpath: /traces (re-exported alongside trace store).
