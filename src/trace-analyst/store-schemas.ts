import { z } from 'zod'
import { TraceAnalysisStoreContractError, TraceAnalysisValidationError } from './errors'
import { TRACE_ANALYSIS_LIMITS } from './store-contract'

const identifier = z.string().min(1).max(TRACE_ANALYSIS_LIMITS.identifierCharacters)
const timestamp = z.iso.datetime({ offset: true })
const nonNegativeInteger = z.number().int().nonnegative()
const nonNegativeNumber = z.number().nonnegative()
const nullableString = z.string().nullable()
const nullableIdentifier = identifier.nullable()
const stringArray = z.array(z.string())
const filterValues = z.array(identifier).max(TRACE_ANALYSIS_LIMITS.filterValues)

export const traceFiltersSchema = z
  .object({
    has_errors: z.boolean().optional(),
    service_names: filterValues.optional(),
    agent_names: filterValues.optional(),
    model_names: filterValues.optional(),
    tool_names: filterValues.optional(),
    start_time_after: timestamp.optional(),
    start_time_before: timestamp.optional(),
    regex_pattern: z.string().min(1).max(TRACE_ANALYSIS_LIMITS.regexCharacters).optional(),
  })
  .strict()

const byteCap = z.number().int().min(TRACE_ANALYSIS_LIMITS.minimumTextBudget)
const searchPattern = z.string().min(1).max(TRACE_ANALYSIS_LIMITS.regexCharacters)

export const traceStoreInputSchemas = {
  hasTrace: z.object({ trace_id: identifier }).strict(),
  hasSpans: z
    .object({
      trace_id: identifier,
      span_ids: z.array(identifier).min(1).max(TRACE_ANALYSIS_LIMITS.viewSpans),
    })
    .strict(),
  getOverview: z.object({ filters: traceFiltersSchema.optional() }).strict(),
  queryTraces: z
    .object({
      filters: traceFiltersSchema.optional(),
      limit: z.number().int().min(1).max(TRACE_ANALYSIS_LIMITS.queryTraces),
      offset: z.number().int().nonnegative().optional(),
    })
    .strict(),
  countTraces: z.object({ filters: traceFiltersSchema.optional() }).strict(),
  viewTrace: z
    .object({
      trace_id: identifier,
      per_attribute_byte_cap: byteCap.optional(),
    })
    .strict(),
  viewSpans: z
    .object({
      trace_id: identifier,
      span_ids: z.array(identifier).min(1).max(TRACE_ANALYSIS_LIMITS.viewSpans),
      per_attribute_byte_cap: byteCap.optional(),
    })
    .strict(),
  searchTrace: z
    .object({
      trace_id: identifier,
      regex_pattern: searchPattern,
      max_matches: z.number().int().min(1).max(TRACE_ANALYSIS_LIMITS.searchMatches).default(50),
    })
    .strict(),
  searchSpan: z
    .object({
      trace_id: identifier,
      span_id: identifier,
      regex_pattern: searchPattern,
      max_matches: z.number().int().min(1).max(TRACE_ANALYSIS_LIMITS.searchMatches).default(50),
    })
    .strict(),
} as const

const spanKind = z.enum([
  'AGENT',
  'LLM',
  'TOOL',
  'CHAIN',
  'EVALUATOR',
  'GUARDRAIL',
  'SPAN',
  'UNKNOWN',
])
const spanStatus = z.enum(['OK', 'ERROR', 'UNSET'])

const traceSpan = z
  .object({
    trace_id: identifier,
    span_id: identifier,
    parent_span_id: nullableIdentifier,
    name: z.string(),
    kind: spanKind,
    start_time: timestamp,
    end_time: timestamp,
    duration_ms: nonNegativeNumber,
    status: spanStatus,
    status_message: z.string().optional(),
    service_name: nullableString,
    agent_name: nullableString,
    model_name: nullableString,
    tool_name: nullableString,
    attributes: z.record(z.string(), z.json()),
  })
  .strict()

const traceSummary = z
  .object({
    trace_id: identifier,
    service_name: nullableString,
    agent_name: nullableString,
    span_count: nonNegativeInteger,
    has_errors: z.boolean(),
    start_time: timestamp,
    end_time: timestamp,
    duration_ms: nonNegativeNumber,
    raw_jsonl_bytes: nonNegativeInteger,
    models: stringArray,
    tools: stringArray,
  })
  .strict()

const errorCluster = z
  .object({
    signature: z.string(),
    status_message_sample: z.string(),
    span_name: nullableString,
    tool_name: nullableString,
    trace_count: nonNegativeInteger,
    span_count: nonNegativeInteger,
    prevalence: z.number().min(0).max(1),
    exemplar_trace_ids: z.array(identifier),
    exemplar_span_ids: z.array(identifier),
  })
  .strict()

const overview = z
  .object({
    total_traces: nonNegativeInteger,
    raw_jsonl_bytes: nonNegativeInteger,
    services: stringArray,
    agents: stringArray,
    models: stringArray,
    tool_names: stringArray,
    sample_trace_ids: z.array(identifier).max(TRACE_ANALYSIS_LIMITS.sampleTraceIds),
    errors: z
      .object({
        trace_count: nonNegativeInteger,
        span_count: nonNegativeInteger,
      })
      .strict(),
    error_clusters: z.array(errorCluster),
    time_range: z
      .object({
        earliest: timestamp,
        latest: timestamp,
      })
      .strict()
      .nullable(),
  })
  .strict()

const tracePage = z
  .object({
    traces: z.array(traceSummary),
    total: nonNegativeInteger,
    has_more: z.boolean(),
  })
  .strict()

const oversizedTrace = z
  .object({
    span_count: nonNegativeInteger,
    top_span_names: z.array(z.tuple([z.string(), nonNegativeInteger])).max(20),
    span_response_bytes_max: nonNegativeInteger,
    error_span_count: nonNegativeInteger,
  })
  .strict()

const traceView = z
  .object({
    trace_id: identifier,
    spans: z.array(traceSpan).optional(),
    oversized: oversizedTrace.optional(),
  })
  .strict()
  .refine((value) => (value.spans === undefined) !== (value.oversized === undefined), {
    message: 'exactly one of spans or oversized is required',
  })

const spansView = z
  .object({
    trace_id: identifier,
    spans: z.array(traceSpan),
    missing_span_ids: z.array(identifier),
    omitted_span_ids: z.array(identifier),
    has_more: z.boolean(),
    truncated_attribute_count: nonNegativeInteger,
  })
  .strict()

const matchRecord = z
  .object({
    trace_id: identifier,
    span_id: identifier,
    span_name: z.string(),
    span_kind: spanKind,
    attribute_path: z.string(),
    matched_text: z.string(),
    context_before: z.string(),
    context_after: z.string(),
    match_offset: nonNegativeInteger,
  })
  .strict()

const traceSearch = z
  .object({
    trace_id: identifier,
    hits: z.array(matchRecord),
    has_more: z.boolean(),
  })
  .strict()

const spanSearch = traceSearch
  .extend({
    span_id: identifier,
  })
  .strict()

export const traceStoreOutputSchemas = {
  hasTrace: z.boolean(),
  hasSpans: z.array(identifier).max(TRACE_ANALYSIS_LIMITS.viewSpans),
  getOverview: overview,
  queryTraces: tracePage,
  countTraces: nonNegativeInteger,
  viewTrace: traceView,
  viewSpans: spansView,
  searchTrace: traceSearch,
  searchSpan: spanSearch,
} as const

export function parseTraceInput<T extends z.ZodType>(
  operation: string,
  schema: T,
  value: unknown,
): z.output<T> {
  try {
    return schema.parse(value)
  } catch (cause) {
    const detail = cause instanceof z.ZodError ? z.prettifyError(cause) : String(cause)
    throw new TraceAnalysisValidationError(`${operation}: invalid arguments: ${detail}`, { cause })
  }
}

export function parseStoreOutput<T extends z.ZodType>(
  operation: string,
  schema: T,
  value: unknown,
): z.output<T> {
  try {
    return schema.parse(value)
  } catch (cause) {
    const detail = cause instanceof z.ZodError ? z.prettifyError(cause) : String(cause)
    throw new TraceAnalysisStoreContractError(operation, `invalid store result: ${detail}`, {
      cause,
    })
  }
}

export function toTraceJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
}
