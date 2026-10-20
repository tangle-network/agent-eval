// ── analysis ──────────────────────────────────────────────────────────
// Reading results: core statistics, paired comparisons, insight
// reports, trace analysts, canned pipeline views, and knowledge readiness.

export type { ChatTraceEngineOptions } from '../analyst/chat-trace-engine'
export { createChatTraceEngine } from '../analyst/chat-trace-engine'
export type { DefaultAnalystRegistryOptions } from '../analyst/default-registry'
export { buildDefaultAnalystRegistry } from '../analyst/default-registry'

export type { DspyRlmTraceEngineOptions } from '../analyst/dspy-rlm-engine'
export { createDspyRlmTraceEngine } from '../analyst/dspy-rlm-engine'

export type { TraceAnalysisEngine, TraceAnalysisEngineResult } from '../analyst/engine'
export { DEFAULT_TRACE_ANALYST_OUTPUT_TOKENS } from '../analyst/engine'

export type {
  ExactAnalystRunEvent,
  ExactAnalystRunResult,
  ExactCapableAnalyst,
} from '../analyst/exact-types'

export type { RawAnalystFinding } from '../analyst/finding-signature'

export type { FindingSubject, FindingSubjectKind } from '../analyst/finding-subject'

export type { DiffPolicy, FindingsDiff, PersistedFinding } from '../analyst/findings-store'
export { diffFindings, FindingsStore } from '../analyst/findings-store'

export type { CreateTraceAnalystOptions, TraceAnalystDefinition } from '../analyst/kind-factory'
export { createTraceAnalyst } from '../analyst/kind-factory'

export { DEFAULT_TRACE_ANALYST_KINDS, FAILURE_MODE_KIND_SPEC } from '../analyst/kinds'
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
} from '../analyst/policy-edit'
export {
  admitPolicyEdit,
  applyPolicyEditToSurface,
  computePolicyEditId,
  makePolicyEdit,
  makePolicyEditCandidateRecord,
  POLICY_EDIT_CANDIDATE_RECORD_SCHEMA,
  PolicyEditValidationError,
  policyEditsFromFindings,
  validatePolicyEdit,
  validatePolicyEditCandidateRecord,
} from '../analyst/policy-edit'
export type {
  AnalystRegistryOptions,
  BudgetPolicy,
  ExactRegistryRunOpts,
  RegistryRunOpts,
} from '../analyst/registry'
export { AnalystRegistry } from '../analyst/registry'
export { assertNoJudgeVerdict } from '../analyst/steer-firewall'

export type {
  Analyst,
  AnalystContext,
  AnalystFinding,
  AnalystRunEvent,
  AnalystRunInputs,
  AnalystRunResult,
  AnalystRunSummary,
  AnalystSeverity,
  AnalystUsageReceipt,
  EvidenceRef,
  ProposalFinding,
} from '../analyst/types'
export { computeFindingId, makeFinding, makeProposalFinding } from '../analyst/types'
export type { WelchTestResult, WelchTestStatus } from '../baseline'
export { iqr, welchsTTest } from '../baseline'

export type { BenchmarkEvaluation } from '../benchmarks/types'

export type {
  AssertCapabilityHeadroomOptions,
  CapabilityHeadroomOptions,
  CapabilityHeadroomResult,
  HeadroomInput,
  TaskHeadroom,
} from '../capability-headroom'
export { assertCapabilityHeadroom, capabilityHeadroom } from '../capability-headroom'

export type { CostEntry, CostSummary, ScenarioCost } from '../cost-tracker'
export { CostTracker } from '../cost-tracker'

export type {
  DetectorEvent,
  DetectorSignal,
  ErrorStreakOptions,
  RepeatedActionOptions,
  StreamingDetector,
} from '../detectors'
export { errorStreakDetector, observeAll, repeatedActionDetector } from '../detectors'

export type { ErrorCountPattern, ExtractOptions, ExtractResult } from '../error-count-extractor'
export { ERROR_COUNT_PATTERNS, extractErrorCount } from '../error-count-extractor'

export type {
  FailureBlame,
  FailureClass,
  FailureClassification,
  FailureContext,
  FailureReasonRule,
  FailureRule,
} from '../failure-taxonomy'
export {
  classifyFailure,
  classifyFailureReason,
  DEFAULT_FAILURE_REASON_RULES,
  FAILURE_BLAME,
  FAILURE_CLASSES,
  failureBlame,
  INFRA_FAILURE_BLAMES,
} from '../failure-taxonomy'

export {
  acquisitionPlansForKnowledgeGaps,
  blockingKnowledgeEval,
  knowledgeReadinessTracePayload,
  scoreKnowledgeReadiness,
  userQuestionsForKnowledgeGaps,
} from '../knowledge/readiness'

export type {
  DataAcquisitionPlan,
  KnowledgeAcquisitionMode,
  KnowledgeFreshness,
  KnowledgeImportance,
  KnowledgeReadinessReport,
  KnowledgeRequirement,
  KnowledgeRequirementCategory,
  KnowledgeSensitivity,
  UserQuestion,
} from '../knowledge/types'

export type { LeaderboardOptions, LeaderboardRow } from '../leaderboard'
export { leaderboard } from '../leaderboard'

export {
  estimateCost,
  estimateTokens,
  isModelPriced,
  MODEL_PRICING,
  resolveModelPricing,
} from '../metrics'

export type {
  ComparePairedArmsOptions,
  MatchedPair,
  MatchedRunRecordPair,
  PairArmsOptions,
  PairArmsResult,
  PairedArmRow,
  PairedArmsComparison,
  PairedCorrectness,
  PairedMetricDelta,
  PairRunRecordsResult,
} from '../paired-arms'
// pairArms stays a root export: published agent-knowledge dists (7.0.x)
// import it from the package root at ESM link time.
export { comparePairedArms, pairArms, pairRunRecords } from '../paired-arms'

export type { PairedDeltaTestOptions, PairedDeltaTestResult } from '../paired-delta-test'
export { minimumPairsForPairedDeltaTest, pairedDeltaTest } from '../paired-delta-test'
export type { Objective, ParetoResult } from '../pareto'
export { dominates, paretoFrontier } from '../pareto'
export type {
  HeldOutPartition,
  PartitionHeldOutOptions,
  TrainSelectionTestOptions,
  TrainSelectionTestPartition,
} from '../partition-held-out'
export { partitionHeldOut, partitionTrainSelectionTest } from '../partition-held-out'
export { budgetBreachView } from '../pipelines/budget-breach'
export { failureClusterView } from '../pipelines/failure-cluster'
export { judgeAgreementView } from '../pipelines/judge-agreement'
export { toolWasteView } from '../pipelines/tool-waste'
export type {
  ProductBenchmarkExportOptions,
  ProductBenchmarkExportResult,
  ProductBenchmarkManifest,
  ProductBenchmarkSingleRunExportOptions,
  ProductBenchmarkSplit,
  ProductBenchmarkValidationReport,
} from '../product-benchmark/index'
export {
  assertProductBenchmarkRun,
  exportProductBenchmark,
  exportProductBenchmarkRuns,
  productBenchmarkRepoIdentity,
  readProductBenchmarkManifest,
} from '../product-benchmark/index'
export type {
  ProjectRuntimeTrajectoryEvidenceOptions,
  RuntimeTrajectoryEvidenceProjection,
  RuntimeTrajectoryEvidenceSummary,
  RuntimeTrajectoryHookEvent,
  RuntimeTrajectoryRecord,
  RuntimeTrajectoryRunRecord,
} from '../runtime-trajectory'
export { projectRuntimeTrajectoryEvidence } from '../runtime-trajectory'

export type { SeriesConvergenceOptions, SeriesConvergenceResult } from '../series-convergence'
export { analyzeSeries } from '../series-convergence'

export type {
  CliffsMagnitude,
  CorpusAgreementOptions,
  CorpusAgreementPerDimension,
  CorpusAgreementReport,
  CorpusScoreRecord,
  EProcess,
  EProcessOptions,
  EProcessState,
  EProcessStep,
  ExactRiskDifferenceResult,
  MannWhitneyResult,
  McNemarResult,
  PairedBootstrapOptions,
  PairedBootstrapResult,
  PairedSignTestResult,
  PairedTTestResult,
  ProportionInterval,
  RankTestMethod,
  RankTestMethodRequest,
  RankTestOptions,
  RiskDifferenceResult,
  ScoreRiskDifferenceResult,
  SeriesDistribution,
  SignTestAlternative,
  WeightedCompositeInput,
  WeightedCompositeResult,
  WilcoxonSignedRankResult,
} from '../statistics'
export {
  BOOTSTRAP_GATE_MIN_N,
  benjaminiHochberg,
  bonferroni,
  cliffsDelta,
  cohensD,
  confidenceInterval,
  corpusInterRaterAgreement,
  corpusInterRaterAgreementFromJudgeScores,
  DECISION_PAIRED_DELTA_STATISTIC,
  eProcess,
  holm,
  interpretCliffs,
  interRaterReliability,
  isBinaryOutcomeVector,
  mannWhitneyU,
  mcnemar,
  mcnemarPower,
  mcnemarRequiredN,
  mulberry32,
  pairedBinaryScale,
  pairedBootstrap,
  pairedCohensDz,
  pairedDeltaTieFraction,
  pairedMde,
  pairedRiskDifference,
  pairedRiskDifferenceExact,
  pairedRiskDifferenceScore,
  pairedSignTest,
  pairedTTest,
  partialCredit,
  passAtK,
  pearsonR,
  ranks,
  requiredPairedSampleSize,
  requiredSampleSize,
  spearmanR,
  summarizeNumberSeries,
  weightedComposite,
  weightedMean,
  wilcoxonSignedRank,
  wilson,
} from '../statistics'

export type {
  GainDistributionBin,
  GainDistributionFigureSpec,
  GainDistributionOptions,
  ParetoPoint,
  ResearchReport,
  ResearchReportOptions,
  SummaryTable,
  SummaryTableOptions,
  SummaryTableRow,
} from '../summary-report'
export { gainHistogram, summaryTable } from '../summary-report'

export type { ToolStats, ToolUseMetrics, ToolUseOptions } from '../tool-use-metrics'
export { computeToolUseMetrics } from '../tool-use-metrics'

export type { AnalyzeTracesResult } from '../trace-analyst/analyst'
export { analyzeTraces } from '../trace-analyst/analyst'

export type { TraceInsightReadiness, TraceInsightSuite } from '../trace-analyst/insights'
export {
  buildTraceInsightContext,
  buildTraceInsightPrompt,
  describeTraceInsightScope,
  domainEvidencePattern,
  inferDomainKeywords,
  scoreTraceInsightReadiness,
  tokenizeDomainWords,
} from '../trace-analyst/insights'

export type { TraceAnalysisStore } from '../trace-analyst/store-contract'
export { OtlpFileTraceStore } from '../trace-analyst/store-otlp'
export { toolSpansToTraceAnalysisStore } from '../trace-analyst/store-tool-spans'
export type {
  DatasetOverview,
  ErrorCluster,
  QueryTracesPage,
  SearchSpanResult,
  SearchTraceResult,
  SpanMatchRecord,
  TraceAnalystByteBudgets,
  TraceAnalystFilters,
  TraceAnalystSpan,
  TraceAnalystSpanKind,
  TraceAnalystSpanStatus,
  TraceAnalystTraceSummary,
  ViewSpansResult,
  ViewTraceOversized,
  ViewTraceResult,
} from '../trace-analyst/types'
export {
  DEFAULT_TRACE_ANALYST_BUDGETS,
  TRACE_ANALYST_TRUNCATION_MARKER_PREFIX,
} from '../trace-analyst/types'
