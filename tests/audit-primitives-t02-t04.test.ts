import { describe, expect, it } from 'vitest'
import { type CaptureFetchContext, captureFetchToRawSink } from '../src/trace/capture-fetch'
import type { OtlpExport } from '../src/trace/otel'
import type { RawProviderEvent, RawProviderSink } from '../src/trace/raw-provider-sink'
import { flattenOtlpExportToNdjson } from '../src/trace-analyst/otlp-flatten'

function memorySink(): RawProviderSink & { events: RawProviderEvent[] } {
  const events: RawProviderEvent[] = []
  return {
    events,
    async record(e) {
      events.push(e)
    },
  }
}

const ctx: CaptureFetchContext = {
  runId: 'run-1',
  baseUrl: 'https://router.tangle.tools/v1',
  model: 'claude-sonnet-4-6',
  provider: 'tangle-router',
}

// ── T02 captureFetchToRawSink ────────────────────────────────────────
describe('captureFetchToRawSink', () => {
  it('records a request + response triple and returns the original response unmutated', async () => {
    const sink = memorySink()
    const realFetch = (async () =>
      new Response(JSON.stringify({ ok: true, text: 'hi' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch
    const wrapped = captureFetchToRawSink(realFetch, sink, ctx)

    const res = await wrapped('https://router.tangle.tools/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    })

    // Original response is still consumable by the caller.
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, text: 'hi' })

    const dirs = sink.events.map((e) => e.direction)
    expect(dirs).toEqual(['request', 'response'])
    const [req, resp] = sink.events
    expect(req!.endpoint).toBe('/chat/completions')
    expect(req!.provider).toBe('tangle-router')
    expect(resp!.statusCode).toBe(200)
    expect(resp!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('redacts the Authorization header via the default redactor', async () => {
    const sink = memorySink()
    const realFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const wrapped = captureFetchToRawSink(realFetch, sink, ctx)
    await wrapped('https://router.tangle.tools/v1/x', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-secret' },
    })
    const req = sink.events.find((e) => e.direction === 'request')!
    expect(req.requestHeaders?.authorization).toBeUndefined()
    expect(req.redactedFields).toContain('requestHeaders.authorization')
  })

  it('emits an error event (then rethrows) when the underlying fetch throws', async () => {
    const sink = memorySink()
    const realFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const wrapped = captureFetchToRawSink(realFetch, sink, ctx)
    await expect(wrapped('https://router.tangle.tools/v1/x', { method: 'POST' })).rejects.toThrow(
      'ECONNREFUSED',
    )
    const err = sink.events.find((e) => e.direction === 'error')!
    expect(err.errorMessage).toContain('ECONNREFUSED')
    expect(err.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('truncates a response body beyond the cap and marks body_truncated', async () => {
    const sink = memorySink()
    const big = 'x'.repeat(50)
    const realFetch = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch
    const wrapped = captureFetchToRawSink(realFetch, sink, ctx, { responseBodyByteCap: 10 })
    await wrapped('https://router.tangle.tools/v1/x')
    const resp = sink.events.find((e) => e.direction === 'response')!
    expect(resp.redactedFields).toContain('body_truncated')
    expect(String(resp.responseBody).length).toBe(10)
  })

  it('best-effort: a throwing sink does NOT take down the fetch (default)', async () => {
    const realFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const throwingSink: RawProviderSink = {
      async record() {
        throw new Error('disk full')
      },
    }
    const wrapped = captureFetchToRawSink(realFetch, throwingSink, ctx)
    await expect(wrapped('https://router.tangle.tools/v1/x')).resolves.toBeInstanceOf(Response)
  })
})

// ── T04 flattenOtlpExportToNdjson ────────────────────────────────────
const otlp: OtlpExport = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agent-x' } }] },
      scopeSpans: [
        {
          scope: { name: '@tangle-network/agent-eval', version: '0.3.0' },
          spans: [
            {
              traceId: 't1',
              spanId: 's1',
              name: 'llm.call',
              kind: 3,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'llm.model', value: { stringValue: 'claude-sonnet' } },
                { key: 'llm.tokens.in', value: { intValue: '1200' } },
                { key: 'span.kind', value: { stringValue: 'llm' } },
              ],
              status: { code: 2, message: 'rate_limited' },
            },
          ],
        },
      ],
    },
  ],
}

describe('flattenOtlpExportToNdjson', () => {
  it('flattens to the OtlpFileTraceStore line shape with mapped codes + ISO times', () => {
    const lines = flattenOtlpExportToNdjson(otlp)
    expect(lines).toHaveLength(1)
    const l = lines[0]!
    expect(l.trace_id).toBe('t1')
    expect(l.span_id).toBe('s1')
    expect(l.parent_span_id).toBeNull()
    expect(l.kind).toBe('SPAN_KIND_CLIENT') // numeric 3
    expect(l.status).toEqual({ code: 'STATUS_CODE_ERROR', message: 'rate_limited' })
    expect(l.start_time).toBe('2023-11-14T22:13:20.000Z')
    expect(l.resource.attributes['service.name']).toBe('agent-x')
    // attribute values unwrapped to scalars (intValue → number)
    expect(l.attributes['llm.tokens.in']).toBe(1200)
  })

  it('mirrors attributes into the OpenInference vocabulary by default', () => {
    const l = flattenOtlpExportToNdjson(otlp)[0]!
    expect(l.attributes['llm.model_name']).toBe('claude-sonnet')
    expect(l.attributes['openinference.span.kind']).toBe('LLM')
  })

  it('passes attributes through untouched under vocabulary "none"', () => {
    const l = flattenOtlpExportToNdjson(otlp, { attributeVocabulary: 'none' })[0]!
    expect(l.attributes['llm.model_name']).toBeUndefined()
    expect(l.attributes['llm.model']).toBe('claude-sonnet')
  })
})
