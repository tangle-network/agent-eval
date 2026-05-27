/**
 * OTel→hosted bridge — unit + E2E.
 *
 * Verifies the OTel-shape → wire-format conversion and the end-to-end path
 * from a synthetic OTel-style span batch into the reference receiver.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TenantConfig } from '../examples/hosted-ingest-server/server'
import {
  createOtelBridge,
  hrTimeToUnixNano,
  OTEL_STATUS_ERROR,
  OTEL_STATUS_OK,
  OTEL_STATUS_UNSET,
  type OtelAttributeValue,
  type OtelLikeSpan,
} from '../src/adapters/otel'
import { createHostedClient } from '../src/hosted/client'
import { startReceiver } from './_fixtures/hosted-receiver'

function makeSpan(overrides: Partial<OtelLikeSpan> = {}): OtelLikeSpan {
  const base: OtelLikeSpan = {
    spanContext: () => ({ traceId: 't-1', spanId: 's-1' }),
    name: 'dispatch',
    startTime: [1_700_000_000, 0],
    endTime: [1_700_000_001, 500_000_000],
    attributes: {},
  }
  return { ...base, ...overrides }
}

describe('hrTimeToUnixNano', () => {
  it('converts [s, ns] to unix-nano', () => {
    expect(hrTimeToUnixNano([1, 0])).toBe(1_000_000_000)
    expect(hrTimeToUnixNano([1, 500_000_000])).toBe(1_500_000_000)
    expect(hrTimeToUnixNano([0, 1])).toBe(1)
  })
})

describe('createOtelBridge — spanToEvent conversion', () => {
  const fakeClient = {
    tenant: { endpoint: '', apiKey: '', tenantId: '' },
    wireVersion: '2026-05-26.v1' as const,
    ingestEvalRun: async () => ({ accepted: 0, rejected: [] }),
    ingestEvalRuns: async () => ({ accepted: 0, rejected: [] }),
    ingestTraces: async () => ({ accepted: 0, rejected: [] }),
  }

  it('preserves traceId, spanId, name, and time fields', () => {
    const bridge = createOtelBridge({ client: fakeClient })
    const e = bridge.spanToEvent(
      makeSpan({
        spanContext: () => ({ traceId: 'abc', spanId: 'def' }),
        name: 'my-op',
        startTime: [2, 100],
        endTime: [3, 200],
      }),
    )
    expect(e.traceId).toBe('abc')
    expect(e.spanId).toBe('def')
    expect(e.name).toBe('my-op')
    expect(e.startTimeUnixNano).toBe(2_000_000_100)
    expect(e.endTimeUnixNano).toBe(3_000_000_200)
  })

  it('maps OTel status codes to wire-format strings', () => {
    const bridge = createOtelBridge({ client: fakeClient })
    expect(bridge.spanToEvent(makeSpan({ status: { code: OTEL_STATUS_OK } })).status?.code).toBe(
      'OK',
    )
    expect(
      bridge.spanToEvent(makeSpan({ status: { code: OTEL_STATUS_ERROR, message: 'boom' } })).status,
    ).toEqual({ code: 'ERROR', message: 'boom' })
    expect(bridge.spanToEvent(makeSpan({ status: { code: OTEL_STATUS_UNSET } })).status?.code).toBe(
      'UNSET',
    )
  })

  it('drops undefined/null attribute values; keeps string/number/boolean', () => {
    const bridge = createOtelBridge({ client: fakeClient })
    const e = bridge.spanToEvent(
      makeSpan({
        attributes: {
          'a.string': 'x',
          'a.num': 42,
          'a.bool': true,
          'a.null': null,
          'a.undef': undefined,
        },
      }),
    )
    expect(e.attributes).toEqual({ 'a.string': 'x', 'a.num': 42, 'a.bool': true })
  })

  it('promotes tangle.* attributes to first-class wire fields', () => {
    const bridge = createOtelBridge({ client: fakeClient })
    const e = bridge.spanToEvent(
      makeSpan({
        attributes: {
          'tangle.runId': 'run-abc',
          'tangle.scenarioId': 'sc-1',
          'tangle.cellId': 'cell-3',
          'tangle.generation': 2,
        },
      }),
    )
    expect(e['tangle.runId']).toBe('run-abc')
    expect(e['tangle.scenarioId']).toBe('sc-1')
    expect(e['tangle.cellId']).toBe('cell-3')
    expect(e['tangle.generation']).toBe(2)
    // The pivot keys remain in attributes too so OTel viewers still see them.
    expect(e.attributes['tangle.runId']).toBe('run-abc')
  })

  it('applies defaultRunId when the span lacks tangle.runId', () => {
    const bridge = createOtelBridge({ client: fakeClient, defaultRunId: 'fallback-run' })
    const e = bridge.spanToEvent(makeSpan({ attributes: { 'http.method': 'GET' } }))
    expect(e['tangle.runId']).toBe('fallback-run')
    expect(e.attributes['tangle.runId']).toBe('fallback-run')
  })

  it('does NOT clobber an explicit tangle.runId with defaultRunId', () => {
    const bridge = createOtelBridge({ client: fakeClient, defaultRunId: 'fallback' })
    const e = bridge.spanToEvent(makeSpan({ attributes: { 'tangle.runId': 'explicit' } }))
    expect(e['tangle.runId']).toBe('explicit')
  })

  it('resolves parentSpanId from either parentSpanId or parentSpanContext()', () => {
    const bridge = createOtelBridge({ client: fakeClient })
    const fromField = bridge.spanToEvent(makeSpan({ parentSpanId: 'p-1' }))
    expect(fromField.parentSpanId).toBe('p-1')
    const fromCtx = bridge.spanToEvent(makeSpan({ parentSpanContext: () => ({ spanId: 'p-2' }) }))
    expect(fromCtx.parentSpanId).toBe('p-2')
    const none = bridge.spanToEvent(makeSpan())
    expect(none.parentSpanId).toBeUndefined()
  })

  it('forwards span events including their attributes + times', () => {
    const bridge = createOtelBridge({ client: fakeClient })
    const e = bridge.spanToEvent(
      makeSpan({
        events: [
          {
            name: 'exception',
            time: [1_700_000_001, 0],
            attributes: { 'exception.message': 'oops', dropme: undefined },
          },
        ],
      }),
    )
    expect(e.events).toHaveLength(1)
    expect(e.events?.[0]?.name).toBe('exception')
    expect(e.events?.[0]?.timeUnixNano).toBe(1_700_000_001_000_000_000)
    expect(e.events?.[0]?.attributes).toEqual({ 'exception.message': 'oops' })
  })

  it('omits attributes on event nodes when none survive cleaning', () => {
    const bridge = createOtelBridge({ client: fakeClient })
    const e = bridge.spanToEvent(
      makeSpan({ events: [{ name: 'tick', time: [1, 0], attributes: { drop: null } }] }),
    )
    expect(e.events?.[0]?.attributes).toBeUndefined()
  })

  it('serialises array-valued attributes as JSON strings', () => {
    const bridge = createOtelBridge({ client: fakeClient })
    const e = bridge.spanToEvent(
      makeSpan({
        attributes: {
          'tool.names': ['search', 'read'],
          numbers: [1, 2, 3],
          bools: [true, false],
        } as Record<string, OtelAttributeValue>,
      }),
    )
    expect(e.attributes['tool.names']).toBe('["search","read"]')
    expect(e.attributes.numbers).toBe('[1,2,3]')
    expect(e.attributes.bools).toBe('[true,false]')
  })
})

// ── E2E: bridge → reference receiver ─────────────────────────────────

const TENANT: TenantConfig = { id: 'acme', key: 'k' }

describe('OTel bridge — E2E against reference receiver', () => {
  let stop: () => Promise<void>
  let baseUrl: string

  beforeEach(async () => {
    const r = await startReceiver([TENANT])
    baseUrl = r.baseUrl
    stop = r.stop
  })

  afterEach(async () => {
    await stop()
  })

  it('batches a set of OTel-shape spans into hosted ingest', async () => {
    const client = createHostedClient({
      endpoint: baseUrl,
      apiKey: TENANT.key,
      tenantId: TENANT.id,
    })
    const bridge = createOtelBridge({ client, defaultRunId: 'run-otel-1', batchSize: 5 })
    const spans: OtelLikeSpan[] = Array.from({ length: 12 }, (_, i) => ({
      spanContext: () => ({ traceId: 't-otel', spanId: `s-${i}` }),
      name: `step-${i}`,
      startTime: [1_700_000_000 + i, 0],
      endTime: [1_700_000_000 + i, 500_000_000],
      attributes: { 'step.index': i },
      status: { code: OTEL_STATUS_OK },
    }))
    await bridge.ingest(spans)

    const res = await fetch(`${baseUrl}/v1/runs/run-otel-1/traces`, {
      headers: {
        Authorization: `Bearer ${TENANT.key}`,
        'X-Tangle-Tenant-Id': TENANT.id,
        'X-Tangle-Wire-Version': '2026-05-26.v1',
      },
    })
    const body = (await res.json()) as { spans: Array<{ spanId: string; name: string }> }
    expect(body.spans).toHaveLength(12)
    expect(body.spans.map((s) => s.spanId).sort()).toEqual(
      spans.map((s) => s.spanContext().spanId).sort(),
    )
  })

  it('invokes onError when the upstream ingest fails', async () => {
    const client = createHostedClient({
      endpoint: baseUrl,
      apiKey: 'wrong-key',
      tenantId: TENANT.id,
      retries: 0,
    })
    const errors: unknown[] = []
    const bridge = createOtelBridge({
      client,
      defaultRunId: 'r',
      onError: (err) => {
        errors.push(err)
      },
    })
    await bridge.ingest([
      {
        spanContext: () => ({ traceId: 't', spanId: 's' }),
        name: 'x',
        startTime: [1, 0],
        endTime: [1, 1],
        attributes: {},
      },
    ])
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/401/)
  })
})
