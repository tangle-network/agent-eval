/**
 * Hosted-ingest reference receiver.
 *
 * Minimal hono-based implementation of `docs/hosted-ingest-spec.md`.
 * ~250 lines. Run it locally with:
 *
 *   TENANT_KEY=dev-token TENANT_ID=acme pnpm tsx examples/hosted-ingest-server/server.ts
 *
 * Then point any `selfImprove({ hostedTenant: { endpoint: 'http://localhost:8080', ... } })`
 * at it and watch eval-runs land. Inspect with:
 *
 *   curl -H 'Authorization: Bearer dev-token' \
 *        -H 'X-Tangle-Tenant-Id: acme' \
 *        http://localhost:8080/v1/runs
 *
 * This IS the executable spec. Any orchestrator (ours included) must
 * behave the same way. When the production orchestrator at
 * `intelligence.tangle.tools` ships, this server stays as the reference —
 * the substrate's E2E roundtrip test (`tests/hosted-roundtrip.test.ts`)
 * binds the same `createReferenceReceiverApp` factory to a random port,
 * so a wire-spec drift between client and reference receiver fails CI.
 */

import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import {
  HOSTED_WIRE_VERSION,
  type EvalRunEvent,
  type IngestEvalRunsRequest,
  type IngestResponse,
  type IngestTracesRequest,
  type TraceSpanEvent,
} from '../../src/hosted/types'

export interface TenantConfig {
  id: string
  key: string
}

interface StoredRun {
  tenantId: string
  event: EvalRunEvent
  receivedAt: number
}
interface StoredSpan {
  tenantId: string
  span: TraceSpanEvent
  receivedAt: number
}

interface IdempotencyEntry {
  response: IngestResponse
  expiresAt: number
}

export interface ReferenceReceiverStores {
  runs: StoredRun[]
  traces: StoredSpan[]
  /** key = `${tenantId}#${idempotencyKey}` — entries expire after 24h per
   *  the wire spec. Prune-on-read keeps the map bounded without a timer. */
  idempotency: Map<string, IdempotencyEntry>
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

export interface ReferenceReceiverHandle {
  app: Hono
  stores: ReferenceReceiverStores
}

function authenticate(
  c: Context,
  tenants: TenantConfig[],
): TenantConfig | { reject: { status: 401 | 404 | 400; message: string } } {
  const auth = c.req.header('authorization') ?? ''
  const tenantId = c.req.header('x-tangle-tenant-id') ?? ''
  const wireVersion = c.req.header('x-tangle-wire-version') ?? ''

  if (!auth.startsWith('Bearer '))
    return { reject: { status: 401, message: 'missing or malformed Authorization' } }
  if (!tenantId) return { reject: { status: 404, message: 'X-Tangle-Tenant-Id required' } }
  if (wireVersion !== HOSTED_WIRE_VERSION) {
    return {
      reject: {
        status: 400,
        message: `unsupported wire version: ${wireVersion}. Accepted: ${HOSTED_WIRE_VERSION}`,
      },
    }
  }

  const token = auth.slice('Bearer '.length)
  const tenant = tenants.find((t) => t.id === tenantId)
  if (!tenant) return { reject: { status: 404, message: `unknown tenant: ${tenantId}` } }
  if (tenant.key !== token) return { reject: { status: 401, message: 'invalid bearer token' } }

  return tenant
}

/**
 * Build a Hono app implementing the hosted-ingest spec. Each call returns
 * fresh in-memory stores — tests use this factory to bind isolated receivers
 * per test case; the server entry point at the bottom of this file uses a
 * single default instance.
 */
export function createReferenceReceiverApp(opts: {
  tenants: TenantConfig[]
}): ReferenceReceiverHandle {
  const { tenants } = opts
  const stores: ReferenceReceiverStores = {
    runs: [],
    traces: [],
    idempotency: new Map(),
  }
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true, wireVersion: HOSTED_WIRE_VERSION }))

  // ── Ingest: eval-runs ─────────────────────────────────────────────

  app.post('/v1/ingest/eval-runs', async (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)

    const idempotencyKey = c.req.header('idempotency-key')
    const cacheKey = idempotencyKey ? `${auth.id}#${idempotencyKey}` : null
    if (cacheKey) {
      const entry = stores.idempotency.get(cacheKey)
      if (entry) {
        if (entry.expiresAt > Date.now()) return c.json(entry.response)
        // Expired — prune-on-read.
        stores.idempotency.delete(cacheKey)
      }
    }

    const body = (await c.req.json().catch(() => null)) as IngestEvalRunsRequest | null
    if (!body || !Array.isArray(body.events)) {
      return c.json({ error: 'body must be { wireVersion, events: EvalRunEvent[] }' }, 400)
    }

    const rejected: IngestResponse['rejected'] = []
    const now = Date.now()
    for (let i = 0; i < body.events.length; i++) {
      const event = body.events[i]
      if (!event || typeof event !== 'object') {
        rejected.push({ index: i, reason: 'event is not an object' })
        continue
      }
      if (!event.runId || typeof event.runId !== 'string') {
        rejected.push({ index: i, reason: 'event.runId missing or not a string' })
        continue
      }
      // Dedup within the tenant on (runId, status). Later events for the
      // same lifecycle stage of the same run overwrite the prior snapshot.
      const existingIdx = stores.runs.findIndex(
        (r) => r.tenantId === auth.id && r.event.runId === event.runId && r.event.status === event.status,
      )
      if (existingIdx >= 0) {
        stores.runs[existingIdx] = { tenantId: auth.id, event, receivedAt: now }
      } else {
        stores.runs.push({ tenantId: auth.id, event, receivedAt: now })
      }
    }

    const response: IngestResponse = { accepted: body.events.length - rejected.length, rejected }
    if (cacheKey) {
      stores.idempotency.set(cacheKey, {
        response,
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      })
    }
    return c.json(response)
  })

  // ── Ingest: traces ────────────────────────────────────────────────

  app.post('/v1/ingest/traces', async (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)

    const body = (await c.req.json().catch(() => null)) as IngestTracesRequest | null
    if (!body || !Array.isArray(body.spans)) {
      return c.json({ error: 'body must be { wireVersion, spans: TraceSpanEvent[] }' }, 400)
    }

    const rejected: IngestResponse['rejected'] = []
    const now = Date.now()
    for (let i = 0; i < body.spans.length; i++) {
      const span = body.spans[i]
      if (!span || !span.traceId || !span.spanId) {
        rejected.push({ index: i, reason: 'span missing traceId or spanId' })
        continue
      }
      stores.traces.push({ tenantId: auth.id, span, receivedAt: now })
    }

    return c.json({ accepted: body.spans.length - rejected.length, rejected })
  })

  // ── Read: list runs for a tenant ──────────────────────────────────

  app.get('/v1/runs', (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)

    const runs = stores.runs
      .filter((r) => r.tenantId === auth.id)
      .map((r) => ({
        runId: r.event.runId,
        status: r.event.status,
        gateDecision: r.event.gateDecision,
        holdoutLift: r.event.holdoutLift,
        totalCostUsd: r.event.totalCostUsd,
        timestamp: r.event.timestamp,
        labels: r.event.labels,
        generations: r.event.generations.length,
      }))
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))

    return c.json({ runs })
  })

  // ── Read: one run with full per-cell detail ───────────────────────

  app.get('/v1/runs/:runId', (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)

    const runId = c.req.param('runId')
    const stored = stores.runs.find((r) => r.tenantId === auth.id && r.event.runId === runId)
    if (!stored) return c.json({ error: 'run not found' }, 404)

    return c.json({ run: stored.event })
  })

  // ── Read: traces for a runId ──────────────────────────────────────

  app.get('/v1/runs/:runId/traces', (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)

    const runId = c.req.param('runId')
    const spans = stores.traces
      .filter((t) => t.tenantId === auth.id && t.span['tangle.runId'] === runId)
      .map((t) => t.span)

    return c.json({ spans })
  })

  return { app, stores }
}

// ── Default server entry point ──────────────────────────────────────

const DEFAULT_TENANTS: TenantConfig[] = [
  { id: process.env.TENANT_ID ?? 'acme', key: process.env.TENANT_KEY ?? 'dev-token' },
]

const isEntryPoint = (() => {
  // Auto-start when REFERENCE_RECEIVER_START=1 (preferred) or when invoked
  // directly via the file path. The env var is the primary signal so tests
  // and unusual invocation styles (different cwd, packed dist, etc.) get a
  // single deterministic way to opt in.
  if (process.env.REFERENCE_RECEIVER_START === '1') return true
  if (process.env.REFERENCE_RECEIVER_START === '0') return false
  const entry = process.argv[1] ?? ''
  return (
    entry.endsWith('hosted-ingest-server/server.ts') ||
    entry.endsWith('hosted-ingest-server/server.js') ||
    entry.endsWith('hosted-ingest-server\\server.ts') ||
    entry.endsWith('hosted-ingest-server\\server.js')
  )
})()

if (isEntryPoint) {
  const { app } = createReferenceReceiverApp({ tenants: DEFAULT_TENANTS })
  const port = Number.parseInt(process.env.PORT ?? '8080', 10)
  const handle = serve({ fetch: app.fetch, port })
  console.log(`hosted-ingest reference receiver listening on http://localhost:${port}`)
  console.log(`wire version: ${HOSTED_WIRE_VERSION}`)
  console.log(`tenants:`)
  for (const t of DEFAULT_TENANTS) console.log(`  id=${t.id} key=${t.key}`)
  console.log(`\nTry:`)
  console.log(`  curl http://localhost:${port}/healthz`)
  console.log(
    `  curl -H 'Authorization: Bearer ${DEFAULT_TENANTS[0]!.key}' -H 'X-Tangle-Tenant-Id: ${DEFAULT_TENANTS[0]!.id}' -H 'X-Tangle-Wire-Version: ${HOSTED_WIRE_VERSION}' http://localhost:${port}/v1/runs`,
  )

  process.on('SIGINT', () => {
    console.log('\nshutting down...')
    if (typeof (handle as { close?: () => void }).close === 'function') {
      ;(handle as { close: () => void }).close()
    }
    process.exit(0)
  })
}
