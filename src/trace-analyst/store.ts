/**
 * `TraceAnalysisStore` — read-side interface the trace-analyst calls
 * through. Six operations, all bounded:
 *
 *   - `getOverview(filters?)` — dataset rollup + sample trace ids.
 *   - `queryTraces(filters?, limit, offset)` — paginated summaries.
 *   - `countTraces(filters?)` — cheap count without materialisation.
 *   - `viewTrace(trace_id, perAttrCap)` — full span list, oversized → summary.
 *   - `viewSpans(trace_id, span_ids, perAttrCap)` — surgical span fetch.
 *   - `searchTrace(trace_id, regex, max_matches)` — bounded regex hits.
 *   - `searchSpan(trace_id, span_id, regex, max_matches)` — single-span search.
 *
 * Multiple implementations ship in the core (`OtlpFileTraceStore`).
 * Downstream callers can supply their own — e.g. a DuckDB-backed
 * adapter or an in-memory adapter for tests — by implementing this
 * interface.
 *
 * Filters compose with AND semantics. Empty/undefined fields impose
 * no constraint. `regex_pattern` is the only opt-in raw-bytes scan —
 * implementations may skip it via `count`/`overview` when not set.
 */

import type {
  DatasetOverview,
  QueryTracesPage,
  SearchSpanResult,
  SearchTraceResult,
  TraceAnalystFilters,
  ViewSpansResult,
  ViewTraceResult,
} from './types'

export interface TraceAnalysisStore {
  getOverview(filters?: TraceAnalystFilters): Promise<DatasetOverview>

  queryTraces(opts: {
    filters?: TraceAnalystFilters
    limit: number
    offset?: number
  }): Promise<QueryTracesPage>

  countTraces(filters?: TraceAnalystFilters): Promise<number>

  viewTrace(opts: {
    trace_id: string
    /** Override per-attribute byte cap. Defaults to discovery budget. */
    per_attribute_byte_cap?: number
  }): Promise<ViewTraceResult>

  viewSpans(opts: {
    trace_id: string
    span_ids: readonly string[]
    /** Override per-attribute byte cap. Defaults to surgical budget. */
    per_attribute_byte_cap?: number
  }): Promise<ViewSpansResult>

  searchTrace(opts: {
    trace_id: string
    regex_pattern: string
    /** Hard cap on matches returned. Default 50. */
    max_matches?: number
  }): Promise<SearchTraceResult>

  searchSpan(opts: {
    trace_id: string
    span_id: string
    regex_pattern: string
    max_matches?: number
  }): Promise<SearchSpanResult>
}

/** Compile a regex with the same anchoring + flags semantics across
 *  implementations. Throws on invalid pattern — callers should surface
 *  that to the agent so it can refine instead of looping. */
export function compileSearchRegex(pattern: string): RegExp {
  // Multiline + case-sensitive by default. Agents that want
  // case-insensitivity opt in via `(?i)` inline flag.
  return new RegExp(pattern, 'm')
}

/** Truncate string payload deterministically for tool responses.
 *  Marker is parseable so downstream consumers can detect truncation
 *  and decide whether to fetch surgically. */
export function truncateForBudget(value: string, byteCap: number): string {
  // We measure UTF-8 byte length conservatively via Buffer.byteLength;
  // for predictability the truncation point is in CHARS, never inside
  // a code point.
  const original = Buffer.byteLength(value, 'utf8')
  if (original <= byteCap) return value

  // Step back from the cap until we're at a valid char boundary.
  // Slice by char count proportional to byte ratio, then re-measure.
  const ratio = byteCap / original
  let cut = Math.max(0, Math.floor(value.length * ratio))
  while (cut > 0 && Buffer.byteLength(value.slice(0, cut), 'utf8') > byteCap) {
    cut -= 1
  }
  return `${value.slice(0, cut)}\n[trace-analyst truncated: original ${original} bytes]`
}
