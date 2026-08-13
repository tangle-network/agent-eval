/**
 * @packageDocumentation
 *
 * Root barrel, tiered: it re-exports only the symbols external consumers
 * import from the root specifier, the documented front doors, and the types
 * those symbols need. Everything else is reachable via its subpath only
 * (`/contract`, `/campaign`, `/analyst`, `/traces`, `/reporting`, `/rl`,
 * `/prm`, `/meta-eval`, `/wire`, `/testing`, ...).
 */

// ── contract ──────────────────────────────────────────────────────────
// Defining an eval: scenarios, judges, profiles, verdicts, and the
// defineAgentEval / selfImprove / analyzeRuns front doors.

export type { AgentProfile, HarnessType, ProfileAxisSpec } from './agent-profile'
export {
  agentProfileHash,
  agentProfileId,
  CODING_HARNESSES,
  expandProfileAxes,
  HARNESS_NATIVE_MODEL,
  harnessAxisOf,
} from './agent-profile'

export type {
  AgentProfileCell,
  AgentProfileCellInput,
  AgentProfileDimensionValue,
  AgentProfileJson,
  AgentProfileSourceInput,
} from './agent-profile-cell'
export {
  AGENT_PROFILE_KINDS,
  agentProfileCellHashMaterial,
  agentProfileCellKey,
  buildAgentProfileCell,
  groupRunsByAgentProfileCell,
  toAgentProfileJson,
  verifyAgentProfileCell,
} from './agent-profile-cell'

export type { AnalyzeRunsOptions } from './contract/analyze-runs'
export { analyzeRuns } from './contract/analyze-runs'

export type { DefineAgentEvalOptions, DefinedAgentEval } from './contract/define-agent-eval'
export { defineAgentEval } from './contract/define-agent-eval'

export type { InsightReport } from './contract/insight-report'

export type { SelfImproveOptions, SelfImproveResult } from './contract/self-improve'
export { selfImprove } from './contract/self-improve'

export type { DatasetManifest, DatasetScenario, DatasetSplit } from './dataset'
export * as profile from './profile/index'
export type {
  CheckResult,
  CompletionCriterion,
  DriverState,
  JudgeRubric,
  JudgeScore,
  PersonaConfig,
  ProductClientConfig,
  RouteMap,
  Scenario,
} from './types'
// One verdict vocabulary (docs/verdicts.md): every verification path lands
// in DefaultVerdict; `certification` names who certified — the strategy
// member, the exact checker, the unverified assumptions, and the evidence
// digest.
export type { DefaultVerdict, VerdictCertification } from './verdict'
export { certificationEvidenceDigest, equivalenceVerdict } from './verdict'
export type {
  CheckerIdentity,
  CheckerOutcome,
  EquivalenceArm,
  EquivalenceCheckDefinition,
  EquivalenceChecker,
  EquivalenceCheckerInput,
  EquivalenceCheckerResult,
  EquivalenceCheckSpec,
  EquivalenceObligation,
  EquivalenceObligationStatus,
  EquivalenceRecord,
  StrategyChecker,
  VerificationStrategyProfile,
  VerificationStrategySource,
} from './verification-strategy'
export {
  buildEquivalenceRecord,
  defineEquivalenceCheck,
  EquivalenceProtocolError,
  runEquivalenceCheck,
  VERIFICATION_STRATEGIES,
  VERIFICATION_STRATEGY_SOURCES,
} from './verification-strategy'

// ── formats ───────────────────────────────────────────────────────────
// Persisted data shapes: run records, cost ledger, scorecards,
// trajectories, and the trace corpus (schema, stores, capture, OTLP).

export { BudgetBreachError, BudgetGuard } from './budget-guard'
export type {
  ChannelRollup,
  CostChannel,
  CostLedgerFilter,
  CostLedgerHandle,
  CostLedgerOptions,
  CostLedgerPersistence,
  CostLedgerSummary,
  CostProvenance,
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
export type {
  CounterfactualContext,
  CounterfactualMutation,
  CounterfactualResult,
  CounterfactualRunner,
} from './counterfactual'
export { runCounterfactual } from './counterfactual'
export type {
  AnalystFeedbackTrajectoryOptions,
  AnalystFindingDigest,
  AnalystReviewDecision,
  AnalystReviewRequest,
  AnalystRunDigest,
  FeedbackArtifactType,
  FeedbackAttempt,
  FeedbackLabel,
  FeedbackLabelKind,
  FeedbackLabelSource,
  FeedbackOptimizerRow,
  FeedbackOutcome,
  FeedbackSplitPolicy,
  FeedbackTask,
  FeedbackTrajectory,
  FeedbackTrajectoryFilter,
  FeedbackTrajectoryStore,
  PreferenceMemoryEntry,
  ProposedSideEffect,
} from './feedback-trajectory'
export {
  analystFindingDigest,
  analystRunDigest,
  analystRunToFeedbackTrajectory,
  analystRunToReviewRequests,
  controlRunToFeedbackTrajectory,
  createFeedbackTrajectory,
  FileSystemFeedbackTrajectoryStore,
  feedbackTrajectoriesToDatasetScenarios,
  feedbackTrajectoriesToOptimizerRows,
  feedbackTrajectoryToOptimizerRow,
  InMemoryFeedbackTrajectoryStore,
  renderPreferenceMemoryMarkdown,
  summarizePreferenceMemory,
  withAssignedFeedbackSplit,
} from './feedback-trajectory'
export type {
  JudgeScoresRecord,
  RunCostProvenance,
  RunJudgeMetadata,
  RunOutcome,
  RunRecord,
  RunSplitTag,
  RunTaskFailure,
  RunTerminalOutcome,
  RunTokenUsage,
} from './run-record'
export {
  isRunRecord,
  modelHasSnapshot,
  parseRunRecordSafe,
  RunRecordValidationError,
  roundTripRunRecord,
  runTaskScore,
  UNKNOWN_MODEL,
  validateRunRecord,
} from './run-record'
export type { RunScore, RunScoreWeights } from './run-score'
export { aggregateRunScore, clamp01 } from './run-score'
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
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  recordRuns,
  recordRunsToScorecard,
} from './scorecard'
export { OUTPUT_VALUE } from './trace/attribute-vocabulary'
export { captureFetchToRawSink } from './trace/capture-fetch'
export type { SpanHandle } from './trace/emitter'
export { TraceEmitter } from './trace/emitter'
export type { ExtractedUsage } from './trace/extract-usage'
export { extractUsage, extractUsageFromSse } from './trace/extract-usage'
export type { RunIntegrityReport } from './trace/integrity'
export { assertRunCaptured, RunIntegrityError } from './trace/integrity'
export type { OtlpExport } from './trace/otel'
export { exportRunAsOtlp } from './trace/otel'
export type { OtlpFlatLine } from './trace/otlp-flat'
export { argHash, judgeSpans, runsForScenario } from './trace/query'
export type { RawProviderEvent, RawProviderSink } from './trace/raw-provider-sink'
export { FileSystemRawProviderSink, NoopRawProviderSink } from './trace/raw-provider-sink'
export type { RedactionRule } from './trace/redact'
export { DEFAULT_REDACTION_RULES, REDACTION_VERSION, redactString } from './trace/redact'
export type {
  Artifact,
  BudgetLedgerEntry,
  BudgetSpec,
  LlmSpan,
  Run,
  Span,
  ToolSpan,
  TraceEvent,
} from './trace/schema'
export { isJudgeSpan, isLlmSpan, isToolSpan } from './trace/schema'
export type { EventFilter, RunFilter, SpanFilter, TraceStore } from './trace/store'
export { FileSystemTraceStore, InMemoryTraceStore } from './trace/store'
export type {
  ContractCheckResult,
  ContractSpan,
  ContractVerdict,
  TraceContract,
} from './trace-contracts'
export { checkTraceContracts, traceContract } from './trace-contracts'
export type { Trajectory, TrajectoryStep } from './trajectory'
export { buildTrajectory } from './trajectory'

// ── engine ────────────────────────────────────────────────────────────
// Running evals: the campaign engine, rollout minting, execution
// drivers, and experiment bookkeeping.

export type { ActiveLearningOptions, SynthesisTarget } from './active-learning'
export { proposeSynthesisTargets } from './active-learning'

export type { CampaignCellFailureReceipt, RunCampaignOptions } from './campaign/run-campaign'
export { runCampaign } from './campaign/run-campaign'

export type { CampaignResult } from './campaign/types'

export { ProductClient } from './client'

export type { CommandRunner, DirEntry, RunCommandInput, RunCommandResult } from './command-runner'
export { localCommandRunner } from './command-runner'

export type {
  ControlActionOutcome,
  ControlBudget,
  ControlContext,
  ControlDecision,
  ControlEvalResult,
  ControlRunResult,
  ControlRuntimeConfig,
  ControlRuntimeError,
  ControlStep,
  StopDecision,
} from './control-runtime'
export { objectiveEval, runAgentControlLoop, subjectiveEval } from './control-runtime'

export type { DiscoveredPersona, DiscoverPersonasOptions } from './discover-personas'
export { discoverPersonas } from './discover-personas'

export type { DecideNextUserTurnOpts } from './driver'
export { decideNextUserTurn } from './driver'

export type {
  CampaignFactoryParams,
  CampaignIntegrityPolicy,
  CampaignRunContext,
  CampaignRunOutcome,
  CampaignScenario,
  CampaignVariant,
  EvalCampaignOptions,
  EvalCampaignResult,
  FailedRun,
} from './eval-campaign'
export { runEvalCampaign } from './eval-campaign'

export type {
  ExperimentRep,
  ExperimentStats,
  ImprovementThresholds,
  ImprovementVerdictResult,
} from './experiment-tracker'
export { computeExperimentStats, improvementVerdict } from './experiment-tracker'

export { canonicalize, hashJson } from './pre-registration'

export type {
  LlmReviewerConfig,
  ProposeFn,
  ProposeInput,
  ProposeOutput,
  ProposeReviewConfig,
  ProposeReviewReport,
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
export { runProposeReviewAsControlLoop } from './propose-review-control'

export type { ReflectionContext, ReflectionProposal, TrialTrace } from './reflective-mutation'
export { buildReflectionPrompt, parseReflectionResponse } from './reflective-mutation'

export type {
  ExperimentPlan,
  ExperimentResult,
  FailureMode,
  Researcher,
  SteeringChange,
} from './researcher'

export type {
  MintedRolloutLine,
  MintRolloutOptions,
  MintRolloutResult,
  ScorePreference,
} from './rollout/index'
export { mintRolloutRows } from './rollout/index'

export type {
  InterimReleaseConfidence,
  InterimReleaseConfidenceInput,
  PairedEvalueOptions,
  PairedEvalueSequence,
  PairedEvalueStep,
  SequentialDecision,
} from './sequential'
export { evaluateInterimReleaseConfidence, pairedEvalueSequence } from './sequential'

// ── analysis ──────────────────────────────────────────────────────────
// Reading results: core statistics, paired comparisons, insight
// reports, trace analysts, canned pipeline views, and knowledge readiness.

export type { DefaultAnalystRegistryOptions } from './analyst/default-registry'
export { buildDefaultAnalystRegistry } from './analyst/default-registry'

export type { DspyRlmTraceEngineOptions } from './analyst/dspy-rlm-engine'
export { createDspyRlmTraceEngine } from './analyst/dspy-rlm-engine'

export type { TraceAnalysisEngine, TraceAnalysisEngineResult } from './analyst/engine'

export type {
  ExactAnalystRunEvent,
  ExactAnalystRunResult,
  ExactCapableAnalyst,
} from './analyst/exact-types'

export type { RawAnalystFinding } from './analyst/finding-signature'

export type { FindingSubject, FindingSubjectKind } from './analyst/finding-subject'

export type { DiffPolicy, FindingsDiff, PersistedFinding } from './analyst/findings-store'
export { diffFindings, FindingsStore } from './analyst/findings-store'

export type { CreateTraceAnalystOptions, TraceAnalystDefinition } from './analyst/kind-factory'
export { createTraceAnalyst } from './analyst/kind-factory'

export { DEFAULT_TRACE_ANALYST_KINDS, FAILURE_MODE_KIND_SPEC } from './analyst/kinds'

export type {
  AnalystRegistryOptions,
  BudgetPolicy,
  ExactRegistryRunOpts,
  RegistryRunOpts,
} from './analyst/registry'
export { AnalystRegistry } from './analyst/registry'

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
} from './analyst/types'
export { computeFindingId, makeFinding, makeProposalFinding } from './analyst/types'

export { iqr } from './baseline'

export type { BenchmarkEvaluation } from './benchmarks/types'

export type {
  AssertCapabilityHeadroomOptions,
  CapabilityHeadroomOptions,
  CapabilityHeadroomResult,
  HeadroomInput,
  TaskHeadroom,
} from './capability-headroom'
export { assertCapabilityHeadroom, capabilityHeadroom } from './capability-headroom'

export type { CostEntry, CostSummary, ScenarioCost } from './cost-tracker'
export { CostTracker } from './cost-tracker'

export type {
  DetectorEvent,
  DetectorSignal,
  ErrorStreakOptions,
  RepeatedActionOptions,
  StreamingDetector,
} from './detectors'
export { errorStreakDetector, observeAll, repeatedActionDetector } from './detectors'

export type { ErrorCountPattern, ExtractOptions, ExtractResult } from './error-count-extractor'
export { ERROR_COUNT_PATTERNS, extractErrorCount } from './error-count-extractor'

export type {
  FailureClass,
  FailureClassification,
  FailureContext,
  FailureRule,
} from './failure-taxonomy'
export { classifyFailure, FAILURE_CLASSES } from './failure-taxonomy'

export {
  acquisitionPlansForKnowledgeGaps,
  blockingKnowledgeEval,
  knowledgeReadinessTracePayload,
  scoreKnowledgeReadiness,
  userQuestionsForKnowledgeGaps,
} from './knowledge/readiness'

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
} from './knowledge/types'

export type { LeaderboardOptions, LeaderboardRow } from './leaderboard'
export { leaderboard } from './leaderboard'

export {
  estimateCost,
  estimateTokens,
  isModelPriced,
  MODEL_PRICING,
  resolveModelPricing,
} from './metrics'

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
} from './paired-arms'
// pairArms stays a root export: published agent-knowledge dists (7.0.x)
// import it from the package root at ESM link time.
export { comparePairedArms, pairArms, pairRunRecords } from './paired-arms'

export type { PairedDeltaTestOptions, PairedDeltaTestResult } from './paired-delta-test'
export { minimumPairsForPairedDeltaTest, pairedDeltaTest } from './paired-delta-test'
export type { Objective, ParetoResult } from './pareto'
export { dominates, paretoFrontier } from './pareto'
export type { HeldOutPartition, PartitionHeldOutOptions } from './partition-held-out'
export { partitionHeldOut } from './partition-held-out'
export { budgetBreachView } from './pipelines/budget-breach'
export { failureClusterView } from './pipelines/failure-cluster'
export { judgeAgreementView } from './pipelines/judge-agreement'
export { toolWasteView } from './pipelines/tool-waste'
export type {
  ProductBenchmarkExportOptions,
  ProductBenchmarkExportResult,
  ProductBenchmarkManifest,
  ProductBenchmarkSingleRunExportOptions,
  ProductBenchmarkSplit,
  ProductBenchmarkValidationReport,
} from './product-benchmark/index'
export {
  assertProductBenchmarkRun,
  exportProductBenchmark,
  exportProductBenchmarkRuns,
  productBenchmarkRepoIdentity,
  readProductBenchmarkManifest,
} from './product-benchmark/index'
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

export type { SeriesConvergenceOptions, SeriesConvergenceResult } from './series-convergence'
export { analyzeSeries } from './series-convergence'

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
  SignTestAlternative,
  WeightedCompositeInput,
  WeightedCompositeResult,
  WilcoxonSignedRankResult,
} from './statistics'
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
  DEFAULT_PERMUTATIONS,
  eProcess,
  holm,
  interpretCliffs,
  interRaterReliability,
  isBinaryOutcomeVector,
  MANN_WHITNEY_EXACT_MAX_STATES,
  MANN_WHITNEY_EXACT_MAX_WORK,
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
  WILCOXON_EXACT_MAX_N,
  weightedComposite,
  weightedMean,
  wilcoxonSignedRank,
  wilson,
} from './statistics'

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
} from './summary-report'
export { gainHistogram, summaryTable } from './summary-report'

export type { ToolStats, ToolUseMetrics, ToolUseOptions } from './tool-use-metrics'
export { computeToolUseMetrics } from './tool-use-metrics'

export type { AnalyzeTracesResult } from './trace-analyst/analyst'
export { analyzeTraces } from './trace-analyst/analyst'

export type { TraceInsightReadiness, TraceInsightSuite } from './trace-analyst/insights'
export {
  buildTraceInsightContext,
  buildTraceInsightPrompt,
  describeTraceInsightScope,
  domainEvidencePattern,
  inferDomainKeywords,
  scoreTraceInsightReadiness,
  tokenizeDomainWords,
} from './trace-analyst/insights'

export type { TraceAnalysisStore } from './trace-analyst/store-contract'
export { OtlpFileTraceStore } from './trace-analyst/store-otlp'
export { toolSpansToTraceAnalysisStore } from './trace-analyst/store-tool-spans'
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
} from './trace-analyst/types'
export {
  DEFAULT_TRACE_ANALYST_BUDGETS,
  TRACE_ANALYST_TRUNCATION_MARKER_PREFIX,
} from './trace-analyst/types'

// ── verification ──────────────────────────────────────────────────────
// Grading and gating: judges, completion verifiers,
// promotion/release gates, and capture-integrity checks.

export type { ActionExecutionPolicy, ActionPolicyDecision } from './action-policy'
export { evaluateActionPolicy } from './action-policy'

export type {
  CanaryAlert,
  CanaryEvaluation,
  CanaryKind,
  CanaryOptions,
  CanaryReport,
} from './canary'
export { runCanaries } from './canary'

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
  verifyCompletion,
} from './completion-verifier'

export type { CanaryLeak } from './contamination-guard'
export { checkCanaries } from './contamination-guard'

export type {
  DeployGateLayerInput,
  DeployRunner,
  DeployRunResult,
  ViteDeployRunnerInput,
  WranglerDeployRunnerInput,
} from './deploy-gate-layer'
export { deployGateLayer, viteDeployRunner, wranglerDeployRunner } from './deploy-gate-layer'

export type {
  GateDecision,
  GateEvidence,
  HeldOutGateConfig,
  HeldOutGateRejectionCode,
  SplitCoverage,
} from './held-out-gate'
export { HeldOutGate } from './held-out-gate'

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
  assertNoHiddenLeak,
  blendHeldout,
  defaultBlendWeights,
  gradeOnHidden,
  hiddenGrade,
  routeFields,
  withHeldoutBlend,
} from './hidden-criteria-grading'

export type { BackendIntegrityReport } from './integrity/backend-integrity'
export {
  assertRealBackend,
  BackendIntegrityError,
  summarizeBackendIntegrity,
} from './integrity/backend-integrity'

export type {
  AssertSingleBackendOptions,
  BackendDescriptor,
  SingleBackendDivergence,
  SingleBackendReport,
} from './integrity/single-backend'
export { assertSingleBackend } from './integrity/single-backend'

export type { IntentMatchInput, IntentMatchOptions, IntentMatchResult } from './intent-match-judge'
export { runIntentMatchJudge } from './intent-match-judge'

export type {
  CalibrationResult,
  CandidateScore,
  ContinuousAgreement,
  ContinuousAgreementOptions,
  ContinuousCalibrationResult,
  GoldenItem,
  VerbosityBiasResult,
} from './judge-calibration'
export {
  calibrateJudge,
  calibrateJudgeContinuous,
  continuousAgreement,
  verbosityBias,
} from './judge-calibration'

export type { EnsembleAggregate, JudgeVerdict } from './judge-ensemble'
export { aggregateJudgeVerdicts } from './judge-ensemble'

export type { AssertCrossFamilyOptions, JudgeFamily } from './judge-families'
export { assertCrossFamily, CrossFamilyError, judgeFamily } from './judge-families'

export type { EnsembleJudgeOptions } from './judge-panel'
export { ensembleJudge } from './judge-panel'

export type { JudgeRetryOutcome, JudgeRetryPolicy } from './judge-retry'
export { withJudgeRetry } from './judge-retry'

export type {
  KeywordConceptSpec,
  KeywordCoverageFinding,
  KeywordCoverageOptions,
  KeywordCoverageResult,
} from './keyword-coverage-judge'
export { runKeywordCoverageJudge, runKeywordCoverageJudgeUrl } from './keyword-coverage-judge'

export type { LlmJudgeOptions } from './llm-judge'
export { llmJudge } from './llm-judge'

export type {
  Layer,
  LayerResult,
  LayerStatus,
  Severity,
  VerificationReport,
  VerifyOptions,
} from './multi-layer-verifier'
export { gradeSemanticStatus, MultiLayerVerifier } from './multi-layer-verifier'

export type { Oracle, OracleObservation, OracleReport, OracleResult } from './oracle'
export {
  evaluateOracles,
  jsonShape,
  notBlocked,
  regexMatches,
  textInSnapshot,
  urlContains,
} from './oracle'

export type {
  PairedDecisionMethod,
  PairedDecisionShape,
  PairedDecisionStatistic,
  PairedMcNemarEvidence,
  PairedPromotionDecision,
  PairedPromotionDecisionOptions,
} from './paired-promotion-decision'
export { decidePairedPromotion } from './paired-promotion-decision'

export type {
  ArtifactEventLike,
  ProposalEventLike,
  RuntimeEventLike,
  ToolCallEventLike,
} from './produced-state'
export { extractProducedState } from './produced-state'

export type { BootstrapOptions, BootstrapResult, Verdict } from './promotion-gate'
export { bootstrapCi } from './promotion-gate'

export type { RedTeamCase, RedTeamCategory, RedTeamFinding, RedTeamReport } from './red-team'
export {
  DEFAULT_RED_TEAM_CORPUS,
  redTeamDataset,
  redTeamReport,
  scoreRedTeamOutput,
} from './red-team'

export type {
  ReleaseConfidenceInput,
  ReleaseConfidenceIssue,
  ReleaseConfidenceMetrics,
  ReleaseConfidenceScorecard,
  ReleaseTraceEvidence,
} from './release-confidence'
export { evaluateReleaseConfidence } from './release-confidence'

export type {
  ConceptFinding,
  ConceptSpec,
  SemanticConceptJudgeInput,
  SemanticConceptJudgeOptions,
  SemanticConceptJudgeResult,
} from './semantic-concept-judge'
export { runSemanticConceptJudge, SEMANTIC_CONCEPT_JUDGE_VERSION } from './semantic-concept-judge'

export type { TreatmentGate, TreatmentGateInput, TreatmentGateOptions } from './treatment-gate'
export { gateTreatmentApplied } from './treatment-gate'

export type { VerdictCacheStore } from './verdict-cache'
export { canonicalJson, contentHash, fileVerdictCache } from './verdict-cache'

// ── utilities ─────────────────────────────────────────────────────────
// Provider-neutral LLM clients and shared error types.

export type {
  ChatCallOpts,
  ChatClient,
  ChatRequest,
  ChatResponse,
  CreateChatClientOpts,
} from './analyst/chat-client'
export { createChatClient } from './analyst/chat-client'
export { analyzeAntiSlop, createAntiSlopJudge } from './anti-slop'
export type { AgentEvalErrorCode } from './errors'
export { AgentEvalError, ConfigError, JudgeError, NotFoundError, ValidationError } from './errors'
export type { RunRecordBackend } from './eval-trace-store'
export { jsonlRunRecordBackend } from './eval-trace-store'
export { assignFeedbackSplit } from './feedback-trajectory'
export { preflightModels } from './integrity/preflight'
export type { KnowledgeBundle } from './knowledge/types'
export type {
  LlmCallMetadata,
  LlmCallRequest,
  LlmCallResult,
  LlmClientOptions,
  LlmMessage,
  LlmRouteRequirements,
} from './llm-client'
export {
  assertLlmRoute,
  callLlm,
  callLlmJson,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  isTransientLlmError,
  LlmCallError,
  LlmClient,
  LlmResponseError,
  maximumChargeForLlmRequest,
  probeLlm,
  stripFencedJson,
} from './llm-client'
export type { ModelSeats } from './model-seats'
export { resolveSeat, seatPresets } from './model-seats'
export type { Finding } from './multi-layer-verifier'
export type { PromptHandle } from './prompt-registry'
export { hashContent, PromptRegistry } from './prompt-registry'
export type {
  ReferenceReplayCaseRun,
  ReferenceReplayRun,
  ReferenceReplaySplit,
} from './reference-replay'
export type { ActionableSideInfo } from './release-confidence'
export type { SandboxDriver } from './sandbox-harness'
export type { SteeringBundle } from './steering'
export type { SteeringOptimizationResult, SteeringOptimizationRow } from './steering-optimizer'
export { PairwiseSteeringOptimizer } from './steering-optimizer'
export { paretoChart } from './summary-report'
export type { OtlpSpan } from './trace/otel'
export { InMemoryRawProviderSink } from './trace/raw-provider-sink'
export type { GenericSpan, JudgeSpan, RunStatus } from './trace/schema'
export { createBoundedTraceAnalysisStore } from './trace-analyst/store'
export { otlpTextToTraceAnalysisStore } from './trace-analyst/store-otlp'
