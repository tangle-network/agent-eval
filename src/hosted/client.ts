/**
 * # Hosted-tier ingest client.
 *
 * Ships search ledgers and trace spans to any orchestrator (ours, a
 * partner's self-hosted one, or a future open implementation) that speaks
 * the wire format in `./types.ts` and `./search-ledger-wire.ts`.
 *
 * Three modes:
 *   - **Ours:** point at `https://orchestrator.tangle.tools` (the host root —
 *     the client appends the versioned `/v1/...` path itself; a trailing
 *     `/v1` on the endpoint is tolerated and normalized away).
 *   - **Self-hosted:** point at whatever URL runs the reference receiver
 *     from `examples/hosted-ingest-server/`.
 *   - **Off (default):** when no tenant is configured, nothing is sent.
 *     Everything stays local.
 *
 * Every call retries network errors, 408, 429 and 5xx. When the server sends
 * `Retry-After`, the client waits exactly that long before the next attempt.
 */

import type { z } from 'zod'
import { IngestResponseSchema, IngestTracesRequestSchema } from './schemas'
import {
  type IngestSearchLedgerRequest,
  IngestSearchLedgerRequestSchema,
  SEARCH_LEDGER_INGEST_PATH,
  type SearchBlobPutResponse,
  SearchBlobPutResponseSchema,
  type SearchLedgerConflict,
  SearchLedgerConflictSchema,
  type SearchLedgerHead,
  SearchLedgerHeadSchema,
  searchBlobPath,
  searchLedgerHeadPath,
} from './search-ledger-wire'
import {
  HOSTED_WIRE_VERSION,
  type HostedWireVersion,
  type IngestResponse,
  type IngestTracesRequest,
  type TraceSpanEvent,
} from './types'

export interface HostedTenant {
  /** Orchestrator endpoint base URL (no trailing slash). Required. */
  endpoint: string
  /** Bearer token issued by the orchestrator. Required. */
  apiKey: string
  /** Tenant id — the orchestrator's primary key for this consumer. Required. */
  tenantId: string
  /** Optional `fetch` override (auth wrappers, custom agent). */
  fetchImpl?: typeof fetch
  /** Per-attempt timeout in ms. Default 30s. */
  timeoutMs?: number
  /** Retries on network errors, 408, 429 and 5xx. Default 2. */
  retries?: number
}

/** A search-ledger batch the store accepted, or the fork or gap it refused. */
export type SearchLedgerIngestOutcome =
  | { status: 'accepted'; head: SearchLedgerHead }
  | { status: 'conflict'; conflict: SearchLedgerConflict }

export interface HostedClient {
  ingestTraces(spans: TraceSpanEvent[], idempotencyKey?: string): Promise<IngestResponse>
  /** The store's head for one search; `nextSequence` 0 when it holds nothing. */
  searchLedgerHead(searchId: string, signal?: AbortSignal): Promise<SearchLedgerHead>
  ingestSearchLedger(
    request: IngestSearchLedgerRequest,
    signal?: AbortSignal,
  ): Promise<SearchLedgerIngestOutcome>
  putSearchBlob(
    sha256: `sha256:${string}`,
    bytes: Uint8Array<ArrayBuffer>,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<SearchBlobPutResponse>
  readonly tenant: HostedTenant
  readonly wireVersion: HostedWireVersion
}

/** A request the server refused, after any retries. */
export class HostedRequestError extends Error {
  readonly status: number
  readonly body: string
  constructor(url: string, status: number, body: string) {
    super(`hosted ${url} failed (${status}): ${body.slice(0, 500)}`)
    this.name = 'HostedRequestError'
    this.status = status
    this.body = body
  }
}

interface HostedRequest {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  body?: string | Uint8Array<ArrayBuffer>
  contentType?: string
  idempotencyKey?: string
  signal?: AbortSignal
  /** Statuses returned to the caller instead of thrown. */
  expected?: readonly number[]
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 256

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** `Retry-After` as milliseconds: delay-seconds or an HTTP date. Null when
 * absent or unreadable, so the caller falls back to its own backoff. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

function backoffMs(attempt: number): number {
  return 2 ** attempt * 200 + Math.random() * 200
}

function normalizeHostedBase(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

function resolveIdempotencyKey(key: string | undefined): string {
  const resolved = key ?? globalThis.crypto.randomUUID()
  if (resolved.trim().length === 0) throw new Error('idempotency key must not be blank')
  if (resolved.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(`idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`)
  }
  return resolved
}

function isRetryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

async function send(
  tenant: HostedTenant,
  request: HostedRequest,
): Promise<{ status: number; json: unknown; url: string }> {
  const timeoutMs = tenant.timeoutMs ?? 30_000
  const maxRetries = tenant.retries ?? 2
  const f: typeof fetch = tenant.fetchImpl ?? ((...args) => fetch(...args))
  const url = `${normalizeHostedBase(tenant.endpoint)}${request.path}`
  const headers: Record<string, string> = {
    authorization: `Bearer ${tenant.apiKey}`,
    'x-tangle-tenant-id': tenant.tenantId,
    'x-tangle-wire-version': HOSTED_WIRE_VERSION,
  }
  if (request.method !== 'GET') {
    headers['idempotency-key'] = resolveIdempotencyKey(request.idempotencyKey)
    headers['content-type'] = request.contentType ?? 'application/json'
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
    let res: Response
    try {
      res = await f(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal,
      })
    } catch (err) {
      if (request.signal?.aborted) throw err
      lastError = err
      if (attempt === maxRetries) throw err
      await sleep(backoffMs(attempt), request.signal)
      continue
    }

    if (!res.ok && !request.expected?.includes(res.status)) {
      const text = await res.text().catch(() => '')
      const error = new HostedRequestError(url, res.status, text)
      if (!isRetryable(res.status) || attempt === maxRetries) throw error
      lastError = error
      await sleep(
        retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt),
        request.signal,
      )
      continue
    }

    try {
      return { status: res.status, json: await res.json(), url }
    } catch (error) {
      throw new Error(`hosted ${url} returned invalid JSON`, { cause: error })
    }
  }
  throw lastError ?? new Error('hosted request exhausted retries')
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown, url: string): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const reason = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || 'value'}: ${issue.message}`)
    .join('; ')
  throw new Error(`hosted ${url} returned an invalid response: ${reason}`)
}

export function createHostedClient(tenant: HostedTenant): HostedClient {
  if (normalizeHostedBase(tenant.endpoint).length === 0) throw new Error('endpoint is required')
  if (tenant.apiKey.trim().length === 0) throw new Error('apiKey is required')
  if (tenant.tenantId.trim().length === 0) throw new Error('tenantId is required')
  if (
    tenant.timeoutMs !== undefined &&
    (!Number.isFinite(tenant.timeoutMs) || tenant.timeoutMs <= 0)
  ) {
    throw new Error('timeoutMs must be greater than 0')
  }
  if (tenant.retries !== undefined && (!Number.isInteger(tenant.retries) || tenant.retries < 0)) {
    throw new Error('retries must be a non-negative integer')
  }

  return {
    tenant,
    wireVersion: HOSTED_WIRE_VERSION,

    async ingestTraces(spans, idempotencyKey) {
      const body: IngestTracesRequest = IngestTracesRequestSchema.parse({
        wireVersion: HOSTED_WIRE_VERSION,
        spans,
      })
      const res = await send(tenant, {
        method: 'POST',
        path: '/v1/ingest/traces',
        body: JSON.stringify(body),
        idempotencyKey,
      })
      return parseResponse(IngestResponseSchema, res.json, res.url)
    },

    async searchLedgerHead(searchId, signal) {
      const res = await send(tenant, {
        method: 'GET',
        path: searchLedgerHeadPath(searchId),
        signal,
      })
      const head = parseResponse(SearchLedgerHeadSchema, res.json, res.url)
      if (head.searchId !== searchId) {
        throw new Error(`hosted ${res.url} returned the head of search ${head.searchId}`)
      }
      return head
    },

    async ingestSearchLedger(request, signal) {
      const body = IngestSearchLedgerRequestSchema.parse(request)
      const last = body.lines.at(-1)!
      const res = await send(tenant, {
        method: 'POST',
        path: SEARCH_LEDGER_INGEST_PATH,
        body: JSON.stringify(body),
        // Equal key exactly when the batch is equal, so a cached response is
        // always the response to these lines.
        idempotencyKey: `search-ledger:${await sha256Hex(
          `${body.searchId}\n${body.runKind}\n${body.fromSequence}\n${body.lines.length}\n${last}`,
        )}`,
        signal,
        expected: [409],
      })
      if (res.status === 409) {
        return {
          status: 'conflict',
          conflict: parseResponse(SearchLedgerConflictSchema, res.json, res.url),
        }
      }
      return { status: 'accepted', head: parseResponse(SearchLedgerHeadSchema, res.json, res.url) }
    },

    async putSearchBlob(sha256, bytes, contentType, signal) {
      const res = await send(tenant, {
        method: 'PUT',
        path: searchBlobPath(sha256),
        body: bytes,
        contentType,
        idempotencyKey: `search-blob:${sha256}`,
        signal,
      })
      const stored = parseResponse(SearchBlobPutResponseSchema, res.json, res.url)
      if (stored.sha256 !== sha256) {
        throw new Error(`hosted ${res.url} acknowledged blob ${stored.sha256}, sent ${sha256}`)
      }
      return stored
    },
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Build a {@link HostedTenant} from env, or `undefined` when ingest is not
 * configured, so a product wires it unconditionally and it stays off until the
 * env is set. Env precedence:
 *   - endpoint:  `TANGLE_INGEST_URL` → `TANGLE_ORCHESTRATOR_URL`
 *   - apiKey:    `TANGLE_INGEST_API_KEY` → `TANGLE_API_KEY`
 *   - tenantId:  `TANGLE_TENANT_ID`
 * A trailing slash on the endpoint is stripped. `overrides` win over env.
 */
export function hostedTenantFromEnv(
  overrides: Partial<HostedTenant> & { env?: Record<string, string | undefined> } = {},
): HostedTenant | undefined {
  const env = overrides.env ?? process.env
  const endpoint = (
    overrides.endpoint ??
    env.TANGLE_INGEST_URL ??
    env.TANGLE_ORCHESTRATOR_URL
  )?.trim()
  const apiKey = (overrides.apiKey ?? env.TANGLE_INGEST_API_KEY ?? env.TANGLE_API_KEY)?.trim()
  const tenantId = (overrides.tenantId ?? env.TANGLE_TENANT_ID)?.trim()
  if (!endpoint || !apiKey || !tenantId) return undefined
  const tenant: HostedTenant = { endpoint: endpoint.replace(/\/+$/, ''), apiKey, tenantId }
  if (overrides.fetchImpl) tenant.fetchImpl = overrides.fetchImpl
  if (overrides.timeoutMs !== undefined) tenant.timeoutMs = overrides.timeoutMs
  if (overrides.retries !== undefined) tenant.retries = overrides.retries
  return tenant
}

/** {@link createHostedClient} over {@link hostedTenantFromEnv}; `undefined`
 * when ingest is not configured. */
export function hostedClientFromEnv(
  overrides: Partial<HostedTenant> & { env?: Record<string, string | undefined> } = {},
): HostedClient | undefined {
  const tenant = hostedTenantFromEnv(overrides)
  return tenant ? createHostedClient(tenant) : undefined
}
