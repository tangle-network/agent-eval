/**
 * Hosted-ingest reference receiver.
 *
 * A minimal, in-memory Hono implementation of `docs/hosted-ingest-spec.md`:
 * search-ledger blobs, heads and entries, and trace spans. Run it with:
 *
 *   TENANT_KEY=dev-token TENANT_ID=acme pnpm tsx examples/hosted-ingest-server/server.ts
 *
 * then ship a ledger to it:
 *
 *   TANGLE_INGEST_URL=http://localhost:8080 TANGLE_INGEST_API_KEY=dev-token \
 *   TANGLE_TENANT_ID=acme agent-eval search ship runs/x/search-ledger.jsonl --run-kind optimization
 *
 * It applies the same rules a production store must: every line is verified
 * and linked to the stored head with `admitSearchLedgerBatch`, every accepted
 * entry passes the `SearchState` state machine, blobs are re-hashed, and a
 * fork or gap answers 409 with the store's head. A closed search's claim is
 * made again from the stored entries (`verifySearchClaim`), so the store
 * reports what the ledger supports, not what the producer wrote. Storage is
 * in memory on purpose: this file is a reference for receiver behavior, not a
 * database.
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { serve } from '@hono/node-server'
import { type Context, Hono } from 'hono'
import type { ZodError } from 'zod'
import { verifySearchClaim } from '../../src/campaign/search-claim'
import { SearchLedgerError } from '../../src/campaign/search-ledger'
import type { SearchLedgerHash } from '../../src/campaign/search-ledger-types'
import { SearchState } from '../../src/campaign/search-state'
import { IngestTracesEnvelopeSchema, TraceSpanEventSchema } from '../../src/hosted/schemas'
import {
  admitSearchLedgerBatch,
  IngestSearchLedgerRequestSchema,
  SEARCH_LEDGER_INGEST_PATH,
  type SearchBlobPutResponse,
  type SearchLedgerHead,
  type SearchRunKind,
} from '../../src/hosted/search-ledger-wire'
import {
  HOSTED_WIRE_VERSION,
  type IngestResponse,
  type TraceSpanEvent,
} from '../../src/hosted/types'

export interface TenantConfig {
  id: string
  key: string
}

interface StoredSpan {
  tenantId: string
  span: TraceSpanEvent
  receivedAt: number
}

interface StoredSearch {
  tenantId: string
  searchId: string
  runKind: SearchRunKind
  lines: string[]
  hashes: SearchLedgerHash[]
  state: SearchState
}

interface IdempotencyEntry {
  response: IngestResponse
  expiresAt: number
}

export interface ReferenceReceiverStores {
  traces: StoredSpan[]
  /** key = `${tenantId}#${searchId}` */
  searches: Map<string, StoredSearch>
  /** key = `${tenantId}#${sha256}` */
  blobs: Map<string, Uint8Array>
  /** Trace ingest responses by `${tenantId}#${idempotencyKey}`. Entries expire
   *  after 24h per the wire spec; search routes are idempotent by content. */
  idempotency: Map<string, IdempotencyEntry>
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const MAX_IDEMPOTENCY_KEY_LENGTH = 256

export interface ReferenceReceiverHandle {
  app: Hono
  stores: ReferenceReceiverStores
}

function validationReason(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'value'}: ${issue.message}`)
    .join('; ')
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

function headOf(search: StoredSearch | undefined, searchId: string): SearchLedgerHead {
  if (!search || search.lines.length === 0) return { searchId, nextSequence: 0, headHash: null }
  return { searchId, nextSequence: search.lines.length, headHash: search.hashes.at(-1)! }
}

/**
 * Build a Hono app implementing the hosted-ingest spec. Each call returns
 * fresh in-memory stores, so a caller can bind isolated receivers.
 */
export function createReferenceReceiverApp(opts: {
  tenants: TenantConfig[]
}): ReferenceReceiverHandle {
  const { tenants } = opts
  const stores: ReferenceReceiverStores = {
    traces: [],
    searches: new Map(),
    blobs: new Map(),
    idempotency: new Map(),
  }
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true, wireVersion: HOSTED_WIRE_VERSION }))

  // ── Search ledger: blobs ──────────────────────────────────────────

  app.put('/v1/search-blobs/:hex', async (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)
    const hex = c.req.param('hex')
    if (!/^[a-f0-9]{64}$/.test(hex)) return c.json({ error: 'expected a sha256 hex digest' }, 400)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== hex) {
      return c.json({ error: 'digest_mismatch', message: `bytes hash to sha256:${actual}` }, 422)
    }
    stores.blobs.set(`${auth.id}#sha256:${hex}`, bytes)
    const response: SearchBlobPutResponse = {
      sha256: `sha256:${hex}`,
      byteLength: bytes.byteLength,
      state: 'stored',
    }
    return c.json(response)
  })

  // ── Search ledger: head and entries ───────────────────────────────

  app.get(`${SEARCH_LEDGER_INGEST_PATH}/:searchId/head`, (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)
    const searchId = c.req.param('searchId')
    return c.json(headOf(stores.searches.get(`${auth.id}#${searchId}`), searchId))
  })

  app.post(SEARCH_LEDGER_INGEST_PATH, async (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)
    const parsed = IngestSearchLedgerRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: validationReason(parsed.error) }, 400)
    }
    const request = parsed.data
    const key = `${auth.id}#${request.searchId}`
    const existing = stores.searches.get(key)
    if (existing && existing.runKind !== request.runKind) {
      return c.json(
        {
          error: 'invalid_request',
          message: `search ${request.searchId} is a ${existing.runKind} run, not ${request.runKind}`,
        },
        422,
      )
    }
    const head = headOf(existing, request.searchId)
    let admission: ReturnType<typeof admitSearchLedgerBatch>
    try {
      admission = admitSearchLedgerBatch({
        request,
        head,
        storedEntryHash: (sequence) => existing?.hashes[sequence],
      })
    } catch (error) {
      if (!(error instanceof SearchLedgerError)) throw error
      return c.json({ error: 'invalid_entry', message: error.message }, 422)
    }
    if (admission.status === 'conflict') return c.json(admission.conflict, 409)
    const search: StoredSearch = existing ?? {
      tenantId: auth.id,
      searchId: request.searchId,
      runKind: request.runKind,
      lines: [],
      hashes: [],
      state: new SearchState(request.searchId),
    }
    try {
      for (const entry of admission.entries) search.state.apply(entry, entry.sequence)
    } catch (error) {
      // The state machine may have applied part of the batch; rebuild it from
      // what is stored so the refused batch leaves no trace.
      search.state = new SearchState(request.searchId)
      search.lines.forEach((line, sequence) => {
        search.state.apply(JSON.parse(line), sequence)
      })
      if (!(error instanceof SearchLedgerError)) throw error
      return c.json({ error: 'invalid_entry', message: error.message }, 422)
    }
    search.lines.push(...admission.lines)
    search.hashes.push(...admission.entries.map((entry) => entry.entryHash))
    stores.searches.set(key, search)
    return c.json(admission.head)
  })

  // ── Read: one search's head and audit ─────────────────────────────

  app.get('/v1/searches/:searchId', (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)
    const searchId = c.req.param('searchId')
    const search = stores.searches.get(`${auth.id}#${searchId}`)
    if (!search) return c.json({ error: 'search not found' }, 404)
    const view = search.state.snapshot()
    return c.json({
      head: headOf(search, searchId),
      runKind: search.runKind,
      audit: view.audit,
      closed: view.closed,
      claimVerification: view.closed ? verifySearchClaim(view) : null,
    })
  })

  // ── Ingest: traces ────────────────────────────────────────────────

  app.post('/v1/ingest/traces', async (c) => {
    const auth = authenticate(c, tenants)
    if ('reject' in auth) return c.json({ error: auth.reject.message }, auth.reject.status)
    const requestKey = idempotencyKey(c)
    if ('reject' in requestKey) {
      return c.json({ error: requestKey.reject.message }, requestKey.reject.status)
    }

    const cacheKey = `${auth.id}#${requestKey.key}`
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
  // directly via the file path.
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
    `  curl -H 'Authorization: Bearer ${DEFAULT_TENANTS[0]!.key}' -H 'X-Tangle-Tenant-Id: ${DEFAULT_TENANTS[0]!.id}' -H 'X-Tangle-Wire-Version: ${HOSTED_WIRE_VERSION}' http://localhost:${port}/v1/searches/<searchId>`,
  )

  process.on('SIGINT', () => {
    console.log('\nshutting down...')
    if (typeof (handle as { close?: () => void }).close === 'function') {
      ;(handle as { close: () => void }).close()
    }
    process.exit(0)
  })
}
