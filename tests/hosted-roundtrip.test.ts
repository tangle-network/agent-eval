/**
 * E2E roundtrip for trace spans: hosted client ↔ reference receiver over HTTP.
 *
 * Boots `createReferenceReceiverApp()` on an OS-assigned port, points
 * `createHostedClient()` at it, and verifies the receiver stored what the
 * client sent. The search-ledger half of the wire is proven by real runs of
 * the shipper; see `docs/hosted-ingest-spec.md`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TenantConfig } from '../examples/hosted-ingest-server/server'
import { createHostedClient } from '../src/hosted/client'
import { HOSTED_WIRE_VERSION, type TraceSpanEvent } from '../src/hosted/types'
import { type BoundReceiver, startReceiver } from './_fixtures/hosted-receiver'

const TENANT_A: TenantConfig = { id: 'acme', key: 'a-key' }
const TENANT_B: TenantConfig = { id: 'globex', key: 'b-key' }

function makeTraceSpan(traceId: string, spanId: string, runId: string): TraceSpanEvent {
  return {
    traceId,
    spanId,
    name: 'dispatch',
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000001000000000',
    attributes: { 'scenario.kind': 'unit-test' },
    status: { code: 'OK' },
    'tangle.runId': runId,
    'tangle.generation': 1,
    'tangle.scenarioId': 's-1',
  }
}

describe('hosted-tier E2E roundtrip — wire spec contract', () => {
  let receiver: BoundReceiver

  beforeEach(async () => {
    receiver = await startReceiver([TENANT_A, TENANT_B])
  })

  afterEach(async () => {
    await receiver.stop()
  })

  it('ingests + pivots traces to a runId via tangle.runId', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const spans = [
      makeTraceSpan('t-1', 's-1', 'run-with-traces'),
      makeTraceSpan('t-1', 's-2', 'run-with-traces'),
    ]
    const ingest = await client.ingestTraces(spans)
    expect(ingest.accepted).toBe(2)

    const res = await fetch(`${receiver.baseUrl}/v1/runs/run-with-traces/traces`, {
      headers: {
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { spans: TraceSpanEvent[] }
    expect(body.spans).toHaveLength(2)
    expect(body.spans.map((s) => s.spanId).sort()).toEqual(['s-1', 's-2'])
  })

  it('preserves adjacent nanoseconds exactly', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    await client.ingestTraces([
      {
        ...makeTraceSpan('trace-adjacent', 'span-adjacent', 'run-adjacent-nanoseconds'),
        startTimeUnixNano: '1700000000000000000',
        endTimeUnixNano: '1700000000000000001',
        events: [
          {
            timeUnixNano: '1700000000000000001',
            name: 'next-nanosecond',
          },
        ],
      },
    ])

    const res = await fetch(`${receiver.baseUrl}/v1/runs/run-adjacent-nanoseconds/traces`, {
      headers: {
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
    })
    const body = (await res.json()) as { spans: TraceSpanEvent[] }

    expect(body.spans[0]?.startTimeUnixNano).toBe('1700000000000000000')
    expect(body.spans[0]?.endTimeUnixNano).toBe('1700000000000000001')
    expect(body.spans[0]?.events?.[0]?.timeUnixNano).toBe('1700000000000000001')
    expect(BigInt(body.spans[0]!.endTimeUnixNano) - BigInt(body.spans[0]!.startTimeUnixNano)).toBe(
      1n,
    )
  })

  it('rejects requests when the tenant-id does not match the bearer', async () => {
    // Adversarial: client uses tenant A's key but claims to be tenant B.
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_B.id,
      retries: 0,
    })
    await expect(
      client.ingestTraces([makeTraceSpan('forge-trace', 'forge-span', 'forge-1')]),
    ).rejects.toThrow(/401|invalid/i)
  })

  it('rejects unknown tenant id with 404', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: 'any',
      tenantId: 'ghost-tenant',
      retries: 0,
    })
    await expect(
      client.ingestTraces([makeTraceSpan('ghost-trace', 'ghost-span', 'ghost-1')]),
    ).rejects.toThrow(/404|unknown/i)
  })

  it('honors idempotency-key independently for trace ingest', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const span = makeTraceSpan('trace-idem', 'span-idem', 'trace-run')
    const first = await client.ingestTraces([span], 'trace-key')
    const second = await client.ingestTraces([span], 'trace-key')

    expect(first).toEqual(second)
    expect(
      receiver.stores.traces.filter((entry) => entry.span.traceId === 'trace-idem'),
    ).toHaveLength(1)
  })

  it('deduplicates the same tenant trace and span identity across request keys', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const span = makeTraceSpan('trace-natural-dedup', 'span-natural-dedup', 'trace-run')

    expect((await client.ingestTraces([span])).accepted).toBe(1)
    expect((await client.ingestTraces([span])).accepted).toBe(1)
    const conflicting = await client.ingestTraces([{ ...span, name: 'different-span' }])

    expect(conflicting.accepted).toBe(0)
    expect(conflicting.rejected[0]?.reason).toMatch(/different stored span/)
    expect(
      receiver.stores.traces.filter(
        (entry) =>
          entry.tenantId === TENANT_A.id &&
          entry.span.traceId === span.traceId &&
          entry.span.spanId === span.spanId,
      ),
    ).toHaveLength(1)
  })

  it('rejects malformed trace spans with field-level reasons', async () => {
    const res = await fetch(`${receiver.baseUrl}/v1/ingest/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TENANT_A.key}`,
        'Idempotency-Key': 'malformed-span',
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
      body: JSON.stringify({
        wireVersion: HOSTED_WIRE_VERSION,
        spans: [{ traceId: 'trace-only' }],
      }),
    })
    const body = (await res.json()) as {
      accepted: number
      rejected: Array<{ index: number; reason: string }>
    }

    expect(res.status).toBe(200)
    expect(body.accepted).toBe(0)
    expect(body.rejected[0]?.reason).toMatch(/spanId|name|startTimeUnixNano/)
    expect(receiver.stores.traces).toHaveLength(0)
  })

  it('rejects wire-version mismatch on ingest', async () => {
    // Build the request by hand to send a wrong wire-version header — the
    // typed client would never let us produce this, which is itself part of
    // the contract.
    const res = await fetch(`${receiver.baseUrl}/v1/ingest/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TENANT_A.key}`,
        'Idempotency-Key': 'wrong-header-version',
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': '1970-01-01.v1',
      },
      body: JSON.stringify({
        wireVersion: '1970-01-01.v1',
        spans: [makeTraceSpan('drift-trace', 'drift-span', 'drift')],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/wire version/i)
  })
})
