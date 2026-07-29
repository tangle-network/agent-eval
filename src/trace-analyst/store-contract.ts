import type {
  DatasetOverview,
  QueryTracesPage,
  SearchSpanResult,
  SearchTraceResult,
  TraceAnalystByteBudgets,
  TraceAnalystFilters,
  ViewSpansResult,
  ViewTraceResult,
} from './types'

export const TRACE_ANALYSIS_LIMITS = {
  sampleTraceIds: 20,
  queryTraces: 200,
  viewSpans: 100,
  searchMatches: 500,
  filterValues: 100,
  identifierCharacters: 256,
  regexCharacters: 4_096,
  minimumTextBudget: 64,
} as const

export interface TraceAnalysisStoreContext {
  signal?: AbortSignal
}

/**
 * Storage adapter for trace reads.
 *
 * Bind third-party implementations with `createBoundedTraceAnalysisStore()`.
 * The binding validates every input and result, applies byte limits, and
 * forwards one cancellation signal through existence checks and reads.
 */
export interface TraceAnalysisStore {
  hasTrace(trace_id: string, context?: TraceAnalysisStoreContext): Promise<boolean>

  hasSpans(
    input: { trace_id: string; span_ids: readonly string[] },
    context?: TraceAnalysisStoreContext,
  ): Promise<string[]>

  getOverview(
    filters?: TraceAnalystFilters,
    context?: TraceAnalysisStoreContext,
  ): Promise<DatasetOverview>

  queryTraces(
    input: { filters?: TraceAnalystFilters; limit: number; offset?: number },
    context?: TraceAnalysisStoreContext,
  ): Promise<QueryTracesPage>

  countTraces(filters?: TraceAnalystFilters, context?: TraceAnalysisStoreContext): Promise<number>

  viewTrace(
    input: {
      trace_id: string
      per_attribute_byte_cap?: number
    },
    context?: TraceAnalysisStoreContext,
  ): Promise<ViewTraceResult>

  viewSpans(
    input: {
      trace_id: string
      span_ids: readonly string[]
      per_attribute_byte_cap?: number
    },
    context?: TraceAnalysisStoreContext,
  ): Promise<ViewSpansResult>

  searchTrace(
    input: {
      trace_id: string
      regex_pattern: string
      max_matches?: number
    },
    context?: TraceAnalysisStoreContext,
  ): Promise<SearchTraceResult>

  searchSpan(
    input: {
      trace_id: string
      span_id: string
      regex_pattern: string
      max_matches?: number
    },
    context?: TraceAnalysisStoreContext,
  ): Promise<SearchSpanResult>
}

export interface BoundedTraceAnalysisStoreOptions {
  budgets?: Partial<TraceAnalystByteBudgets>
}
