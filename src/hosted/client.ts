/**
 * # Hosted-tier ingest client.
 *
 * Ships eval-run events + trace spans to any orchestrator (ours, a
 * partner's self-hosted one, or a future open implementation) that
 * speaks the wire format in `./types.ts`.
 *
 * Three modes:
 *   - **Ours:** point at `https://orchestrator.tangle.tools` (the host root —
 *     the client appends the versioned `/v1/ingest/...` path itself; a trailing
 *     `/v1` on the endpoint is tolerated and normalized away). We handle ingest
 *     + storage + dashboard.
 *   - **Self-hosted:** point at whatever URL runs the reference receiver
 *     from `examples/hosted-ingest-server/`.
 *   - **Off (default):** when `hostedTenant` is unset, nothing is sent.
 *     Everything stays local.
 */

import {
  IngestEvalRunsRequestSchema,
  IngestResponseSchema,
  IngestTracesRequestSchema,
} from './schemas'
import {
  type EvalRunEvent,
  HOSTED_WIRE_VERSION,
  type HostedWireVersion,
  type IngestEvalRunsRequest,
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
  /** Optional `fetch` override (auth wrappers, custom agent, test mocks). */
  fetchImpl?: typeof fetch
  /** Per-call timeout in ms. Default 30s. */
  timeoutMs?: number
  /** Retries on 5xx / network errors. Default 2. */
  retries?: number
}

export interface HostedClient {
  ingestEvalRun(event: EvalRunEvent, idempotencyKey?: string): Promise<IngestResponse>
  ingestEvalRuns(events: EvalRunEvent[], idempotencyKey?: string): Promise<IngestResponse>
  ingestTraces(spans: TraceSpanEvent[], idempotencyKey?: string): Promise<IngestResponse>
  readonly tenant: HostedTenant
  readonly wireVersion: HostedWireVersion
}

interface RequestOptions {
  idempotencyKey?: string
  signal?: AbortSignal
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 256

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function responseValidationReason(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>
}) {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.map(String).join('.') : 'value'}: ${issue.message}`,
    )
    .join('; ')
}

async function post<TReq>(
  tenant: HostedTenant,
  path: string,
  body: TReq,
  opts: RequestOptions = {},
): Promise<IngestResponse> {
  const timeoutMs = tenant.timeoutMs ?? 30_000
  const maxRetries = tenant.retries ?? 2
  const f: typeof fetch = tenant.fetchImpl ?? ((...args) => fetch(...args))
  const base = normalizeHostedBase(tenant.endpoint)
  const url = `${base}${path}`
  const idempotencyKey = resolveIdempotencyKey(opts.idempotencyKey)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${tenant.apiKey}`,
    'x-tangle-tenant-id': tenant.tenantId,
    'x-tangle-wire-version': HOSTED_WIRE_VERSION,
    'idempotency-key': idempotencyKey,
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ourTimeout = AbortSignal.timeout(timeoutMs)
    const combinedSignal = opts.signal ? AbortSignal.any([opts.signal, ourTimeout]) : ourTimeout
    let res: Response
    try {
      res = await f(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combinedSignal,
      })
    } catch (err) {
      if (opts.signal?.aborted) throw err
      lastError = err
      if (attempt === maxRetries) throw err
      await sleep(2 ** attempt * 200 + Math.random() * 200)
      continue
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const error = new Error(`hosted ingest ${url} failed (${res.status}): ${text.slice(0, 500)}`)
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429
      if (!retryable || attempt === maxRetries) throw error
      lastError = error
      await sleep(2 ** attempt * 200 + Math.random() * 200)
      continue
    }

    let rawResponse: unknown
    try {
      rawResponse = await res.json()
    } catch (error) {
      throw new Error(`hosted ingest ${url} returned invalid JSON`, { cause: error })
    }
    const parsed = IngestResponseSchema.safeParse(rawResponse)
    if (!parsed.success) {
      throw new Error(
        `hosted ingest ${url} returned an invalid response: ${responseValidationReason(parsed.error)}`,
      )
    }
    return parsed.data
  }
  throw lastError ?? new Error('hosted ingest exhausted retries')
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

    async ingestEvalRun(event, idempotencyKey) {
      return this.ingestEvalRuns([event], idempotencyKey)
    },

    async ingestEvalRuns(events, idempotencyKey) {
      const body: IngestEvalRunsRequest = IngestEvalRunsRequestSchema.parse({
        wireVersion: HOSTED_WIRE_VERSION,
        events,
      })
      return post<IngestEvalRunsRequest>(tenant, '/v1/ingest/eval-runs', body, {
        idempotencyKey,
      })
    },

    async ingestTraces(spans, idempotencyKey) {
      const body: IngestTracesRequest = IngestTracesRequestSchema.parse({
        wireVersion: HOSTED_WIRE_VERSION,
        spans,
      })
      return post<IngestTracesRequest>(tenant, '/v1/ingest/traces', body, {
        idempotencyKey,
      })
    },
  }
}

/**
 * Build a `HostedClient` from environment, or `undefined` when ingest is not
 * configured — the canonical, fail-soft wiring every product uses so eval-run +
 * trace provenance lands in the Intelligence dashboard with ONE call:
 *
 *   const hosted = hostedClientFromEnv()
 *   // ...run the loop...
 *   await emitLoopProvenance({ ..., hostedClient: hosted })  // no-op if undefined
 *
 * Returns `undefined` (NOT an error) when any of endpoint / apiKey / tenantId is
 * missing — so a product wires the ship call unconditionally and it stays a
 * no-op until the env is set. Env precedence:
 *   - endpoint:  `TANGLE_INGEST_URL` → `TANGLE_ORCHESTRATOR_URL`
 *   - apiKey:    `TANGLE_INGEST_API_KEY` → `TANGLE_API_KEY`
 *   - tenantId:  `TANGLE_TENANT_ID`
 * A trailing slash on the endpoint is stripped. Pass `overrides` to supply any
 * field directly (e.g. a fixed `tenantId` per product) — overrides win over env.
 */
/**
 * Build a {@link HostedTenant} config from env — the input `selfImprove`'s
 * `hostedTenant` and `emitLoopProvenance` take. Same env precedence + overrides
 * as {@link hostedClientFromEnv}; returns `undefined` (not an error) when any of
 * endpoint / apiKey / tenantId is missing, so a product wires
 * `hostedTenant: hostedTenantFromEnv({ tenantId: 'my-agent' })` unconditionally
 * and it stays off until the env is set.
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

export function hostedClientFromEnv(
  overrides: Partial<HostedTenant> & { env?: Record<string, string | undefined> } = {},
): HostedClient | undefined {
  const tenant = hostedTenantFromEnv(overrides)
  return tenant ? createHostedClient(tenant) : undefined
}
