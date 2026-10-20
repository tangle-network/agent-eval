// ── formats ───────────────────────────────────────────────────────────
// Persisted data shapes: run records, cost ledger, scorecards,
// trajectories, and the trace corpus (schema, stores, capture, OTLP).

export { BudgetBreachError, BudgetGuard } from '../budget-guard'
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
} from '../cost-ledger'
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
} from '../cost-ledger'
export type {
  CounterfactualContext,
  CounterfactualMutation,
  CounterfactualResult,
  CounterfactualRunner,
} from '../counterfactual'
export { runCounterfactual } from '../counterfactual'
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
} from '../feedback-trajectory'
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
} from '../feedback-trajectory'
export type {
  JudgeScoresRecord,
  RunCostProvenance,
  RunJudgeMetadata,
  RunOutcome,
  RunRecord,
  RunSearchCoordinates,
  RunSplitTag,
  RunTaskFailure,
  RunTerminalOutcome,
  RunTokenUsage,
  RunTraceRef,
} from '../run-record'
export {
  isRunRecord,
  modelHasSnapshot,
  parseRunRecordSafe,
  RunRecordValidationError,
  runTaskScore,
  searchCellRunId,
  UNKNOWN_MODEL,
  validateRunRecord,
} from '../run-record'
export type { RunScore, RunScoreWeights } from '../run-score'
export { aggregateRunScore, clamp01 } from '../run-score'
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
} from '../scorecard'
export {
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  recordRuns,
  recordRunsToScorecard,
} from '../scorecard'
export { OUTPUT_VALUE } from '../trace/attribute-vocabulary'
export { captureFetchToRawSink } from '../trace/capture-fetch'
export type {
  CaptureErrorHandler,
  CaptureWrite,
  SpanHandle,
  TraceEmitterOptions,
} from '../trace/emitter'
export { TraceEmitter } from '../trace/emitter'
export type { ExtractedUsage } from '../trace/extract-usage'
export { extractUsage, extractUsageFromSse } from '../trace/extract-usage'
export type { RunIntegrityReport } from '../trace/integrity'
export { assertRunCaptured, RunIntegrityError } from '../trace/integrity'
export type { OtlpExport } from '../trace/otel'
export { exportRunAsOtlp } from '../trace/otel'
export type { OtlpFlatLine } from '../trace/otlp-flat'
export { argHash, judgeSpans, runsForScenario } from '../trace/query'
export type { RawProviderEvent, RawProviderSink } from '../trace/raw-provider-sink'
export { FileSystemRawProviderSink, NoopRawProviderSink } from '../trace/raw-provider-sink'
export type {
  RedactionProfile,
  RedactionReport,
  RedactOptions,
  ShareSafetyStatus,
  ShareSafetyVerdict,
} from '../trace/redact'
export {
  assessShareSafety,
  REDACTION_VERSION,
  redact,
  redactForShare,
  redactText,
  shareAllowed,
} from '../trace/redact'
export type {
  Artifact,
  BudgetLedgerEntry,
  BudgetSpec,
  LlmSpan,
  Run,
  RunCaptureReport,
  Span,
  ToolSpan,
  TraceEvent,
} from '../trace/schema'
export { isJudgeSpan, isLlmSpan, isToolSpan } from '../trace/schema'
export type { EventFilter, RunFilter, SpanFilter, TraceStore } from '../trace/store'
export { FileSystemTraceStore, InMemoryTraceStore } from '../trace/store'
export type {
  ArgumentCheck,
  ContractCheckResult,
  ContractLintFinding,
  ContractRule,
  ContractRuleExecution,
  ContractRun,
  ContractSpan,
  ContractStatus,
  ContractVerdict,
  OrderMode,
  RetryWrite,
  SpanPredicate,
  TraceContract,
  TraceContractSpec,
} from '../trace-contracts'
export {
  checkTraceContracts,
  compileTraceContractSpec,
  evaluateTraceContract,
  explainTraceContract,
  lintTraceContractSpec,
  traceContract,
} from '../trace-contracts'
export type { Trajectory, TrajectoryStep } from '../trajectory'
export { buildTrajectory } from '../trajectory'
