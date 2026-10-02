import { describe, expect, it } from 'vitest'
import { CaptureIntegrityError } from '../errors'
import {
  createBoundedTraceAnalysisStore,
  otlpTextToTraceAnalysisStore,
  SpanNotFoundError,
  spanRecordsToTraceAnalysisStore,
  type TraceAnalystSpan,
  TraceNotFoundError,
} from '../traces'

function span(overrides: Partial<TraceAnalystSpan> = {}): TraceAnalystSpan {
  return {
    trace_id: 'opaque/run:one',
    span_id: 'child/native-id',
    parent_span_id: 'parent/native-id',
    name: 'reasoning',
    kind: 'UNKNOWN',
    start_time: '2026-10-02T00:00:00.000Z',
    end_time: '2026-10-02T00:00:30.000Z',
    duration_ms: 0,
    status: 'UNSET',
    service_name: 'archive',
    agent_name: 'director',
    model_name: null,
    tool_name: null,
    attributes: { reasoning: 'Investigate café 🧪', nested: { items: [1, false, null] } },
    ...overrides,
  }
}

function otlp(records: readonly TraceAnalystSpan[]): string {
  return records
    .map((record) =>
      JSON.stringify({
        ...record,
        status: { code: record.status, message: record.status_message },
        attributes: {
          ...record.attributes,
          'openinference.span.kind': record.kind,
          'agent.name': record.agent_name,
        },
      }),
    )
    .join('\n')
}

describe('spanRecordsToTraceAnalysisStore public adapter', () => {
  it('preserves opaque identity, declared kinds, explicit zero duration, and unknown cost', async () => {
    const records = [
      span({
        span_id: 'parent/native-id',
        parent_span_id: null,
        kind: 'AGENT',
        duration_ms: 30_000,
        status: 'ERROR',
        status_message: 'provider failed',
      }),
      span(),
    ]
    const store = spanRecordsToTraceAnalysisStore(records)
    const viewed = await store.viewTrace({ trace_id: records[0]!.trace_id })
    expect(viewed.spans).toEqual(records)
    expect(viewed.spans![1]!.attributes).not.toHaveProperty('llm.cost_usd')
    expect((await store.queryTraces({ limit: 1 })).traces[0]!.duration_ms).toBe(30_000)
    expect((await store.getOverview()).errors).toEqual({ trace_count: 1, span_count: 1 })
  })

  it('detaches both caller input and returned nested attribute values', async () => {
    const record = span()
    const store = spanRecordsToTraceAnalysisStore([record])
    record.name = 'mutated input'
    record.attributes.nested = { changed: true }
    const first = await store.viewTrace({ trace_id: record.trace_id })
    first.spans![0]!.attributes.nested = { mutated: true }
    expect((await store.viewTrace({ trace_id: record.trace_id })).spans![0]).toEqual(span())
  })

  it('rejects absent evidence and duplicate identity while admitting equal IDs in separate traces', async () => {
    expect(() => spanRecordsToTraceAnalysisStore([])).toThrow(CaptureIntegrityError)
    expect(() => spanRecordsToTraceAnalysisStore([span(), span()])).toThrow(/duplicate span/)
    const store = spanRecordsToTraceAnalysisStore([span(), span({ trace_id: 'other' })])
    expect(await store.countTraces()).toBe(2)
  })

  it.each([
    { duration_ms: -1 },
    { duration_ms: Number.NaN },
    { trace_id: '' },
    { start_time: 'not-a-timestamp' },
    { attributes: { missing: undefined } },
    { attributes: { value: 1n } },
  ])('rejects invalid canonical input before reads: %#', (overrides) => {
    expect(() => spanRecordsToTraceAnalysisStore([span(overrides)])).toThrow(CaptureIntegrityError)
  })

  it.each(['records', 'otlp'] as const)(
    'filters and discovers any agent while preserving the first-agent summary: %s',
    async (adapter) => {
      const records = [
        span({ span_id: 'first', agent_name: 'director' }),
        span({ span_id: 'second', agent_name: 'worker' }),
      ]
      const store =
        adapter === 'records'
          ? spanRecordsToTraceAnalysisStore(records)
          : otlpTextToTraceAnalysisStore(otlp(records))
      expect(await store.countTraces({ agent_names: ['worker'] })).toBe(1)
      expect((await store.getOverview()).agents).toEqual(['director', 'worker'])
      expect(
        (await store.queryTraces({ limit: 1, filters: { agent_names: ['worker'] } })).traces[0]!
          .agent_name,
      ).toBe('director')
      expect(await store.countTraces({ agent_names: ['absent'] })).toBe(0)
    },
  )

  it('uses canonical paging, typed misses, and bounded regex search over its actual snapshot', async () => {
    const store = spanRecordsToTraceAnalysisStore([
      span({ trace_id: 'b' }),
      span({ trace_id: 'a' }),
    ])
    expect(await store.queryTraces({ limit: 1, offset: 1 })).toMatchObject({
      total: 2,
      has_more: false,
      traces: [{ trace_id: 'b' }],
    })
    await expect(store.viewTrace({ trace_id: 'absent' })).rejects.toBeInstanceOf(TraceNotFoundError)
    await expect(
      store.searchSpan({ trace_id: 'a', span_id: 'absent', regex_pattern: 'x' }),
    ).rejects.toBeInstanceOf(SpanNotFoundError)
    const searched = await store.searchSpan({
      trace_id: 'a',
      span_id: 'child/native-id',
      regex_pattern: 'café',
      max_matches: 1,
    })
    expect(searched.hits).toHaveLength(1)
    expect(searched.hits[0]!.matched_text).toBe('café')
    expect(searched.hits[0]!.attribute_path).toBe('reasoning')
    expect((await store.getOverview()).raw_jsonl_bytes).toBe(
      Buffer.byteLength(
        `${JSON.stringify(span({ trace_id: 'b' }))}\n${JSON.stringify(span({ trace_id: 'a' }))}\n`,
      ),
    )
  })

  it('retains shared truncation and oversized summary policies', async () => {
    const record = span({ attributes: { text: '🧪'.repeat(1_000) } })
    const capped = spanRecordsToTraceAnalysisStore([record], {
      perAttributeViewBudget: 64,
      perAttributeSpanBudget: 64,
    })
    const view = await capped.viewTrace({ trace_id: record.trace_id })
    expect(view.spans![0]!.attributes.text).not.toBe(record.attributes.text)
    expect(
      (await capped.viewSpans({ trace_id: record.trace_id, span_ids: [record.span_id] }))
        .truncated_attribute_count,
    ).toBe(1)
    const small = spanRecordsToTraceAnalysisStore([record], { perCallByteCeiling: 64 })
    expect((await small.viewTrace({ trace_id: record.trace_id })).oversized).toMatchObject({
      span_count: 1,
    })
  })

  it('preserves original abort identity before indexing and isolates a cancelled concurrent reader', async () => {
    const reason = new Error('caller cancelled')
    const stopped = new AbortController()
    stopped.abort(reason)
    const records = Array.from({ length: 5_100 }, (_, index) => span({ span_id: `span-${index}` }))
    const store = spanRecordsToTraceAnalysisStore(records)
    await expect(store.getOverview(undefined, { signal: stopped.signal })).rejects.toBe(reason)
    const controller = new AbortController()
    const cancelled = store.getOverview(undefined, { signal: controller.signal })
    const surviving = store.countTraces()
    setImmediate(() => controller.abort(reason))
    await expect(cancelled).rejects.toBe(reason)
    expect(await surviving).toBe(1)
  })

  it('binds original source reads only when explicitly supplied and checks scope before invoking them', async () => {
    const record = span()
    expect(spanRecordsToTraceAnalysisStore([record]).readSpanSource).toBeUndefined()
    let calls = 0
    const controller = new AbortController()
    const store = spanRecordsToTraceAnalysisStore([record], {
      sourceReader: async (input, context) => {
        calls += 1
        expect(context?.signal).toBe(controller.signal)
        return {
          status: 'unavailable',
          trace_id: input.trace_id,
          span_id: input.span_id,
          attribute: input.attribute,
          source_index: input.source_index ?? 0,
          reason: 'not retained',
        }
      },
    })
    const input = {
      trace_id: record.trace_id,
      span_id: record.span_id,
      attribute: 'reasoning',
      offset: 0,
      limit: 64,
    }
    await expect(store.readSpanSource!({ ...input, trace_id: 'absent' })).rejects.toBeInstanceOf(
      TraceNotFoundError,
    )
    expect(calls).toBe(0)
    expect(await store.readSpanSource!(input, { signal: controller.signal })).toMatchObject({
      status: 'unavailable',
      reason: 'not retained',
    })
    expect(calls).toBe(1)
    const bounded = createBoundedTraceAnalysisStore(store)
    expect((await bounded.viewTrace({ trace_id: record.trace_id })).spans![0]!.duration_ms).toBe(0)
  })
})
