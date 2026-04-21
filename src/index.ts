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

export { DualAgentBench } from './dual-agent-bench'
export type {
  DualAgentBenchConfig,
  DualAgentScenario,
  DualAgentScenarioResult,
  DualAgentReport,
  DualAgentRound,
} from './dual-agent-bench'

// ── 0.3 trace-first chassis ──────────────────────────────────────────

export * from './trace'

// ── 0.3 producers ────────────────────────────────────────────────────

export { SandboxHarness, SubprocessSandboxDriver, DockerSandboxDriver, composeParsers, vitestTestParser, pytestTestParser, jestTestParser } from './sandbox-harness'
export type { HarnessConfig, SandboxDriver, SandboxResult, SandboxHarnessResult, TestOutputParser } from './sandbox-harness'

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
