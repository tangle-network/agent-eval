import { RE2JS } from 're2js'

import {
  TraceAnalysisLimitError,
  TraceAnalysisStoreContractError,
  TraceAnalysisValidationError,
} from './errors'
import { TRACE_ANALYSIS_LIMITS } from './store-contract'
import type {
  DatasetOverview,
  QueryTracesPage,
  SearchSpanResult,
  SearchTraceResult,
  SpanMatchRecord,
  TraceAnalystByteBudgets,
  TraceAnalystSpan,
  ViewSpansResult,
  ViewTraceOversized,
  ViewTraceResult,
} from './types'
import { DEFAULT_TRACE_ANALYST_BUDGETS } from './types'

export function resolveTraceBudgets(
  overrides: Partial<TraceAnalystByteBudgets> | undefined,
): TraceAnalystByteBudgets {
  const budgets = { ...DEFAULT_TRACE_ANALYST_BUDGETS, ...overrides }
  validateInteger(budgets.perCallByteCeiling, 'perCallByteCeiling', 1)
  for (const name of [
    'perAttributeViewBudget',
    'perAttributeSpanBudget',
    'perMatchTextBudget',
  ] as const) {
    validateInteger(budgets[name], name, TRACE_ANALYSIS_LIMITS.minimumTextBudget)
  }
  return budgets
}

export function boundOverview(result: DatasetOverview, byteCeiling: number): DatasetOverview {
  if (result.sample_trace_ids.length > result.total_traces) {
    throw contractError('getOverview', 'sample_trace_ids contains more entries than total_traces')
  }
  if (result.errors.trace_count > result.total_traces) {
    throw contractError('getOverview', 'errors.trace_count exceeds total_traces')
  }
  return withinByteCeiling('getOverview', result, byteCeiling)
}

export function boundTracePage(
  result: QueryTracesPage,
  input: { limit: number; offset: number },
  byteCeiling: number,
): QueryTracesPage {
  if (result.traces.length > input.limit) {
    throw contractError(
      'queryTraces',
      `store returned ${result.traces.length} traces for limit ${input.limit}`,
    )
  }
  if (result.total < input.offset + result.traces.length) {
    throw contractError(
      'queryTraces',
      `total ${result.total} is smaller than the returned page ending at ${
        input.offset + result.traces.length
      }`,
    )
  }
  if (result.has_more !== input.offset + result.traces.length < result.total) {
    throw contractError(
      'queryTraces',
      'has_more does not match the returned page position and total',
    )
  }
  if (result.has_more && result.traces.length === 0) {
    throw contractError('queryTraces', 'store reported more traces without returning any progress')
  }

  const traces: QueryTracesPage['traces'] = []
  for (const trace of result.traces) {
    const candidate = { traces: [...traces, trace], total: result.total, has_more: true }
    if (encodedBytes('queryTraces', candidate) > byteCeiling) break
    traces.push(trace)
  }
  if (result.traces.length > 0 && traces.length === 0) {
    throw responseItemTooLarge(
      'queryTraces',
      { traces: [result.traces[0]], total: result.total, has_more: true },
      byteCeiling,
    )
  }
  return withinByteCeiling(
    'queryTraces',
    {
      traces,
      total: result.total,
      has_more: result.has_more || traces.length < result.traces.length,
    },
    byteCeiling,
  )
}

export function boundTraceView(
  result: ViewTraceResult,
  expectedTraceId: string,
  perAttributeCap: number,
  byteCeiling: number,
): ViewTraceResult {
  requireEqual('viewTrace', 'trace_id', result.trace_id, expectedTraceId)
  if (result.oversized) {
    return withinByteCeiling('viewTrace', result, byteCeiling)
  }

  const spans = result.spans!.map((span) => {
    requireEqual('viewTrace', 'span.trace_id', span.trace_id, expectedTraceId)
    return truncateSpanAttributes('viewTrace', span, perAttributeCap).span
  })
  const full = { trace_id: expectedTraceId, spans }
  if (encodedBytes('viewTrace', full) <= byteCeiling) return full
  return withinByteCeiling(
    'viewTrace',
    { trace_id: expectedTraceId, oversized: oversizedFromSpans(spans) },
    byteCeiling,
  )
}

export function boundSpansView(
  result: ViewSpansResult,
  expectedTraceId: string,
  requested: readonly string[],
  existingSpanIds: ReadonlySet<string>,
  perAttributeCap: number,
  byteCeiling: number,
): ViewSpansResult {
  requireEqual('viewSpans', 'trace_id', result.trace_id, expectedTraceId)
  const requestedSet = new Set(requested)
  const missing = checkedAccountingIds('missing_span_ids', result.missing_span_ids, requestedSet)
  const omitted = checkedAccountingIds('omitted_span_ids', result.omitted_span_ids, requestedSet)
  const missingSet = new Set(missing)
  const omittedSet = new Set(omitted)
  const expectedMissing = requested.filter((id) => !existingSpanIds.has(id))
  if (
    expectedMissing.length !== missing.length ||
    expectedMissing.some((id) => !missingSet.has(id))
  ) {
    throw contractError('viewSpans', 'missing_span_ids does not match the store existence checks')
  }
  if (result.has_more !== omitted.length > 0) {
    throw contractError(
      'viewSpans',
      'has_more must be true exactly when omitted_span_ids is non-empty',
    )
  }
  if (
    result.spans.length === 0 &&
    requested.some((id) => existingSpanIds.has(id) && omittedSet.has(id))
  ) {
    throw contractError(
      'viewSpans',
      'store omitted every existing requested span instead of returning progress or throwing a size error',
    )
  }

  const projected = new Map<string, { span: TraceAnalystSpan; truncations: number }>()
  for (const span of result.spans) {
    requireEqual('viewSpans', 'span.trace_id', span.trace_id, expectedTraceId)
    if (!requestedSet.has(span.span_id)) {
      throw contractError(
        'viewSpans',
        `store returned unrequested span ${JSON.stringify(span.span_id)}`,
      )
    }
    if (missingSet.has(span.span_id) || omittedSet.has(span.span_id)) {
      throw contractError(
        'viewSpans',
        `span ${JSON.stringify(span.span_id)} is both returned and unavailable`,
      )
    }
    if (projected.has(span.span_id)) {
      throw contractError(
        'viewSpans',
        `store returned duplicate span ${JSON.stringify(span.span_id)}`,
      )
    }
    projected.set(span.span_id, truncateSpanAttributes('viewSpans', span, perAttributeCap))
  }
  for (const id of requested) {
    if (!missingSet.has(id) && !omittedSet.has(id) && !projected.has(id)) {
      throw contractError(
        'viewSpans',
        `store did not account for requested span ${JSON.stringify(id)}`,
      )
    }
  }

  const spans: TraceAnalystSpan[] = []
  let addedTruncations = 0
  const build = (): ViewSpansResult => ({
    trace_id: expectedTraceId,
    spans,
    missing_span_ids: requested.filter((id) => missingSet.has(id)),
    omitted_span_ids: requested.filter((id) => omittedSet.has(id)),
    has_more: omittedSet.size > 0,
    truncated_attribute_count: result.truncated_attribute_count + addedTruncations,
  })
  withinByteCeiling('viewSpans', build(), byteCeiling)
  for (const id of requested) {
    const item = projected.get(id)
    if (!item) continue
    spans.push(item.span)
    omittedSet.delete(id)
    addedTruncations += item.truncations
    if (encodedBytes('viewSpans', build()) <= byteCeiling) continue
    spans.pop()
    omittedSet.add(id)
    addedTruncations -= item.truncations
  }
  if (projected.size > 0 && spans.length === 0) {
    const first = projected.values().next().value
    if (first) {
      throw responseItemTooLarge(
        'viewSpans',
        {
          trace_id: expectedTraceId,
          spans: [first.span],
          missing_span_ids: [],
          omitted_span_ids: [],
          has_more: false,
          truncated_attribute_count: result.truncated_attribute_count + first.truncations,
        },
        byteCeiling,
      )
    }
  }
  return withinByteCeiling('viewSpans', build(), byteCeiling)
}

export function boundTraceSearch(
  result: SearchTraceResult,
  expectedTraceId: string,
  maxMatches: number,
  budgets: TraceAnalystByteBudgets,
): SearchTraceResult {
  requireEqual('searchTrace', 'trace_id', result.trace_id, expectedTraceId)
  const bounded = boundSearchHits('searchTrace', result, maxMatches, budgets, (hit) => {
    requireEqual('searchTrace', 'hit.trace_id', hit.trace_id, expectedTraceId)
  })
  return { trace_id: expectedTraceId, ...bounded }
}

export function boundSpanSearch(
  result: SearchSpanResult,
  expectedTraceId: string,
  expectedSpanId: string,
  maxMatches: number,
  budgets: TraceAnalystByteBudgets,
): SearchSpanResult {
  requireEqual('searchSpan', 'trace_id', result.trace_id, expectedTraceId)
  requireEqual('searchSpan', 'span_id', result.span_id, expectedSpanId)
  const bounded = boundSearchHits('searchSpan', result, maxMatches, budgets, (hit) => {
    requireEqual('searchSpan', 'hit.trace_id', hit.trace_id, expectedTraceId)
    requireEqual('searchSpan', 'hit.span_id', hit.span_id, expectedSpanId)
  })
  return { trace_id: expectedTraceId, span_id: expectedSpanId, ...bounded }
}

function boundSearchHits(
  operation: 'searchTrace' | 'searchSpan',
  result: Pick<SearchTraceResult, 'hits' | 'has_more'>,
  maxMatches: number,
  budgets: TraceAnalystByteBudgets,
  validateHit: (hit: SpanMatchRecord) => void,
): Pick<SearchTraceResult, 'hits' | 'has_more'> {
  if (result.hits.length > maxMatches) {
    throw contractError(
      operation,
      `store returned ${result.hits.length} hits for max_matches ${maxMatches}`,
    )
  }
  if (result.has_more && result.hits.length === 0) {
    throw contractError(operation, 'store reported more matches without returning any progress')
  }

  const hits: SpanMatchRecord[] = []
  for (const raw of result.hits) {
    validateHit(raw)
    const hit = truncateMatchRecord(raw, budgets.perMatchTextBudget)
    const candidate = {
      hits: [...hits, hit],
      has_more: true,
    }
    if (encodedBytes(operation, candidate) > budgets.perCallByteCeiling) break
    hits.push(hit)
  }
  if (result.hits.length > 0 && hits.length === 0) {
    throw responseItemTooLarge(
      operation,
      {
        hits: [truncateMatchRecord(result.hits[0]!, budgets.perMatchTextBudget)],
        has_more: true,
      },
      budgets.perCallByteCeiling,
    )
  }
  return withinByteCeiling(
    operation,
    {
      hits,
      has_more: result.has_more || hits.length < result.hits.length,
    },
    budgets.perCallByteCeiling,
  )
}

function checkedAccountingIds(
  label: string,
  ids: readonly string[],
  requested: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>()
  for (const id of ids) {
    if (!requested.has(id)) {
      throw contractError('viewSpans', `${label} contains unrequested id ${JSON.stringify(id)}`)
    }
    if (seen.has(id)) {
      throw contractError('viewSpans', `${label} contains duplicate id ${JSON.stringify(id)}`)
    }
    seen.add(id)
  }
  return [...ids]
}

function truncateMatchRecord(record: SpanMatchRecord, cap: number): SpanMatchRecord {
  return {
    ...record,
    span_name: truncateForBudget(record.span_name, cap),
    attribute_path: truncateForBudget(record.attribute_path, cap),
    matched_text: truncateForBudget(record.matched_text, cap),
    context_before: truncateForBudget(record.context_before, cap),
    context_after: truncateForBudget(record.context_after, cap),
  }
}

function truncateSpanAttributes(
  operation: string,
  span: TraceAnalystSpan,
  cap: number,
): { span: TraceAnalystSpan; truncations: number } {
  const attributes: Record<string, unknown> = {}
  let truncations = 0
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === 'string') {
      const truncated = truncateForBudget(value, cap)
      if (truncated !== value) truncations += 1
      attributes[key] = truncated
      continue
    }
    if (value !== null && typeof value === 'object') {
      let json: string
      try {
        json = JSON.stringify(value)
      } catch (cause) {
        throw new TraceAnalysisStoreContractError(
          operation,
          `span attribute ${JSON.stringify(key)} is not JSON-serializable`,
          { cause },
        )
      }
      const truncated = truncateForBudget(json, cap)
      if (truncated !== json) {
        truncations += 1
        attributes[key] = truncated
      } else {
        attributes[key] = value
      }
      continue
    }
    attributes[key] = value
  }
  return { span: { ...span, attributes }, truncations }
}

function oversizedFromSpans(spans: readonly TraceAnalystSpan[]): ViewTraceOversized {
  const names = new Map<string, number>()
  let maxBytes = 0
  let errors = 0
  for (const span of spans) {
    names.set(span.name, (names.get(span.name) ?? 0) + 1)
    maxBytes = Math.max(maxBytes, encodedBytes('viewTrace', span))
    if (span.status === 'ERROR') errors += 1
  }
  return {
    span_count: spans.length,
    top_span_names: [...names.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20),
    span_response_bytes_max: maxBytes,
    error_span_count: errors,
  }
}

export function compileSearchRegex(pattern: string): RE2JS {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new TraceAnalysisValidationError('regex_pattern must be a non-empty string')
  }
  let source = pattern
  let flags = RE2JS.MULTILINE
  if (source.startsWith('(?i)')) {
    source = source.slice(4)
    flags |= RE2JS.CASE_INSENSITIVE
  }
  try {
    return RE2JS.compile(source, flags)
  } catch (cause) {
    throw new TraceAnalysisValidationError(
      `regex_pattern is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
}

export function truncateForBudget(value: string, byteCap: number): string {
  validateInteger(byteCap, 'byteCap', TRACE_ANALYSIS_LIMITS.minimumTextBudget)
  const original = Buffer.byteLength(value, 'utf8')
  if (original <= byteCap) return value

  const marker = `\n[trace-analyst truncated: original ${original} bytes]`
  const contentCap = byteCap - Buffer.byteLength(marker, 'utf8')
  let cut = Math.max(0, Math.floor((value.length * contentCap) / original))
  while (cut > 0 && Buffer.byteLength(value.slice(0, cut), 'utf8') > contentCap) cut -= 1
  return `${value.slice(0, cut)}${marker}`
}

export function validateInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TraceAnalysisValidationError(
      `${label} must be an integer ${minimum}..${maximum}, got ${String(value)}`,
    )
  }
  return value
}

function requireEqual(operation: string, label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw contractError(
      operation,
      `${label} ${JSON.stringify(actual)} does not match ${JSON.stringify(expected)}`,
    )
  }
}

function encodedBytes(operation: string, value: unknown): number {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('JSON.stringify returned undefined')
    return Buffer.byteLength(encoded, 'utf8')
  } catch (cause) {
    if (cause instanceof TraceAnalysisStoreContractError) throw cause
    throw new TraceAnalysisStoreContractError(operation, 'store result is not JSON-serializable', {
      cause,
    })
  }
}

function withinByteCeiling<T>(operation: string, value: T, ceiling: number): T {
  const actual = encodedBytes(operation, value)
  if (actual > ceiling) {
    throw new TraceAnalysisLimitError(
      operation,
      actual,
      ceiling,
      `${operation} metadata requires ${actual} bytes, over the ${ceiling}-byte response limit`,
    )
  }
  return value
}

function responseItemTooLarge(
  operation: string,
  value: unknown,
  ceiling: number,
): TraceAnalysisLimitError {
  const actual = encodedBytes(operation, value)
  return new TraceAnalysisLimitError(
    operation,
    actual,
    ceiling,
    `${operation} cannot fit one result item in the ${ceiling}-byte response limit`,
  )
}

function contractError(operation: string, message: string): TraceAnalysisStoreContractError {
  return new TraceAnalysisStoreContractError(operation, message)
}
