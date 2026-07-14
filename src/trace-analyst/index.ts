/** Ax RLM trace analyst over bounded OTLP-JSONL trace stores. */

export {
  contextInputTokens,
  LLM_CACHE_WRITE_TOKENS,
  LLM_CACHED_TOKENS,
  LLM_CONTEXT_TOKENS,
  LLM_COST_USD,
  LLM_INPUT_TOKENS,
  LLM_MODEL_NAME,
  LLM_OUTPUT_TOKENS,
  LLM_REASONING_TOKENS,
  OPENINFERENCE_SPAN_KIND,
  TOOL_NAME,
} from '../trace/otlp-attributes'
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
  asNumber,
  asString,
  extractOtlpAttributes,
  firstNumberAttr,
  firstStringAttr,
  inferOtlpKind,
  type ProjectedOtlpSpan,
  projectOtlpFlatLine,
  readOtlpStatus,
  stringField,
} from './otlp-span'
export {
  type OtlpToRunRecordsOptions,
  type OtlpTraceRunRecord,
  otlpRowsToRunRecords,
  otlpRowsToTraceRunRecords,
  otlpToRunRecords,
  otlpToTraceRunRecords,
  type TraceAggregate,
} from './otlp-to-run-records'
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
} from './types'
export {
  DEFAULT_TRACE_ANALYST_BUDGETS,
  TRACE_ANALYST_TRUNCATION_MARKER_PREFIX,
} from './types'
