import { describe, expect, it } from 'vitest'
import { SpanNotFoundError, TraceAnalysisLimitError, TraceNotFoundError } from './errors'
import type { TraceAnalysisStore, TraceAnalysisStoreContext } from './store'
import { createBoundedTraceAnalysisStore } from './store'
import type {
  DatasetOverview,
  QueryTracesPage,
  SearchSpanResult,
  SearchTraceResult,
  SpanMatchRecord,
  TraceAnalystSpan,
  TraceAnalystTraceSummary,
  ViewSpansResult,
  ViewTraceResult,
} from './types'

const TRACE_ID = 'runtime-trace'
const SPAN_IDS = ['span-1', 'span-2', 'span-3'] as const

function summary(trace_id = TRACE_ID): TraceAnalystTraceSummary {
  return {
    trace_id,
    service_name: 'runtime',
    agent_name: 'worker',
    span_count: SPAN_IDS.length,
    has_errors: false,
    start_time: '2026-07-29T00:00:00.000Z',
    end_time: '2026-07-29T00:00:01.000Z',
    duration_ms: 1_000,
    raw_jsonl_bytes: 10_000,
    models: [],
    tools: ['read'],
  }
}

function span(span_id: string): TraceAnalystSpan {
  return {
    trace_id: TRACE_ID,
    span_id,
    parent_span_id: null,
    name: `runtime.${span_id}`,
    kind: 'TOOL',
    start_time: '2026-07-29T00:00:00.000Z',
    end_time: '2026-07-29T00:00:01.000Z',
    duration_ms: 1_000,
    status: 'OK',
    service_name: 'runtime',
    agent_name: 'worker',
    model_name: null,
    tool_name: 'read',
    attributes: { payload: 'x'.repeat(2_000) },
  }
}

function hit(index: number): SpanMatchRecord {
  return {
    trace_id: TRACE_ID,
    span_id: SPAN_IDS[0],
    span_name: 'runtime.span-1',
    span_kind: 'TOOL',
    attribute_path: 'attributes.payload',
    matched_text: `match-${index}`,
    context_before: '',
    context_after: '',
    match_offset: index,
  }
}

/** Small complete adapter used to exercise the public boundary. */
function runtimeLikeStore() {
  const calls = {
    hasTrace: 0,
    hasSpans: 0,
    viewTrace: 0,
    contexts: [] as Array<TraceAnalysisStoreContext | undefined>,
  }
  const summaries = [summary(), summary('runtime-trace-2'), summary('runtime-trace-3')]
  const spans = SPAN_IDS.map(span)

  const store: TraceAnalysisStore = {
    async hasTrace(trace_id, context) {
      calls.hasTrace += 1
      calls.contexts.push(context)
      return trace_id === TRACE_ID
    },
    async hasSpans({ trace_id, span_ids }, context) {
      calls.hasSpans += 1
      calls.contexts.push(context)
      return trace_id === TRACE_ID
        ? span_ids.filter((spanId) => SPAN_IDS.includes(spanId as (typeof SPAN_IDS)[number]))
        : []
    },
    async getOverview(_filters, context): Promise<DatasetOverview> {
      calls.contexts.push(context)
      return {
        total_traces: summaries.length,
        raw_jsonl_bytes: 30_000,
        services: ['runtime'],
        agents: ['worker'],
        models: [],
        tool_names: ['read'],
        sample_trace_ids: summaries.map((item) => item.trace_id),
        errors: { trace_count: 0, span_count: 0 },
        error_clusters: [],
        time_range: null,
      }
    },
    async queryTraces({ limit, offset = 0 }, context): Promise<QueryTracesPage> {
      calls.contexts.push(context)
      const traces = summaries.slice(offset, offset + limit)
      return {
        traces,
        total: summaries.length,
        has_more: offset + traces.length < summaries.length,
      }
    },
    async countTraces(_filters, context): Promise<number> {
      calls.contexts.push(context)
      return summaries.length
    },
    async viewTrace({ trace_id }, context): Promise<ViewTraceResult> {
      calls.viewTrace += 1
      calls.contexts.push(context)
      return trace_id === TRACE_ID ? { trace_id, spans } : { trace_id, spans: [] }
    },
    async viewSpans({ trace_id, span_ids }, context): Promise<ViewSpansResult> {
      calls.contexts.push(context)
      const found = spans.filter((item) => span_ids.includes(item.span_id))
      return {
        trace_id,
        spans: found,
        missing_span_ids: span_ids.filter(
          (span_id) => !spans.some((item) => item.span_id === span_id),
        ),
        omitted_span_ids: [],
        has_more: false,
        truncated_attribute_count: 0,
      }
    },
    async searchTrace({ trace_id, max_matches = 50 }, context): Promise<SearchTraceResult> {
      calls.contexts.push(context)
      const allHits = [hit(0), hit(1)]
      const hits = allHits.slice(0, max_matches)
      return {
        trace_id,
        hits,
        has_more: hits.length < allHits.length,
      }
    },
    async searchSpan({ trace_id, span_id, max_matches = 50 }, context): Promise<SearchSpanResult> {
      calls.contexts.push(context)
      const allHits = [hit(0), hit(1)]
      const hits = allHits.slice(0, max_matches)
      return {
        trace_id,
        span_id,
        hits,
        has_more: hits.length < allHits.length,
      }
    },
  }

  return { store, calls }
}

describe('createBoundedTraceAnalysisStore', () => {
  it('preserves truthful pagination and continuation from a conforming store', async () => {
    const { store } = runtimeLikeStore()
    const bounded = createBoundedTraceAnalysisStore(store)

    const page = await bounded.queryTraces({ limit: 1, offset: 0 })
    expect(page.traces).toHaveLength(1)
    expect(page.total).toBe(3)
    expect(page.has_more).toBe(true)

    const search = await bounded.searchSpan({
      trace_id: TRACE_ID,
      span_id: SPAN_IDS[0],
      regex_pattern: 'match',
      max_matches: 1,
    })
    expect(search.hits).toHaveLength(1)
    expect(search.has_more).toBe(true)
  })

  it('marks continuation when the response byte limit shortens a valid page', async () => {
    const { store } = runtimeLikeStore()
    const bounded = createBoundedTraceAnalysisStore(store, {
      budgets: { perCallByteCeiling: 400 },
    })

    const page = await bounded.queryTraces({ limit: 3, offset: 0 })

    expect(page.traces.length).toBeGreaterThan(0)
    expect(page.traces.length).toBeLessThan(3)
    expect(page.has_more).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(400)
  })

  it('throws a stable size error when one page item cannot fit', async () => {
    const { store } = runtimeLikeStore()
    const bounded = createBoundedTraceAnalysisStore(store, {
      budgets: { perCallByteCeiling: 100 },
    })

    await expect(bounded.queryTraces({ limit: 1, offset: 0 })).rejects.toMatchObject({
      code: 'limit_exceeded',
      operation: 'queryTraces',
      limit: 100,
    })
  })

  it('rejects an empty page that claims more traces exist', async () => {
    const { store } = runtimeLikeStore()
    store.queryTraces = async () => ({ traces: [], total: 3, has_more: true })

    await expect(
      createBoundedTraceAnalysisStore(store).queryTraces({ limit: 1 }),
    ).rejects.toMatchObject({
      code: 'backend_integrity',
      operation: 'queryTraces',
    })
  })

  it('partitions every requested span id into returned, missing, or omitted', async () => {
    const { store, calls } = runtimeLikeStore()
    const bounded = createBoundedTraceAnalysisStore(store, {
      budgets: { perCallByteCeiling: 1_600, perAttributeSpanBudget: 512 },
    })
    const requested = [...SPAN_IDS, 'missing-span']

    const result = await bounded.viewSpans({ trace_id: TRACE_ID, span_ids: requested })
    const returned = result.spans.map((item) => item.span_id)
    const accounted = [...returned, ...result.missing_span_ids, ...result.omitted_span_ids]

    expect(accounted.sort()).toEqual([...requested].sort())
    expect(new Set(accounted).size).toBe(requested.length)
    expect(result.missing_span_ids).toEqual(['missing-span'])
    expect(result.omitted_span_ids.length).toBeGreaterThan(0)
    expect(result.has_more).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1_600)
    expect(calls.hasSpans).toBe(1)
  })

  it('stabilizes trace and span not-found behavior before unsafe read methods run', async () => {
    const { store, calls } = runtimeLikeStore()
    const bounded = createBoundedTraceAnalysisStore(store)

    await expect(bounded.viewTrace({ trace_id: 'missing-trace' })).rejects.toMatchObject({
      code: 'not_found',
      trace_id: 'missing-trace',
    })
    expect(calls.viewTrace).toBe(0)

    await expect(
      bounded.searchSpan({
        trace_id: TRACE_ID,
        span_id: 'missing-span',
        regex_pattern: 'x',
      }),
    ).rejects.toBeInstanceOf(SpanNotFoundError)
    await expect(bounded.viewTrace({ trace_id: 'missing-trace' })).rejects.toBeInstanceOf(
      TraceNotFoundError,
    )
  })

  it('forwards one AbortSignal through every read and its existence checks', async () => {
    const { store, calls } = runtimeLikeStore()
    const bounded = createBoundedTraceAnalysisStore(store)
    const signal = new AbortController().signal

    await bounded.getOverview(undefined, { signal })
    await bounded.queryTraces({ limit: 1 }, { signal })
    await bounded.countTraces(undefined, { signal })
    await bounded.viewTrace({ trace_id: TRACE_ID }, { signal })
    await bounded.viewSpans({ trace_id: TRACE_ID, span_ids: [SPAN_IDS[0]] }, { signal })
    await bounded.searchTrace(
      { trace_id: TRACE_ID, regex_pattern: 'match', max_matches: 1 },
      { signal },
    )
    await bounded.searchSpan(
      {
        trace_id: TRACE_ID,
        span_id: SPAN_IDS[0],
        regex_pattern: 'match',
        max_matches: 1,
      },
      { signal },
    )

    expect(calls.contexts).toHaveLength(13)
    expect(calls.contexts.every((context) => context?.signal === signal)).toBe(true)
  })

  it('does not touch the store when the signal is already aborted', async () => {
    const { store, calls } = runtimeLikeStore()
    const bounded = createBoundedTraceAnalysisStore(store)
    const controller = new AbortController()
    const reason = new Error('cancel trace read')
    controller.abort(reason)

    await expect(
      bounded.viewTrace({ trace_id: TRACE_ID }, { signal: controller.signal }),
    ).rejects.toBe(reason)
    expect(calls.hasTrace).toBe(0)
    expect(calls.viewTrace).toBe(0)
  })

  it('throws a stable size-limit error when even non-pageable metadata exceeds the ceiling', async () => {
    const { store } = runtimeLikeStore()
    const bounded = createBoundedTraceAnalysisStore(store, {
      budgets: { perCallByteCeiling: 32 },
    })

    await expect(bounded.getOverview()).rejects.toBeInstanceOf(TraceAnalysisLimitError)
    await expect(bounded.getOverview()).rejects.toMatchObject({ code: 'limit_exceeded' })
  })

  it('rejects a third-party page that violates its requested limit', async () => {
    const { store } = runtimeLikeStore()
    store.queryTraces = async () => ({
      traces: [summary(), summary('extra')],
      total: 2,
      has_more: false,
    })

    await expect(
      createBoundedTraceAnalysisStore(store).queryTraces({ limit: 1 }),
    ).rejects.toMatchObject({
      code: 'backend_integrity',
      operation: 'queryTraces',
    })
  })

  it('rejects missing continuation accounting instead of hiding omitted spans', async () => {
    const { store } = runtimeLikeStore()
    store.viewSpans = async ({ trace_id, span_ids }) =>
      ({
        trace_id,
        spans: spansFor(span_ids.slice(0, 1)),
        missing_span_ids: [],
        truncated_attribute_count: 0,
      }) as unknown as ViewSpansResult

    await expect(
      createBoundedTraceAnalysisStore(store).viewSpans({
        trace_id: TRACE_ID,
        span_ids: [SPAN_IDS[0], SPAN_IDS[1]],
      }),
    ).rejects.toMatchObject({
      code: 'backend_integrity',
      operation: 'viewSpans',
    })
  })

  it('rejects a store that omits every existing requested span without making progress', async () => {
    const { store } = runtimeLikeStore()
    store.viewSpans = async ({ trace_id, span_ids }) => ({
      trace_id,
      spans: [],
      missing_span_ids: [],
      omitted_span_ids: [...span_ids],
      has_more: true,
      truncated_attribute_count: 0,
    })

    await expect(
      createBoundedTraceAnalysisStore(store).viewSpans({
        trace_id: TRACE_ID,
        span_ids: [SPAN_IDS[0], SPAN_IDS[1]],
      }),
    ).rejects.toMatchObject({
      code: 'backend_integrity',
      operation: 'viewSpans',
    })
  })

  it('rejects malformed span and match fields from third-party stores', async () => {
    const { store } = runtimeLikeStore()
    store.viewTrace = async ({ trace_id }) => ({
      trace_id,
      spans: [{ ...span(SPAN_IDS[0]), kind: 'INVALID' as TraceAnalystSpan['kind'] }],
    })

    await expect(
      createBoundedTraceAnalysisStore(store).viewTrace({ trace_id: TRACE_ID }),
    ).rejects.toMatchObject({
      code: 'backend_integrity',
      operation: 'viewTrace',
    })

    store.searchSpan = async ({ trace_id, span_id }) => ({
      trace_id,
      span_id,
      hits: [{ ...hit(0), match_offset: -1 }],
      has_more: false,
    })
    await expect(
      createBoundedTraceAnalysisStore(store).searchSpan({
        trace_id: TRACE_ID,
        span_id: SPAN_IDS[0],
        regex_pattern: 'match',
      }),
    ).rejects.toMatchObject({
      code: 'backend_integrity',
      operation: 'searchSpan',
    })
  })

  it('rejects undeclared third-party result fields', async () => {
    const { store } = runtimeLikeStore()
    const original = store.getOverview.bind(store)
    store.getOverview = async (filters, context) =>
      ({
        ...(await original(filters, context)),
        private_backend_field: true,
      }) as DatasetOverview

    await expect(createBoundedTraceAnalysisStore(store).getOverview()).rejects.toMatchObject({
      code: 'backend_integrity',
      operation: 'getOverview',
    })
  })

  it('rejects JavaScript-only attribute values that cannot cross JSON transports', async () => {
    const { store } = runtimeLikeStore()
    store.viewTrace = async ({ trace_id }) =>
      ({
        trace_id,
        spans: [
          {
            ...span(SPAN_IDS[0]),
            attributes: { unsupported: undefined },
          },
        ],
      }) as ViewTraceResult

    await expect(
      createBoundedTraceAnalysisStore(store).viewTrace({ trace_id: TRACE_ID }),
    ).rejects.toMatchObject({
      code: 'backend_integrity',
      operation: 'viewTrace',
    })
  })

  it('rejects an empty search result that claims more matches exist', async () => {
    const { store } = runtimeLikeStore()
    store.searchTrace = async ({ trace_id }) => ({
      trace_id,
      hits: [],
      has_more: true,
    })

    await expect(
      createBoundedTraceAnalysisStore(store).searchTrace({
        trace_id: TRACE_ID,
        regex_pattern: 'match',
      }),
    ).rejects.toMatchObject({
      code: 'backend_integrity',
      operation: 'searchTrace',
    })
  })

})

function spansFor(ids: readonly string[]): TraceAnalystSpan[] {
  return ids.map((id) => span(id))
}
