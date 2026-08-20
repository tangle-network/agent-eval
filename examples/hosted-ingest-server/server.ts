/**
 * Hosted-ingest reference receiver.
 *
 * Minimal Hono-based implementation of `docs/hosted-ingest-spec.md`.
 * Run it locally with:
 *
 *   TENANT_KEY=dev-token TENANT_ID=acme pnpm tsx examples/hosted-ingest-server/server.ts
 *
 * Then point any `selfImprove({ hostedTenant: { endpoint: 'http://localhost:8080', ... } })`
 * at it and watch eval-runs land. Inspect with (all three headers are
 * required; a missing wire version is a 400):
 *
 *   curl -H 'Authorization: Bearer dev-token' \
 *        -H 'X-Tangle-Tenant-Id: acme' \
 *        -H "X-Tangle-Wire-Version: $WIRE_VERSION" \
 *        http://localhost:8080/v1/runs
 *
 * where $WIRE_VERSION is HOSTED_WIRE_VERSION from src/hosted/types.ts; the
 * startup banner prints the accepted value.
 *
 * This IS the executable spec. Any orchestrator (ours included) must
 * behave the same way. When the production orchestrator at
 * `intelligence.tangle.tools` ships, this server stays as the reference —
 * the substrate's E2E roundtrip test (`tests/hosted-roundtrip.test.ts`)
 * binds the same `createReferenceReceiverApp` factory to a random port,
 * so a wire-spec drift between client and reference receiver fails CI.
 */

import { isDeepStrictEqual } from 'node:util'
import { serve } from '@hono/node-server'
import { type Context, Hono } from 'hono'
import type { ZodError } from 'zod'
import {
  EvalRunEventSchema,
  IngestEvalRunsEnvelopeSchema,
  IngestTracesEnvelopeSchema,
  TraceSpanEventSchema,
} from '../../src/hosted/schemas'
import {
  type EvalRunEvent,
  HOSTED_WIRE_VERSION,
  type IngestResponse,
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
  /** key = `${tenantId}#${endpoint}#${idempotencyKey}`. Entries expire after
   *  24h per the wire spec. Prune-on-read keeps the map bounded without a timer. */
  idempotency: Map<string, IdempotencyEntry>
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const MAX_IDEMPOTENCY_KEY_LENGTH = 256
const STATUS_RANK: Record<EvalRunEvent['status'], number> = {
  started: 0,
  'baseline-complete': 1,
  'generation-complete': 2,
  'gate-decided': 3,
  finished: 4,
  errored: 4,
}
const TERMINAL_STATUSES = new Set<EvalRunEvent['status']>(['finished', 'errored'])

export interface ReferenceReceiverHandle {
  app: Hono
  stores: ReferenceReceiverStores
}

function validationReason(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'value'}: ${issue.message}`)
    .join('; ')
}

function idempotencyCacheKey(
  tenantId: string,
  endpoint: 'eval-runs' | 'traces',
  key: string,
): string {
  return `${tenantId}#${endpoint}#${key}`
}

function idempotencyKey(
  c: Context,
): { key: string } | { reject: { status: 400; message: string } } {
  const key = c.req.header('idempotency-key')
  if (!key?.trim()) {
    return { reject: { status: 400, message: 'Idempotency-Key required' } }
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return {
      reject: {
        status: 400,
        message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      },
    }
  }
  return { key }
}

function incomingStateWins(previous: EvalRunEvent, incoming: EvalRunEvent): boolean {
  if (TERMINAL_STATUSES.has(previous.status)) return false
  const rankDifference = STATUS_RANK[incoming.status] - STATUS_RANK[previous.status]
  if (rankDifference !== 0) return rankDifference > 0
  return Date.parse(incoming.timestamp) >= Date.parse(previous.timestamp)
}

function mergeEvalRunEvents(previous: EvalRunEvent, incoming: EvalRunEvent): EvalRunEvent {
  const useIncomingState = incomingStateWins(previous, incoming)
  const generations = new Map(
    previous.generations.map((generation) => [generation.index, generation] as const),
  )
  for (const generation of incoming.generations) {
    if (useIncomingState || !generations.has(generation.index)) {
      generations.set(generation.index, generation)
    }
  }

  const state = useIncomingState ? { ...previous, ...incoming } : previous
  return {
    ...state,
    labels: useIncomingState
      ? { ...previous.labels, ...incoming.labels }
      : { ...incoming.labels, ...previous.labels },
    baseline:
      useIncomingState && incoming.baseline
        ? incoming.baseline
        : (previous.baseline ?? incoming.baseline),
    generations: [...generations.values()].sort((left, right) => left.index - right.index),
  }
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
    const requestKey = idempotencyKey(c)
    if ('reject' in requestKey) {
      return c.json({ error: requestKey.reject.message }, requestKey.reject.status)
    }

    const cacheKey = idempotencyCacheKey(auth.id, 'eval-runs', requestKey.key)
    const cached = stores.idempotency.get(cacheKey)
    if (cached) {
      if (cached.expiresAt > Date.now()) return c.json(cached.response)
      stores.idempotency.delete(cacheKey)
    }

    const rawBody: unknown = await c.req.json().catch(() => null)
    const envelope = IngestEvalRunsEnvelopeSchema.safeParse(rawBody)
    if (!envelope.success) {
      return c.json(
        { error: `invalid eval-runs request: ${validationReason(envelope.error)}` },
        400,
      )
    }

    const rejected: IngestResponse['rejected'] = []
    const now = Date.now()
    for (let i = 0; i < envelope.data.events.length; i++) {
      const parsed = EvalRunEventSchema.safeParse(envelope.data.events[i])
      if (!parsed.success) {
        rejected.push({ index: i, reason: validationReason(parsed.error) })
        continue
      }
      const event = parsed.data
      const existingIdx = stores.runs.findIndex(
        (run) => run.tenantId === auth.id && run.event.runId === event.runId,
      )
      if (existingIdx >= 0) {
        stores.runs[existingIdx] = {
          tenantId: auth.id,
          event: mergeEvalRunEvents(stores.runs[existingIdx]!.event, event),
          receivedAt: now,
        }
      } else {
        stores.runs.push({ tenantId: auth.id, event, receivedAt: now })
      }
    }

    const response: IngestResponse = {
      accepted: envelope.data.events.length - rejected.length,
      rejected,
    }
    stores.idempotency.set(cacheKey, {
      response,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    })
    return c.json(response)
  })

  // ── Ingest: traces ────────────────────────────────────────────────

  app.post('/v1/ingest/traces', async (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)
    const requestKey = idempotencyKey(c)
    if ('reject' in requestKey) {
      return c.json({ error: requestKey.reject.message }, requestKey.reject.status)
    }

    const cacheKey = idempotencyCacheKey(auth.id, 'traces', requestKey.key)
    const cached = stores.idempotency.get(cacheKey)
    if (cached) {
      if (cached.expiresAt > Date.now()) return c.json(cached.response)
      stores.idempotency.delete(cacheKey)
    }

    const rawBody: unknown = await c.req.json().catch(() => null)
    const envelope = IngestTracesEnvelopeSchema.safeParse(rawBody)
    if (!envelope.success) {
      return c.json({ error: `invalid traces request: ${validationReason(envelope.error)}` }, 400)
    }

    const rejected: IngestResponse['rejected'] = []
    const now = Date.now()
    for (let i = 0; i < envelope.data.spans.length; i++) {
      const parsed = TraceSpanEventSchema.safeParse(envelope.data.spans[i])
      if (!parsed.success) {
        rejected.push({ index: i, reason: validationReason(parsed.error) })
        continue
      }
      const existing = stores.traces.find(
        (stored) =>
          stored.tenantId === auth.id &&
          stored.span.traceId === parsed.data.traceId &&
          stored.span.spanId === parsed.data.spanId,
      )
      if (existing) {
        if (!isDeepStrictEqual(existing.span, parsed.data)) {
          rejected.push({
            index: i,
            reason: 'traceId and spanId identify a different stored span',
          })
        }
        continue
      }
      stores.traces.push({ tenantId: auth.id, span: parsed.data, receivedAt: now })
    }

    const response: IngestResponse = {
      accepted: envelope.data.spans.length - rejected.length,
      rejected,
    }
    stores.idempotency.set(cacheKey, {
      response,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    })
    return c.json(response)
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
