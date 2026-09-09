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

/** Byte window in the decoded source field associated with one span attribute. */
export interface ReadSpanSourceInput {
  trace_id: string
  span_id: string
  attribute: string
  offset: number
  limit: number
  source_index?: number
}

export type ReadSpanSourceResult =
  | {
      status: 'unavailable'
      source_index: number
      trace_id: string
      span_id: string
      attribute: string
      reason: string
    }
  | {
      status: 'available'
      source_index: number
      trace_id: string
      span_id: string
      attribute: string
      text: string
      offset: number
      total_bytes: number
      next_offset: number | null
      source: {
        source_id: string
        source_sha256: string
        record_sha256: string
        field_locator: string
        value_encoding: 'utf8-string' | 'json'
      }
    }

/** The caller resolves authorized immutable sources; model requests contain no storage paths. */
export type SpanSourceReader = (
  input: ReadSpanSourceInput,
  context?: TraceAnalysisStoreContext,
) => Promise<ReadSpanSourceResult>

/**
 * Storage adapter for trace reads.
 *
 * Bind third-party implementations with `createBoundedTraceAnalysisStore()`.
 * The binding validates every input and result, applies byte limits, and
 * forwards one cancellation signal through existence checks and reads.
 */
export interface TraceAnalysisStore {
  /** Present only when the caller supplies access to original source records. */
  readSpanSource?: SpanSourceReader

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
