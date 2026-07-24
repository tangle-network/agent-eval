/**
 * App-facing evaluation and improvement API.
 *
 * Start with `defineAgentEval()` when one agent, case set, judge, and starting
 * surface belong together. Use `runEval()` for one measurement,
 * `runImprovementLoop()` with a caller-owned `SurfaceProposer`, or pass an
 * official `OptimizationMethod` to `selfImprove()`.
 *
 * Import lower-level campaign controls from `@tangle-network/agent-eval/campaign`.
 * Import reporting, trace, benchmark, and training-data APIs from their named
 * package subpaths.
 */

// ── Types: scenarios, dispatch, judges, gates, surfaces ──────────────

// App-facing alias. `DispatchFn` remains the internal campaign type name;
// `/contract` exports it as `Dispatch`.
export type {
  CampaignAggregates,
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignResult,
  CampaignTraceWriter,
  CodeSurface,
  DispatchContext,
  DispatchFn as Dispatch,
  Gate,
  GateContext,
  GateDecision,
  GateResult,
  GenerationCandidate,
  GenerationRecord,
  JudgeConfig,
  JudgeDimension,
  JudgeScore,
  MutableSurface,
  OptimizationProposer,
  OptimizerConfig,
  Scenario,
  SessionScript,
  SurfaceProposer,
} from '../campaign/types'

// ── Campaign primitives ──────────────────────────────────────────────

export { campaignSplitDigest } from '../campaign/coverage'
export { type RunEvalOptions, runEval } from '../campaign/presets/run-eval'
export {
  type RunImprovementLoopOptions,
  type RunImprovementLoopResult,
  runImprovementLoop,
} from '../campaign/presets/run-improvement-loop'
export {
  type CampaignCellFailureReceipt,
  type RunCampaignOptions,
  runCampaign,
} from '../campaign/run-campaign'

// ── Reference-answer judge ───────────────────────────────────────────

export {
  type ChatClient,
  type CreateChatClientOpts,
  createChatClient,
} from '../analyst/chat-client'
export type { LlmJudgeDimension, LlmJudgeOptions } from '../llm-judge'
export { llmJudge } from '../llm-judge'
export type {
  ReferenceEquivalenceJudgeInput,
  ReferenceEquivalenceJudgeOptions,
  ReferenceEquivalenceJudgeResult,
  ReferenceEquivalenceScenario,
} from '../reference-equivalence-judge'
export {
  createReferenceEquivalenceJudge,
  REFERENCE_EQUIVALENCE_INPUT_LIMITS,
  REFERENCE_EQUIVALENCE_JUDGE_VERSION,
  runReferenceEquivalenceJudge,
} from '../reference-equivalence-judge'

// ── Proposers ────────────────────────────────────────────────────────

export {
  type ExternalOptimizationExample,
  type ExternalTextEvaluationResponse,
  type ExternalTextOptimizationMethodConfig,
  type ExternalTextOptimizerContext,
  type ExternalTextOptimizerResult,
  externalTextOptimizationMethod,
} from '../campaign/external-text-optimization'
export {
  type GepaAdaptiveEngineRun,
  type GepaEngineOptions,
  type GepaEngineRun,
  type GepaOptimizationMethodConfig,
  type GepaOptimizationRecipe,
  type GepaRunnerCommand,
  gepaOptimizationMethod,
} from '../campaign/gepa-optimization-method'
export type {
  OpenAICompatibleOptimizerModel,
  OptimizerModelBudget,
} from '../campaign/optimizer-model'
export {
  type CompareOptimizationMethodsOptions,
  type ComparisonCost,
  compareOptimizationMethods,
  type OptimizationMethod,
  type OptimizationMethodComparison,
  type OptimizationMethodInput,
  type OptimizationMethodProvenance,
  type OptimizationMethodResult,
  type OptimizationPackageSource,
  type OptimizationTokenUsage,
} from '../campaign/presets/compare-optimization-methods'
export {
  type SkillOptOptimizationMethodConfig,
  type SkillOptRunnerCommand,
  type SkillOptTrainerConfig,
  skillOptOptimizationMethod,
} from '../campaign/skillopt-optimization-method'

// ── Gates ────────────────────────────────────────────────────────────

export { composeGate } from '../campaign/gates/compose'
export {
  type DefaultProductionGateOptions,
  defaultProductionGate,
} from '../campaign/gates/default-production-gate'
export { type HeldOutGateOptions, heldOutGate } from '../campaign/gates/heldout-gate'
export {
  type AxisEvidence,
  type AxisVerdict,
  type BuildEvidenceVectorOptions,
  buildEvidenceVector,
  type EvidenceVector,
  type ObjectiveSource,
  type ParetoSignificanceGateOptions,
  type PromotionObjective,
  type PromotionPolicy,
  paretoPolicy,
  paretoSignificanceGate,
} from '../campaign/gates/promotion-policy'

// ── Storage backends ─────────────────────────────────────────────────

export {
  type CampaignStorage,
  fsCampaignStorage,
  inMemoryCampaignStorage,
} from '../campaign/storage'

// ── Deployment outcome store (predictive-validity calibration) ───────

export {
  type DeploymentOutcome,
  FileSystemOutcomeStore,
  type FileSystemOutcomeStoreOptions,
  InMemoryOutcomeStore,
  type OutcomeStore,
} from '../meta-eval/outcome-store'

// ── One-shot helper ─────────────────────────────────────────────────

export type { HostedTenant } from '../hosted/client'
export {
  type AgentEvalAgent,
  type AgentEvalEvaluateOptions,
  type AgentEvalImproveOptions,
  type DefineAgentEvalOptions,
  type DefinedAgentEval,
  defineAgentEval,
} from './define-agent-eval'
export {
  type CandidateExperimentExecutionInput,
  type CompareCandidateExperimentOptions,
  measuredComparisonFromCandidateExperiment,
  type RunCandidateExperimentOptions,
  runCandidateExperiment,
  type SealCandidateBenchmarkSuiteOptions,
  sealCandidateBenchmarkSuite,
  sealCandidateBenchmarkTask,
  sealCandidateExperiment,
  verifyCandidateBenchmarkSuite,
  verifyCandidateBenchmarkSuiteInputs,
  verifyCandidateBenchmarkTask,
  verifyCandidateExperiment,
  verifyCandidateExperimentComparison,
} from './measured-comparison'
export {
  type SelfImproveBudget,
  type SelfImproveOptions,
  type SelfImproveProgressEvent,
  type SelfImproveResult,
  SelfImproveRunError,
  selfImprove,
} from './self-improve'

// ── Analysis: turn observed runs into an actionable decision packet ──
// The rigor layer — paired bootstrap lift, judge stats, inter-rater
// agreement, contamination, failure clustering, outcome correlation,
// recommendations. `selfImprove()` consumers (closed loop) and
// `analyzeRuns()` direct callers (observed runs, no loop) get the same
// `InsightReport` shape.

// The stable analyst entry: build the canonical registry (feeds
// `AnalyzeRunsOptions.analyst` → `failureClusters`) and read its findings.
// The full analyst machinery stays under `@tangle-network/agent-eval/analyst`.
export {
  buildDefaultAnalystRegistry,
  type DefaultAnalystRegistryOptions,
} from '../analyst/default-registry'
export type { AnalystFinding } from '../analyst/types'
export type { AnalyzeRunsOptions, ExecutionReport, SummarizeExecutionOptions } from './analyze-runs'
export { analyzeRuns, summarizeExecution } from './analyze-runs'
// One-call reporting suite: runs (or a run dir/file) → `analyzeRuns` →
// optional `analysis.json`. Thin composition over `analyzeRuns` +
// `fromRunRecordDir`; adds no analysis logic of its own.
export {
  type EvalReportingSuiteInput,
  type EvalReportingSuiteOptions,
  type EvalReportingSuiteResult,
  evalReportingSuite,
} from './eval-reporting-suite'
export type {
  CostProvenanceSummary,
  ExecutionInsight,
  FailureClusterInsight,
  InsightReport,
  InterRaterInsight,
  JudgeInsight,
  LiftInsight,
  OutcomeCorrelationInsight,
  Recommendation,
  ReleaseSummary,
  ScalarDistribution,
  TokenUsageInsight,
} from './insight-report'

// ── Run-to-run diff (compare two eval runs, or a run's baseline→winner) ──

export {
  diffGenerations,
  diffRunBaselineToWinner,
  diffRuns,
  type EvalCellScoreDelta,
  type EvalDimensionDelta,
  type EvalGenerationDiff,
  type EvalRunDiff,
} from './diff'

// ── Intake: external data sources → RunRecord[] for analyzeRuns() ────
// Adapters that meet customers where their data already lives. Pipe the
// output straight into `analyzeRuns({ runs })`.

export type { CostLedgerHandle } from '../cost-ledger'
export {
  type AgentTraceContributor,
  type AgentTraceContributorType,
  type AgentTraceConversation,
  type AgentTraceFile,
  type AgentTraceIndex,
  type AgentTraceRange,
  type AgentTraceRecord,
  type AuthoringProvenance,
  type CodeAgentSessionAction,
  type CodeAgentSessionActionKind,
  type CodeAgentSessionActionStatus,
  type CodeAgentSessionActionSurface,
  type CodeAgentSessionDiagnostic,
  type CodeAgentSessionExecutionReceipt,
  type CodeAgentSessionIntakeOptions,
  type CodeAgentSessionIntakeResult,
  type CodeAgentSessionMetrics,
  type CodeAgentSessionObservation,
  type CodeAgentSessionSource,
  type CodeAgentSessionTerminalStatus,
  type FeedbackTableMeta,
  type FeedbackTableRow,
  type FromFeedbackTableOptions,
  type FromFeedbackTableResult,
  type FromOtelSpansOptions,
  type FromRunRecordDirOptions,
  type FromRunRecordDirResult,
  fromClaudeCodeSession,
  fromCodexSession,
  fromFeedbackTable,
  fromKimiCodeSession,
  fromOpenCodeSession,
  fromOtelSpans,
  fromPigraphSession,
  fromPiSession,
  fromRunRecordDir,
  observeCodeAgentSession,
  type ParsedCodeAgentJsonl,
  type PartitionByAuthoringModelResult,
  parseAgentTrace,
  parseCodeAgentJsonl,
  partitionRunsByAuthoringModel,
  type RunRecordRejection,
} from './intake'
