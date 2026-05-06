/** Ax RLM trace analyst over bounded OTLP-JSONL trace stores. */

export { analyzeTraces } from './analyst'
export type {
  AnalyzeTracesInput,
  AnalyzeTracesOptions,
  AnalyzeTracesResult,
  AnalyzeTracesTurnSnapshot,
} from './analyst'

export {
  OtlpFileTraceStore,
  TraceFileMissingError,
  TraceNotFoundError,
  SpanNotFoundError,
  type OtlpFileTraceStoreOptions,
} from './store-otlp'

export type { TraceAnalysisStore } from './store'
export {
  buildTraceAnalystTools,
  traceAnalystFunctionGroup,
} from './tools'

export {
  TRACE_ANALYST_ACTOR_DESCRIPTION,
  TRACE_ANALYST_ACTOR_DESCRIPTION_VERSION,
  TRACE_ANALYST_SUBAGENT_DESCRIPTION,
} from './prompts'

export {
  buildTraceInsightPrompt,
  defaultTraceInsightPanel,
  describeTraceInsightScope,
  domainEvidencePattern,
  inferDomainKeywords,
  planTraceInsightQuestions,
  tokenizeDomainWords,
} from './insights'
export type {
  TraceInsightFinding,
  TraceInsightPanelRole,
  TraceInsightPromptInput,
  TraceInsightQuestion,
  TraceInsightSuite,
  TraceInsightTask,
} from './insights'

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
