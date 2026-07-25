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
import { analyzeRuns } from '../src/contract/analyze-runs'
import { createHostedClient, hostedClientFromEnv } from '../src/hosted/client'
import type { InsightReport } from '../src/hosted/index'
import { TraceSpanEventSchema } from '../src/hosted/schemas'
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
          terminalOutcome: 'succeeded',
          executionErrorCount: 0,
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
            terminalOutcome: 'succeeded',
            executionErrorCount: 0,
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

  it('normalizes a versioned endpoint so ingest is not double-prefixed to /v1/v1 (404)', async () => {
    // Regression: the client appends the versioned path (`/v1/ingest/...`)
    // itself, but callers (and the client's own prior doc) routinely pass the
    // versioned base `https://host/v1` — producing `/v1/v1/ingest/...` → 404,
    // silently dropping every event. Both endpoint shapes must hit the route.
    for (const endpoint of [`${receiver.baseUrl}/v1`, `${receiver.baseUrl}/v1/`]) {
      const client = createHostedClient({
        endpoint,
        apiKey: TENANT_A.key,
        tenantId: TENANT_A.id,
        retries: 0,
      })
      const res = await client.ingestEvalRun(makeRunEvent(`normalized-${endpoint.length}`))
      expect(res.accepted).toBe(1)
      expect(res.rejected).toEqual([])
    }
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

  it('accepts generation zero when the baseline is included in the generation stream', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const event = makeRunEvent('run-baseline-generation')
    event.generations = [event.baseline!, ...event.generations]

    const ingest = await client.ingestEvalRun(event)

    expect(ingest.accepted).toBe(1)
    expect(ingest.rejected).toEqual([])
  })

  it('preserves a non-empty insight report through the hosted public type', async () => {
    const insightReport: InsightReport = await analyzeRuns({ runs: [] })
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    await client.ingestEvalRun(makeRunEvent('run-insight', { insightReport }))

    const res = await fetch(`${receiver.baseUrl}/v1/runs/run-insight`, {
      headers: {
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
    })
    const body = (await res.json()) as { run: EvalRunEvent }
    expect(body.run.insightReport).toEqual(insightReport)
  })

  it('rejects malformed nested insight report data', async () => {
    const insightReport = await analyzeRuns({ runs: [] })
    const malformedReport: InsightReport = {
      ...insightReport,
      execution: {
        ...insightReport.execution,
        durationMs: {
          ...insightReport.execution.durationMs,
          histogram: [{ lo: 0, hi: 1, count: -1 }],
        },
      },
    }
    const event = makeRunEvent('run-malformed-insight', { insightReport: malformedReport })
    const res = await fetch(`${receiver.baseUrl}/v1/ingest/eval-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TENANT_A.key}`,
        'Idempotency-Key': 'malformed-insight',
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
      body: JSON.stringify({
        wireVersion: HOSTED_WIRE_VERSION,
        events: [event],
      }),
    })
    const body = (await res.json()) as {
      accepted: number
      rejected: Array<{ reason: string }>
    }

    expect(res.status).toBe(200)
    expect(body.accepted).toBe(0)
    expect(body.rejected[0]?.reason).toMatch(/insightReport.*histogram.*count/i)
    expect(receiver.stores.runs).toHaveLength(0)
  })

  it('merges incremental generation events by generation index', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const first = makeRunEvent('run-incremental', {
      status: 'generation-complete',
      generations: [makeRunEvent('template').generations[0]!],
    })
    const secondGeneration = {
      ...first.generations[0]!,
      index: 2,
      surfaceHash: 'h-cand-2',
      compositeMean: 0.9,
    }
    const second = makeRunEvent('run-incremental', {
      timestamp: '2026-05-27T12:01:00Z',
      status: 'finished',
      baseline: undefined,
      generations: [secondGeneration],
      totalCostUsd: 0.5,
      totalDurationMs: 3400,
    })

    await client.ingestEvalRun(first)
    await client.ingestEvalRun(second)

    const res = await fetch(`${receiver.baseUrl}/v1/runs/run-incremental`, {
      headers: {
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
    })
    const body = (await res.json()) as { run: EvalRunEvent }
    expect(body.run.status).toBe('finished')
    expect(body.run.baseline).toEqual(first.baseline)
    expect(body.run.generations.map((generation) => generation.index)).toEqual([1, 2])
    expect(
      receiver.stores.runs.filter((run) => run.event.runId === 'run-incremental'),
    ).toHaveLength(1)
  })

  it('does not regress a terminal run when delayed lifecycle events arrive', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    const finished = makeRunEvent('run-monotonic', {
      timestamp: '2026-07-24T12:10:00Z',
      status: 'finished',
      labels: { phase: 'final' },
      totalCostUsd: 0.7,
      totalDurationMs: 5000,
    })
    const delayedGeneration = {
      ...finished.generations[0]!,
      index: 2,
      surfaceHash: 'h-delayed',
    }

    await client.ingestEvalRun(finished)
    await client.ingestEvalRun(
      makeRunEvent('run-monotonic', {
        timestamp: '2026-07-24T12:05:00Z',
        status: 'generation-complete',
        labels: { phase: 'stale', delayed: 'true' },
        baseline: undefined,
        generations: [delayedGeneration],
        gateDecision: undefined,
        holdoutLift: undefined,
        totalCostUsd: 0.2,
        totalDurationMs: 1000,
      }),
    )
    await client.ingestEvalRun(
      makeRunEvent('run-monotonic', {
        timestamp: '2026-07-24T12:11:00Z',
        status: 'errored',
        labels: { phase: 'conflicting-terminal' },
        errorMessage: 'late terminal event',
        totalCostUsd: 0.1,
        totalDurationMs: 500,
      }),
    )

    const res = await fetch(`${receiver.baseUrl}/v1/runs/run-monotonic`, {
      headers: {
        Authorization: `Bearer ${TENANT_A.key}`,
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
    })
    const body = (await res.json()) as { run: EvalRunEvent }

    expect(body.run.status).toBe('finished')
    expect(body.run.timestamp).toBe(finished.timestamp)
    expect(body.run.labels).toMatchObject({ phase: 'final', delayed: 'true' })
    expect(body.run.totalCostUsd).toBe(0.7)
    expect(body.run.totalDurationMs).toBe(5000)
    expect(body.run.errorMessage).toBeUndefined()
    expect(body.run.generations.map((generation) => generation.index)).toEqual([1, 2])
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

  it('preserves adjacent nanoseconds exactly', async () => {
    const client = createHostedClient({
      endpoint: receiver.baseUrl,
      apiKey: TENANT_A.key,
      tenantId: TENANT_A.id,
    })
    await client.ingestEvalRun(makeRunEvent('run-adjacent-nanoseconds'))
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

  it('rejects numeric and out-of-range OTLP nanosecond timestamps', () => {
    expect(
      TraceSpanEventSchema.safeParse({
        ...makeTraceSpan('trace-number', 'span-number', 'run-number'),
        startTimeUnixNano: 1_700_000_000_000_000_000,
      }).success,
    ).toBe(false)
    expect(
      TraceSpanEventSchema.safeParse({
        ...makeTraceSpan('trace-overflow', 'span-overflow', 'run-overflow'),
        endTimeUnixNano: '18446744073709551616',
      }).success,
    ).toBe(false)
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

  it('rejects malformed events with field-level reasons', async () => {
    const res = await fetch(`${receiver.baseUrl}/v1/ingest/eval-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TENANT_A.key}`,
        'Idempotency-Key': 'malformed-event',
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
      body: JSON.stringify({
        wireVersion: HOSTED_WIRE_VERSION,
        events: [{ runId: 'old-shape-only' }],
      }),
    })
    const body = (await res.json()) as {
      accepted: number
      rejected: Array<{ index: number; reason: string }>
    }

    expect(res.status).toBe(200)
    expect(body.accepted).toBe(0)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0]?.reason).toMatch(/runDir|timestamp|status|labels/)
    expect(receiver.stores.runs).toHaveLength(0)
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
    const res = await fetch(`${receiver.baseUrl}/v1/ingest/eval-runs`, {
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
        events: [makeRunEvent('drift')],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/wire version/i)
  })

  it('rejects a body wire version that disagrees with the accepted header', async () => {
    const res = await fetch(`${receiver.baseUrl}/v1/ingest/eval-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TENANT_A.key}`,
        'Idempotency-Key': 'wrong-body-version',
        'X-Tangle-Tenant-Id': TENANT_A.id,
        'X-Tangle-Wire-Version': HOSTED_WIRE_VERSION,
      },
      body: JSON.stringify({
        wireVersion: '2026-05-26.v1',
        events: [makeRunEvent('body-drift')],
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/wireVersion/)
    expect(receiver.stores.runs).toHaveLength(0)
  })
})

describe('hosted client transport', () => {
  it('reuses one automatic idempotency key across retries', async () => {
    const keys: Array<string | null> = []
    let calls = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1
      keys.push(new Headers(init?.headers).get('idempotency-key'))
      if (calls === 1) {
        return new Response(JSON.stringify({ error: 'temporary' }), { status: 503 })
      }
      return new Response(JSON.stringify({ accepted: 1, rejected: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const client = createHostedClient({
      endpoint: 'https://host.example/v1/',
      apiKey: 'key',
      tenantId: 'tenant',
      retries: 1,
      fetchImpl,
    })

    await expect(client.ingestEvalRun(makeRunEvent('retry-key'))).resolves.toEqual({
      accepted: 1,
      rejected: [],
    })
    expect(calls).toBe(2)
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(keys[1]).toBe(keys[0])
  })

  it('does not retry a non-retryable 4xx response', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 })
    }
    const client = createHostedClient({
      endpoint: 'https://host.example',
      apiKey: 'key',
      tenantId: 'tenant',
      retries: 3,
      fetchImpl,
    })

    await expect(client.ingestEvalRun(makeRunEvent('no-4xx-retry'))).rejects.toThrow(/400/)
    expect(calls).toBe(1)
  })

  it('rejects a malformed success response without retrying', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ accepted: -1, rejected: [42] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const client = createHostedClient({
      endpoint: 'https://host.example',
      apiKey: 'key',
      tenantId: 'tenant',
      retries: 3,
      fetchImpl,
    })

    await expect(client.ingestEvalRun(makeRunEvent('bad-response'))).rejects.toThrow(
      /invalid response/,
    )
    expect(calls).toBe(1)
  })
})

describe('hostedClientFromEnv', () => {
  const base = {
    TANGLE_INGEST_URL: undefined,
    TANGLE_ORCHESTRATOR_URL: undefined,
    TANGLE_INGEST_API_KEY: undefined,
    TANGLE_API_KEY: undefined,
    TANGLE_TENANT_ID: undefined,
  } as Record<string, string | undefined>

  it('returns undefined when ingest is not configured (fail-soft no-op)', () => {
    expect(hostedClientFromEnv({ env: { ...base } })).toBeUndefined()
    // partial config is still undefined — all three are required
    expect(
      hostedClientFromEnv({ env: { ...base, TANGLE_INGEST_URL: 'https://x/v1' } }),
    ).toBeUndefined()
    expect(
      hostedClientFromEnv({
        env: { ...base, TANGLE_INGEST_URL: 'https://x/v1', TANGLE_API_KEY: 'k' },
      }),
    ).toBeUndefined()
  })

  it('builds a client when endpoint + key + tenant are present, stripping a trailing slash', () => {
    const c = hostedClientFromEnv({
      env: {
        ...base,
        TANGLE_INGEST_URL: 'https://intelligence.tangle.tools/v1/',
        TANGLE_API_KEY: 'router-key',
        TANGLE_TENANT_ID: 'gtm-agent',
      },
    })
    expect(c).toBeDefined()
    expect(c!.tenant.endpoint).toBe('https://intelligence.tangle.tools/v1')
    expect(c!.tenant.apiKey).toBe('router-key')
    expect(c!.tenant.tenantId).toBe('gtm-agent')
  })

  it('honors env precedence: INGEST_URL over ORCHESTRATOR_URL, INGEST_API_KEY over API_KEY', () => {
    const c = hostedClientFromEnv({
      env: {
        ...base,
        TANGLE_INGEST_URL: 'https://ingest/v1',
        TANGLE_ORCHESTRATOR_URL: 'https://orchestrator/v1',
        TANGLE_INGEST_API_KEY: 'ingest-key',
        TANGLE_API_KEY: 'router-key',
        TANGLE_TENANT_ID: 't',
      },
    })!
    expect(c.tenant.endpoint).toBe('https://ingest/v1')
    expect(c.tenant.apiKey).toBe('ingest-key')
  })

  it('falls back to ORCHESTRATOR_URL + API_KEY when the INGEST_* vars are absent', () => {
    const c = hostedClientFromEnv({
      env: {
        ...base,
        TANGLE_ORCHESTRATOR_URL: 'https://orchestrator/v1',
        TANGLE_API_KEY: 'router-key',
        TANGLE_TENANT_ID: 't',
      },
    })!
    expect(c.tenant.endpoint).toBe('https://orchestrator/v1')
    expect(c.tenant.apiKey).toBe('router-key')
  })

  it('overrides win over env (e.g. a fixed per-product tenant label)', () => {
    const c = hostedClientFromEnv({
      tenantId: 'legal-agent',
      env: {
        ...base,
        TANGLE_INGEST_URL: 'https://x/v1',
        TANGLE_API_KEY: 'k',
        TANGLE_TENANT_ID: 'ignored',
      },
    })!
    expect(c.tenant.tenantId).toBe('legal-agent')
  })
})
