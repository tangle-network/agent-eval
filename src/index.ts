// Core types
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

// Client
export { ProductClient, runE2EWorkflow } from './client'

// Judges
export {
  createDomainExpertJudge,
  codeExecutionJudge,
  coherenceJudge,
  adversarialJudge,
  createCustomJudge,
  defaultJudges,
} from './judges'

// Executor
export { executeScenario } from './executor'
export type { ExecutorConfig } from './executor'

// Benchmark
export { BenchmarkRunner } from './benchmark'

// Metrics
export { MetricsCollector, TokenCounter, estimateTokens, estimateCost, MODEL_PRICING } from './metrics'

// Statistics
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

// Convergence
export { ConvergenceTracker } from './convergence'

// Registry
export { ScenarioRegistry } from './registry'

// Driver
export { AgentDriver } from './driver'
export type { AgentDriverConfig } from './driver'

// Reporter
export {
  formatBenchmarkReport,
  formatDriverReport,
  printDriverSummary,
} from './reporter'

// ── 0.2 framework primitives ──

export { PromptRegistry, hashContent } from './prompt-registry'
export type { PromptHandle } from './prompt-registry'

export { MemoryTraceStore, FileSystemTraceStore } from './trace-store'
export type {
  LlmTrace,
  TraceStore,
  TraceQuery,
  FileSystemTraceStoreOptions,
} from './trace-store'

export { createAntiSlopJudge, analyzeAntiSlop } from './anti-slop'
export type {
  AntiSlopConfig,
  AntiSlopIssue,
  AntiSlopReport,
  SlopCategory,
} from './anti-slop'

export {
  composeValidators,
  regexMatch,
  jsonHasKeys,
  byteLengthRange,
  containsAll,
} from './artifact-validator'
export type {
  Artifact,
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
export type {
  Experiment,
  ExperimentStore,
  Run,
  RunConfig,
  RunDiff,
} from './experiment-tracker'

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
