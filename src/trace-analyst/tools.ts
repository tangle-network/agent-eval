/**
 * Trace-analyst tool surface — six namespaced AxFunctions the analyst
 * agent calls from generated JS code via `traces.<name>(...)`.
 *
 * Discovery → narrow → deep-read protocol. Tool names + ordering
 * support RLM discovery:
 *
 *   1. `getDatasetOverview` (cheap)  — first call, sizes the dataset
 *   2. `queryTraces`                 — paginated summaries with `raw_jsonl_bytes`
 *   3. `countTraces`                 — cheap pre-flight before regex
 *   4. `viewTrace`                   — full span list, oversized → summary
 *   5. `viewSpans`                   — surgical 16KB-cap reads
 *   6. `searchTrace` / `searchSpan`  — bounded regex hits
 *
 * Failure mode. Tool handlers throw on bad input (invalid trace ids,
 * out-of-range pagination, malformed regex). Ax converts thrown errors
 * into actor-visible `[ERROR]` strings so the analyst can adjust on
 * the next turn instead of looping.
 */

import { f, fn } from '@ax-llm/ax'
import type { AxFunction } from '@ax-llm/ax'

import type { TraceAnalysisStore } from './store'
import type { TraceAnalystFilters } from './types'

const NAMESPACE = 'traces'

interface BuildTraceAnalystToolsOpts {
  store: TraceAnalysisStore
  /** Override the default sample-trace-id slot count (20). Mostly for tests. */
  sampleTraceLimit?: number
}

const filtersField = f
  .json('Filter set. ALL fields are AND-composed. Leave empty to scan everything.')
  .optional()

/**
 * Build the trace-analyst function set. Pass the result into
 * `agent(...).functions.local`.
 */
export function buildTraceAnalystTools(opts: BuildTraceAnalystToolsOpts): AxFunction[] {
  const { store } = opts

  const getDatasetOverview = fn('getDatasetOverview')
    .description(
      'Dataset rollup: total traces, raw_jsonl_bytes, services, agents, ' +
        'models, tools, and sample_trace_ids (real ids passable to ' +
        'view/search). Always call this FIRST without a regex_pattern.',
    )
    .namespace(NAMESPACE)
    .arg('filters', filtersField)
    .returns(f.json('DatasetOverview'))
    .handler(async ({ filters }) => store.getOverview(parseFilters(filters)))
    .build()

  const queryTraces = fn('queryTraces')
    .description(
      'Paginated trace summaries. Each summary carries raw_jsonl_bytes — ' +
        'use it to size traces BEFORE calling viewTrace. Narrow with indexed ' +
        'filters before adding regex_pattern.',
    )
    .namespace(NAMESPACE)
    .arg('filters', filtersField)
    .arg('limit', f.number('Page size, 1..200'))
    .arg('offset', f.number('Page offset; default 0').optional())
    .returns(f.json('QueryTracesPage'))
    .handler(async ({ filters, limit, offset }) =>
      store.queryTraces({
        filters: parseFilters(filters),
        limit: assertPageLimit(limit),
        offset: assertOffset(offset),
      }),
    )
    .build()

  const countTraces = fn('countTraces')
    .description(
      'Count traces matching `filters`. Use as a cheap pre-flight ' +
        'before opting into a regex_pattern scan.',
    )
    .namespace(NAMESPACE)
    .arg('filters', filtersField)
    .returns(f.number('count'))
    .handler(async ({ filters }) => store.countTraces(parseFilters(filters)))
    .build()

  const viewTrace = fn('viewTrace')
    .description(
      'Return ALL spans for a single trace, with each attribute capped at ' +
        '~4KB. If the response would exceed the per-call ceiling the result ' +
        'carries `oversized` instead of `spans` — DO NOT retry with the same ' +
        'trace_id; switch to searchTrace / viewSpans.',
    )
    .namespace(NAMESPACE)
    .arg('trace_id', f.string('Real trace id from a prior overview/query'))
    .returns(f.json('ViewTraceResult'))
    .handler(async ({ trace_id }) => store.viewTrace({ trace_id: assertString(trace_id, 'trace_id') }))
    .build()

  const viewSpans = fn('viewSpans')
    .description(
      'Surgical read of specific spans within a trace, with each ' +
        'attribute capped at ~16KB (4× the discovery cap). Use after ' +
        'searchTrace narrows to specific span_ids.',
    )
    .namespace(NAMESPACE)
    .arg('trace_id', f.string('Real trace id'))
    .arg('span_ids', f.string('Span ids to fetch').array())
    .returns(f.json('ViewSpansResult'))
    .handler(async ({ trace_id, span_ids }) =>
      store.viewSpans({
        trace_id: assertString(trace_id, 'trace_id'),
        span_ids: assertStringArray(span_ids, 'span_ids'),
      }),
    )
    .build()

  const searchTrace = fn('searchTrace')
    .description(
      'Regex search across all spans of one trace. Returns up to ' +
        '`max_matches` SpanMatchRecords with surrounding context. Stays ' +
        'bounded regardless of trace size. If has_more=true, REFINE the ' +
        'regex rather than raising max_matches blindly.',
    )
    .namespace(NAMESPACE)
    .arg('trace_id', f.string('Real trace id'))
    .arg('regex_pattern', f.string('JS-compatible regex, multiline'))
    .arg('max_matches', f.number('Max records returned, 1..500; default 50').optional())
    .returns(f.json('SearchTraceResult'))
    .handler(async ({ trace_id, regex_pattern, max_matches }) =>
      store.searchTrace({
        trace_id: assertString(trace_id, 'trace_id'),
        regex_pattern: assertRegex(regex_pattern),
        max_matches: assertMaxMatches(max_matches),
      }),
    )
    .build()

  const searchSpan = fn('searchSpan')
    .description(
      'Regex search inside a single span. Use when viewSpans returned ' +
        'a 16KB-truncated payload and you need to narrow further.',
    )
    .namespace(NAMESPACE)
    .arg('trace_id', f.string('Real trace id'))
    .arg('span_id', f.string('Real span id within trace'))
    .arg('regex_pattern', f.string('JS-compatible regex, multiline'))
    .arg('max_matches', f.number('Max records, 1..500; default 50').optional())
    .returns(f.json('SearchSpanResult'))
    .handler(async ({ trace_id, span_id, regex_pattern, max_matches }) =>
      store.searchSpan({
        trace_id: assertString(trace_id, 'trace_id'),
        span_id: assertString(span_id, 'span_id'),
        regex_pattern: assertRegex(regex_pattern),
        max_matches: assertMaxMatches(max_matches),
      }),
    )
    .build()

  return [
    getDatasetOverview,
    queryTraces,
    countTraces,
    viewTrace,
    viewSpans,
    searchTrace,
    searchSpan,
  ]
}

/**
 * Convenience: same shape as `buildTraceAnalystTools` but returns the
 * grouped form expected when registering trace tools alongside other
 * agent function modules. */
export function traceAnalystFunctionGroup(opts: BuildTraceAnalystToolsOpts): {
  namespace: string
  title: string
  selectionCriteria: string
  description: string
  functions: AxFunction[]
} {
  return {
    namespace: NAMESPACE,
    title: 'Trace Analysis',
    selectionCriteria: 'Use for any inspection of OTLP-shaped trace data.',
    description:
      'Discovery → narrow → deep-read tools over a JSONL trace dataset. ' +
      'Always call getDatasetOverview first.',
    functions: buildTraceAnalystTools(opts),
  }
}

// ─── Argument validation ─────────────────────────────────────────────

function parseFilters(input: unknown): TraceAnalystFilters | undefined {
  if (input == null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`filters must be an object, got ${typeof input}`)
  }
  const f = input as Record<string, unknown>
  const out: TraceAnalystFilters = {}
  if (typeof f.has_errors === 'boolean') out.has_errors = f.has_errors
  out.service_names = stringArrayOrUndefined(f.service_names, 'service_names')
  out.agent_names = stringArrayOrUndefined(f.agent_names, 'agent_names')
  out.model_names = stringArrayOrUndefined(f.model_names, 'model_names')
  out.tool_names = stringArrayOrUndefined(f.tool_names, 'tool_names')
  if (typeof f.start_time_after === 'string') out.start_time_after = f.start_time_after
  if (typeof f.start_time_before === 'string') out.start_time_before = f.start_time_before
  if (typeof f.regex_pattern === 'string') {
    if (f.regex_pattern.length === 0) {
      throw new TypeError('filters.regex_pattern cannot be empty')
    }
    out.regex_pattern = f.regex_pattern
  }
  return out
}

function stringArrayOrUndefined(v: unknown, label: string): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new TypeError(`${label} must be an array of strings`)
  if (v.some((x) => typeof x !== 'string')) {
    throw new TypeError(`${label} entries must be strings`)
  }
  return v as string[]
}

function assertPageLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError(`limit must be an integer 1..200`)
  }
  return limit
}
function assertOffset(offset: unknown): number | undefined {
  if (offset === undefined) return undefined
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`offset must be a non-negative integer`)
  }
  return offset
}
function assertRegex(pattern: unknown): string {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new TypeError(`regex_pattern must be a non-empty string`)
  }
  // Compile-and-discard to fail fast — store will recompile, but we
  // want a deterministic error from the agent's side rather than
  // a downstream exception.
  // eslint-disable-next-line no-new
  new RegExp(pattern, 'm')
  return pattern
}
function assertMaxMatches(n: unknown): number | undefined {
  if (n === undefined) return undefined
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 500) {
    throw new RangeError(`max_matches must be an integer 1..500`)
  }
  return n
}

function assertString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return v
}

function assertStringArray(v: unknown, label: string): string[] {
  if (!Array.isArray(v)) throw new TypeError(`${label} must be an array of strings`)
  if (v.some((x) => typeof x !== 'string')) {
    throw new TypeError(`${label} entries must be strings`)
  }
  return v as string[]
}
