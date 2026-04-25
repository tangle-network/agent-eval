// ── Core types ───────────────────────────────────────────────────────
export type {
  Scenario,
  Turn,
  ArtifactCheck,
  JudgeConfig,
  JudgeRubric,
  RubricDimension,
  ScenarioResult,
  TurnResult,
  ArtifactResult,
  JudgeScore,
  CollectedArtifacts,
  BenchmarkReport,
  RouteMap,
  ProductClientConfig,
  ScenarioFile,
  CompletionCriterion,
  FeedbackPattern,
  PersonaConfig,
  DriverState,
  TurnMetrics,
  DriverResult,
  BenchmarkRunnerConfig,
  JudgeInput,
  JudgeFn,
  TestResult,
  CheckResult,
  EvalResult,
} from './types'

// ── Client / driver / judges / executor / benchmark / registry / reporter ─
export { ProductClient, runE2EWorkflow } from './client'
export {
  createDomainExpertJudge,
  codeExecutionJudge,
  coherenceJudge,
  adversarialJudge,
  createCustomJudge,
  defaultJudges,
} from './judges'
export { executeScenario } from './executor'
export type { ExecutorConfig } from './executor'
export { BenchmarkRunner } from './benchmark'
export { MetricsCollector, TokenCounter, estimateTokens, estimateCost, MODEL_PRICING } from './metrics'
export { ScenarioRegistry } from './registry'
export { AgentDriver } from './driver'
export type { AgentDriverConfig } from './driver'
export { formatBenchmarkReport, formatDriverReport, printDriverSummary } from './reporter'

// ── Statistics ───────────────────────────────────────────────────────
export {
  normalizeScores,
  weightedMean,
  confidenceInterval,
  interRaterReliability,
  mannWhitneyU,
  pairedTTest,
  wilcoxonSignedRank,
  cohensD,
  partialCredit,
} from './statistics'

// ── 0.2 primitives ───────────────────────────────────────────────────

export { ConvergenceTracker } from './convergence'

export { PromptRegistry, hashContent } from './prompt-registry'
export type { PromptHandle } from './prompt-registry'

export { createAntiSlopJudge, analyzeAntiSlop } from './anti-slop'
export type { AntiSlopConfig, AntiSlopIssue, AntiSlopReport, SlopCategory } from './anti-slop'

export {
  composeValidators,
  regexMatch,
  jsonHasKeys,
  byteLengthRange,
  containsAll,
} from './artifact-validator'
export type {
  Artifact as ArtifactCheckArtifact,
  ArtifactValidator,
  ValidationContext,
  ValidationIssue,
  ValidationResult,
} from './artifact-validator'

export {
  InMemoryWorkspaceInspector,
  fileExists,
  fileContains,
  rowCount,
  rowWhere,
  runAssertions,
} from './workspace-inspector'
export type {
  WorkspaceInspector,
  WorkspaceSnapshot,
  WorkspaceAssertion,
  WorkspaceAssertionResult,
  InspectorContext,
} from './workspace-inspector'

export { ExperimentTracker, InMemoryExperimentStore } from './experiment-tracker'
export type { Experiment, ExperimentStore, Run as ExperimentRun, RunConfig, RunDiff } from './experiment-tracker'

export { PromptOptimizer } from './prompt-optimizer'
export type {
  OptimizationConfig,
  OptimizationResult,
  PromptVariant,
  PairwiseComparison,
  VariantScore,
} from './prompt-optimizer'
export { mergeSteeringBundle, renderSteeringText } from './steering'
export type { SteeringBundle, SteeringDelta, SteeringRolePrompt } from './steering'
export { aggregateRunScore, clamp01, DEFAULT_RUN_SCORE_WEIGHTS } from './run-score'
export type { RunScore, RunScoreWeights } from './run-score'
export { RunCritic } from './run-critic'
export type { RunTrace, RunCriticOptions } from './run-critic'
export { distillPlaybook, renderPlaybookMarkdown } from './playbook'
export type { Playbook, PlaybookEntry } from './playbook'
export { OptimizationLoop } from './optimization-loop'
export type {
  OptimizationExample,
  SteeringEvaluation,
  SteeringVariantReport,
  OptimizationLoopResult,
  OptimizationLoopConfig,
} from './optimization-loop'
export { PairwiseSteeringOptimizer, AxGepaSteeringOptimizer } from './steering-optimizer'
export type {
  SteeringOptimizerBackend,
  SteeringOptimizationRow,
  SteeringOptimizationSelector,
  SteeringOptimizationResult,
  SteeringOptimizerConfig,
  AxSteeringOptimizerConfig,
} from './steering-optimizer'
export {
  DEFAULT_HARNESS_OBJECTIVES,
  runHarnessExperiment,
  selectHarnessVariant,
  summarizeHarnessResults,
} from './harness-optimizer'
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
  JudgeRunner,
  runJudgeFleet,
  compilerJudge,
  testJudge,
  linterJudge,
  securityJudge,
} from './judge-runner'
export type {
  SandboxJudgeKind,
  SandboxJudgeSpec,
  SandboxJudgeResult,
  JudgeFleetOptions,
} from './judge-runner'
export type {
  HostedJudgeConfig,
  HostedJudgeDimension,
  HostedJudgeRequest,
  HostedJudgeResponse,
  HostedRunCriticConfig,
  HostedRunScoreRequest,
  HostedRunScoreResponse,
} from './eval-api'

export { DualAgentBench } from './dual-agent-bench'
export type {
  DualAgentBenchConfig,
  DualAgentScenario,
  DualAgentScenarioResult,
  DualAgentReport,
  DualAgentRound,
} from './dual-agent-bench'

export {
  runProposeReview,
  inMemoryReviewStore,
  jsonlReviewStore,
  createLlmReviewer,
} from './propose-review'
export type {
  Verification,
  Review,
  ReviewMemoryEntry,
  ReviewMemoryStore,
  ProposeInput,
  ProposeOutput,
  ReviewInput,
  ProposeFn,
  VerifyFn,
  ReviewFn,
  ProposeReviewConfig,
  ProposeReviewShot,
  ProposeReviewReport,
  LlmJsonCall,
  LlmReviewerConfig,
} from './propose-review'

// ── 0.3 trace-first chassis ──────────────────────────────────────────

export * from './trace'

// ── 0.3 producers ────────────────────────────────────────────────────

export { SandboxHarness, SubprocessSandboxDriver, DockerSandboxDriver, composeParsers, vitestTestParser, pytestTestParser, jestTestParser } from './sandbox-harness'
export type { HarnessConfig, SandboxDriver, SandboxResult, SandboxHarnessResult, SubprocessSandboxDriverOptions, TestOutputParser } from './sandbox-harness'

export { runTestGradedScenario } from './test-graded-scenario'
export type { TestGradedScenario, TestGradedRunOptions, TestGradedRunResult } from './test-graded-scenario'

export { BudgetGuard, BudgetBreachError } from './budget-guard'

export { classifyFailure, DEFAULT_RULES as DEFAULT_FAILURE_RULES, FAILURE_CLASSES } from './failure-taxonomy'
export type { FailureClass, FailureClassification, FailureRule, FailureContext } from './failure-taxonomy'

export { buildTrajectory } from './trajectory'
export type { Trajectory, TrajectoryStep } from './trajectory'

export { computeToolUseMetrics } from './tool-use-metrics'
export type { ToolUseMetrics, ToolStats, ToolUseOptions } from './tool-use-metrics'

// ── 0.3 canned pipelines (views over the trace corpus) ───────────────

export * from './pipelines'

// ── 0.3 auxiliary statistical + decision modules ─────────────────────

export { checkSlos, DEFAULT_AGENT_SLOS } from './slo'
export type { Slo, SloCheckResult, SloReport, SloSeverity, SloComparator } from './slo'

export { compareToBaseline, iqr, welchsTTest } from './baseline'
export type { BaselineOptions, BaselineReport, MetricSamples, MetricVerdict } from './baseline'

export {
  evaluateOracles,
  textInSnapshot,
  urlContains,
  jsonShape,
  regexMatches,
  notBlocked,
} from './oracle'
export type { Oracle, OracleObservation, OracleReport, OracleResult } from './oracle'

export { CostTracker } from './cost-tracker'
export type { CostEntry, ScenarioCost, CostSummary, TokenSpec } from './cost-tracker'

export { dominates, paretoFrontier } from './pareto'
export type { Direction, Objective, ParetoResult } from './pareto'

export {
  scanForMuffledGates,
  formatFindings,
  DEFAULT_FINDERS,
  UNIVERSAL_FINDERS,
  findFallbackToPass,
  findLiteralTruePass,
  findConstructorCwdDropped,
  findAutoMatchNoExpectation,
  findSkipCountsAsPass,
} from './muffled-gate-scanner'
export type { MuffledFinding, MuffledFinder, ScanOptions } from './muffled-gate-scanner'

export { analyzeSeries } from './series-convergence'
export type { SeriesConvergenceOptions, SeriesConvergenceResult } from './series-convergence'

export {
  scoreContinuity,
  keyPreserved,
  collectionPreserved,
  statusAdvanced,
} from './state-continuity'
export type { ContinuityCheck, ContinuityCheckResult, ContinuityReport, ContinuitySnapshotPair } from './state-continuity'

// ── 0.4 trust surface ────────────────────────────────────────────────

export { Dataset, HoldoutLockedError, hashScenarios } from './dataset'
export type {
  DatasetScenario,
  DatasetProvenance,
  DatasetManifest,
  DatasetSplit,
  DatasetDifficulty,
  SliceOptions,
} from './dataset'

export { checkCanaries, canaryLeakView, HoldoutAuditor } from './contamination-guard'
export type { CanaryLeak } from './contamination-guard'

export {
  DEFAULT_RED_TEAM_CORPUS,
  redTeamDataset,
  redTeamReport,
  scoreRedTeamOutput,
  toolNamesForRun,
} from './red-team'
export type {
  RedTeamCategory,
  RedTeamPayload,
  RedTeamCase,
  RedTeamFinding,
  RedTeamReport,
} from './red-team'

export { requiredSampleSize, bonferroni, benjaminiHochberg } from './power-analysis'

export { expectAgent, runExpectations } from './behavior-dsl'
export type { MatcherResult, Expectation, BehaviorAssertion, CallExpectation } from './behavior-dsl'

export {
  calibrateJudge,
  positionalBias,
  verbosityBias,
  selfPreference,
} from './judge-calibration'
export type {
  GoldenItem,
  CandidateScore,
  CalibrationResult,
  PositionalBiasResult,
  VerbosityBiasResult,
  SelfPreferenceResult,
} from './judge-calibration'

export { evaluateContract, renderMarkdownReport } from './ci-gate'
export type { ContractMetric, ThresholdContract, ContractReport } from './ci-gate'

export {
  toLangfuseEnvelope,
  toPrometheusText,
  replayTraceThroughJudge,
} from './observability'
export type { LangfuseGeneration, LangfuseScore, LangfuseEnvelope, JudgeReplayResult } from './observability'

export {
  paraphraseRobustness,
  DEFAULT_MUTATORS,
  lowercaseMutator,
  sentenceReorderMutator,
  typoMutator,
  politenessPrefixMutator,
  whitespaceCollapseMutator,
} from './paraphrase'
export type { Mutator, RobustnessResult } from './paraphrase'

export { visualDiff, pixelDeltaRatio } from './visual-diff'
export type { ImageData, VisualDiffResult, VisualDiffOptions } from './visual-diff'

// ── builder-of-builders eval ─────────────────────────────────────────

export * from './builder-eval'

// ── 0.6 Tier 1 — meta-eval correlation, PRM, bisector ────────────────

export * from './meta-eval'
export * from './prm'
export {
  bisect,
  commitBisect,
  promptBisect,
} from './bisector'
export type { BisectOptions, BisectResult, BisectStep } from './bisector'

// ── 0.6 Tier 2 — counterfactual + cross-trace diff + pre-registration ─

export { runCounterfactual, attributeCounterfactuals } from './counterfactual'
export type {
  CounterfactualMutation,
  CounterfactualContext,
  CounterfactualResult,
  CounterfactualRunner,
} from './counterfactual'

export { crossTraceDiff } from './cross-trace-diff'
export type {
  AlignmentOp,
  StepAttribution,
  CrossTraceDiff,
  CrossTraceDiffOptions,
} from './cross-trace-diff'

export { signManifest, verifyManifest, evaluateHypothesis } from './pre-registration'
export type { HypothesisManifest, SignedManifest, HypothesisResult } from './pre-registration'

// ── 0.6 Tier 3 — self-play + causal + active learning + RM export ────

export { runSelfPlay } from './self-play'
export type {
  CandidateScenario,
  ScoredTarget,
  EvolutionRound,
  SelfPlayOptions,
  SelfPlayProposer,
  SelfPlayScorer,
} from './self-play'

export { causalAttribution } from './causal-attribution'
export type {
  FactorialCell,
  FactorContribution,
  InteractionContribution,
  CausalAttributionReport,
} from './causal-attribution'

export { proposeSynthesisTargets } from './active-learning'
export type { SynthesisTarget, SynthesisReason, ActiveLearningOptions } from './active-learning'

export {
  exportRewardModel,
  loadScorerFromGrader,
  replayScorerOverCorpus,
} from './reward-model-export'
export type { ExportedRewardModel, InferenceScorer } from './reward-model-export'

// ── 0.6 governance templates ─────────────────────────────────────────

export * from './governance'

// ── 0.8 extraction: LLM client, multi-layer verifier, semantic concept judge, error-count ─

export {
  callLlm,
  callLlmJson,
  probeLlm,
  stripFencedJson,
  LlmCallError,
  LlmClient,
} from './llm-client'
export type {
  LlmMessage,
  LlmCallRequest,
  LlmCallResult,
  LlmUsage,
  LlmClientOptions,
} from './llm-client'

export {
  MultiLayerVerifier,
  gradeSemanticStatus,
} from './multi-layer-verifier'

export { localCommandRunner } from './command-runner'
export type {
  CommandRunner,
  RunCommandInput,
  RunCommandResult,
  DirEntry,
} from './command-runner'

export { multiToolchainLayer, mergeLayerResults } from './multi-toolchain-layer'
export type {
  AdapterRun,
  MergeOptions,
  MultiToolchainLayerConfig,
} from './multi-toolchain-layer'

export { buildReviewerPrompt, createDefaultReviewer } from './reviewer'
export type {
  ReviewerMemoryEntry,
  ReviewerVerificationSummary,
  ReviewerPromptInput,
  ReviewerOutput,
  ReviewerSoftFailDefaults,
  CreateDefaultReviewerOptions,
} from './reviewer'
export type {
  Layer,
  LayerResult,
  LayerStatus,
  Severity,
  Finding,
  VerifyContext,
  VerifyOptions,
  VerificationReport,
} from './multi-layer-verifier'

export {
  runSemanticConceptJudge,
  createSemanticConceptJudge,
  SEMANTIC_CONCEPT_JUDGE_VERSION,
  DEFAULT_COMPLEXITY_WEIGHTS,
} from './semantic-concept-judge'

export {
  runIntentMatchJudge,
  createIntentMatchJudge,
  INTENT_MATCH_JUDGE_VERSION,
} from './intent-match-judge'
export type {
  IntentMatchInput,
  IntentMatchResult,
  IntentMatchOptions,
} from './intent-match-judge'

export { flowLayer } from './flow-layer'
export type {
  FlowAction,
  FlowStep,
  FlowSpec,
  FlowRunner,
  FlowRunnerStepResult,
  FlowLayerEnv,
  FlowLayerFactoryInput,
} from './flow-layer'

export { deployGateLayer, viteDeployRunner } from './deploy-gate-layer'
export type {
  DeployFamily,
  DeployRunResult,
  DeployRunner,
  DeployGateLayerInput,
  ViteDeployRunnerInput,
} from './deploy-gate-layer'

export {
  runKeywordCoverageJudge,
  runKeywordCoverageJudgeUrl,
  htmlContainsElement,
  extractAssetUrls,
} from './keyword-coverage-judge'
export type {
  KeywordConceptSpec,
  KeywordCoverageFinding,
  KeywordCoverageResult,
  KeywordCoverageOptions,
} from './keyword-coverage-judge'
export type {
  ConceptSpec,
  ConceptFinding,
  ConceptComplexity,
  ConceptWeightStrategy,
  SemanticConceptJudgeInput,
  SemanticConceptJudgeResult,
  SemanticConceptJudgeOptions,
} from './semantic-concept-judge'

export {
  extractErrorCount,
  ERROR_COUNT_PATTERNS,
} from './error-count-extractor'
export type {
  ErrorCountPattern,
  ExtractOptions,
  ExtractResult,
} from './error-count-extractor'

export {
  scoreReferenceReplay,
  compareReferenceReplay,
  decideReferenceReplayPromotion,
  defaultReferenceReplayMatcher,
} from './reference-replay'
export type {
  ReferenceReplayAggregate,
  ReferenceReplayCandidate,
  ReferenceReplayItem,
  ReferenceReplayMatch,
  ReferenceReplayMatcher,
  ReferenceReplayPromotionDecision,
  ReferenceReplayPromotionPolicy,
  ReferenceReplayScenario,
  ReferenceReplayScenarioScore,
  ReferenceReplayScore,
  ReferenceReplayScoreOptions,
  ReferenceReplaySplit,
  ReferenceReplaySplitComparison,
  ReferenceMatchResult,
} from './reference-replay'
