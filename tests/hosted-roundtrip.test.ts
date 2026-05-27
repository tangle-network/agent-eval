/**
 * E2E roundtrip: substrate hosted-client ↔ reference receiver.
 *
 * Boots `createReferenceReceiverApp()` on an OS-assigned port, points
 * `createHostedClient()` at it, exercises the full wire spec, and verifies
 * the receiver stored what the client sent. Any wire-spec drift between
 * client and receiver fails this test — that's the regression class this
 * file defends. Production orchestrators (ours included) must keep the same
 * surface, so when ADC's intelligence-api ships we point a sibling test at
 * its deployed URL with the same body.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TenantConfig } from '../examples/hosted-ingest-server/server'
import { createHostedClient } from '../src/hosted/client'
import { type EvalRunEvent, HOSTED_WIRE_VERSION, type TraceSpanEvent } from '../src/hosted/types'
import { type BoundReceiver, startReceiver } from './_fixtures/hosted-receiver'

const TENANT_A: TenantConfig = { id: 'acme', key: 'a-key' }
const TENANT_B: TenantConfig = { id: 'globex', key: 'b-key' }

function makeRunEvent(runId: string, overrides: Partial<EvalRunEvent> = {}): EvalRunEvent {
  return {
    runId,
    runDir: `/runs/${runId}`,
    timestamp: '2026-05-27T12:00:00Z',
    status: 'finished',
    labels: { env: 'test' },
    baseline: {
      index: 0,
      surfaceHash: 'h-base',
      cells: [
        {
          scenarioId: 's-1',
          rep: 0,
          compositeMean: 0.5,
          dimensions: { llm: { accuracy: 0.5 } },
        },
      ],
      compositeMean: 0.5,
      costUsd: 0.1,
      durationMs: 1000,
    },
    generations: [
      {
        index: 1,
        surfaceHash: 'h-cand',
        cells: [
          {
            scenarioId: 's-1',
            rep: 0,
            compositeMean: 0.8,
            dimensions: { llm: { accuracy: 0.8 } },
          },
        ],
        compositeMean: 0.8,
        costUsd: 0.2,
        durationMs: 1200,
      },
    ],
    gateDecision: 'ship',
    holdoutLift: 0.3,
    totalCostUsd: 0.3,
    totalDurationMs: 2200,
    ...overrides,
  }
}

function makeTraceSpan(traceId: string, spanId: string, runId: string): TraceSpanEvent {
  return {
    traceId,
    spanId,
    name: 'dispatch',
    startTimeUnixNano: 1_700_000_000_000_000_000,
    endTimeUnixNano: 1_700_000_001_000_000_000,
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

  it('ingests + reads back an eval-run event for the authenticated tenant', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const event = makeRunEvent('run-1')

    const res = await client.ingestEvalRun(event)
    expect(res.accepted).toBe(1)
    expect(res.rejected).toEqual([])

    // Read back via the receiver's list endpoint using the SAME auth pattern.
    const listRes = await fetch(`${receiver.baseUrl}/v1/runs`, {
      headers: {
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
    })
    expect(listRes.status).toBe(200)
    const body = (await listRes.json()) as { runs: Array<{ runId: string; status: string }> }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]?.runId).toBe('run-1')
    expect(body.runs[0]?.status).toBe('finished')
  })

  it('preserves full event payload on /v1/runs/:runId read', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const event = makeRunEvent('run-detail')
    await client.ingestEvalRun(event)

    const res = await fetch(`${receiver.baseUrl}/v1/runs/run-detail`, {
      headers: {
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { run: EvalRunEvent }
    // Verify the entire event roundtrips intact — this is the wire-format
    // contract proof. If a field disappears between send and receive,
    // we want THIS test to fail before any consumer experiences it.
    expect(body.run).toEqual(event)
  })

  it('ingests + pivots traces to a runId via tangle.runId', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    await client.ingestEvalRun(makeRunEvent('run-with-traces'))
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

  it('rejects requests when the tenant-id does not match the bearer', async () => {
    // Adversarial: client uses tenant A's key but claims to be tenant B.
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_B.id,
      retries: 0,
    })
    await expect(client.ingestEvalRun(makeRunEvent('forge-1'))).rejects.toThrow(/401|invalid/i)
  })

  it('rejects unknown tenant id with 404', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: 'any',
      tenantId: 'ghost-tenant',
      retries: 0,
    })
    await expect(client.ingestEvalRun(makeRunEvent('ghost-1'))).rejects.toThrow(/404|unknown/i)
  })

  it('isolates stores per tenant on reads', async () => {
    const clientA = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const clientB = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_B.key,
      tenantId: TENANT_B.id,
    })
    await clientA.ingestEvalRun(makeRunEvent('tenant-a-run'))
    await clientB.ingestEvalRun(makeRunEvent('tenant-b-run'))

    const listA = await fetch(`${receiver.baseUrl}/v1/runs`, {
      headers: {
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
    })
    const bodyA = (await listA.json()) as { runs: Array<{ runId: string }> }
    expect(bodyA.runs.map((r) => r.runId)).toEqual(['tenant-a-run'])

    // Tenant A trying to read tenant B's run should 404, not 200.
    const xRead = await fetch(`${receiver.baseUrl}/v1/runs/tenant-b-run`, {
      headers: {
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
    })
    expect(xRead.status).toBe(404)
  })

  it('honors idempotency-key for retry-safe ingest', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const event = makeRunEvent('idem-1')
    const first = await client.ingestEvalRun(event, 'key-abc')
    const second = await client.ingestEvalRun(event, 'key-abc')
    expect(first).toEqual(second)
    // Receiver only stored the run once because the second call hit the
    // idempotency cache before any side effect.
    expect(receiver.stores.runs.filter((r) => r.event.runId === 'idem-1')).toHaveLength(1)
  })

  it('rejects wire-version mismatch on ingest', async () => {
    // Build the request by hand to send a wrong wire-version header — the
    // typed client would never let us produce this, which is itself part of
    // the contract.
    const res = await fetch(`${receiver.baseUrl}/v1/ingest/eval-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': '1970-01-01.v1',
      },
      body: JSON.stringify({
        wireVersion: '1970-01-01.v1',
        events: [makeRunEvent('drift')],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/wire version/i)
  })
})
