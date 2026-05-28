/** Ax RLM trace analyst over bounded OTLP-JSONL trace stores. */

export type {
  AnalyzeTracesInput,
  AnalyzeTracesOptions,
  AnalyzeTracesResult,
  AnalyzeTracesTurnSnapshot,
} from './analyst'
export { analyzeTraces } from './analyst'
export type { TraceAnalystHookOptions } from './hook'
export { traceAnalystOnRunComplete } from './hook'
export type {
  TraceInsightContext,
  TraceInsightFinding,
  TraceInsightPanelRole,
  TraceInsightPromptInput,
  TraceInsightQualityGate,
  TraceInsightQuestion,
  TraceInsightReadiness,
  TraceInsightSuite,
  TraceInsightTask,
} from './insights'
export {
  buildTraceInsightContext,
  buildTraceInsightPrompt,
  defaultTraceInsightPanel,
  describeTraceInsightScope,
  domainEvidencePattern,
  inferDomainKeywords,
  planTraceInsightQuestions,
  scoreTraceInsightReadiness,
  tokenizeDomainWords,
} from './insights'
export {
  type FlattenOtlpOptions,
  flattenOtlpExportToNdjson,
  type OtlpFlatLine,
} from './otlp-flatten'
export {
  TRACE_ANALYST_ACTOR_DESCRIPTION,
  TRACE_ANALYST_ACTOR_DESCRIPTION_VERSION,
  TRACE_ANALYST_SUBAGENT_DESCRIPTION,
} from './prompts'
export type { TraceAnalysisStore } from './store'
export {
  OtlpFileTraceStore,
  type OtlpFileTraceStoreOptions,
  SpanNotFoundError,
  TraceFileMissingError,
  TraceNotFoundError,
} from './store-otlp'
export {
  buildTraceAnalystTools,
  traceAnalystFunctionGroup,
} from './tools'

export type {
  DatasetOverview,
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
} from './types'
export {
  DEFAULT_TRACE_ANALYST_BUDGETS,
  TRACE_ANALYST_TRUNCATION_MARKER_PREFIX,
} from './types'
