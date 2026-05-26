/**
 * # Hosted-tier ingest client.
 *
 * Ships eval-run events + trace spans to any orchestrator (ours, a
 * partner's self-hosted one, or a future open implementation) that
 * speaks the wire format in `./types.ts`.
 *
 * Three modes:
 *   - **Ours:** point at `https://orchestrator.tangle.tools/v1`. We
 *     handle ingest + storage + dashboard.
 *   - **Self-hosted:** point at whatever URL runs the reference receiver
 *     from `examples/hosted-ingest-server/`.
 *   - **Off (default):** when `hostedTenant` is unset, nothing is sent.
 *     Everything stays local.
 */

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof (t as { unref?: () => void }).unref === 'function')
      (t as { unref: () => void }).unref()
  })
}

async function post<TReq, TRes>(
  tenant: HostedTenant,
  path: string,
  body: TReq,
  opts: RequestOptions = {},
): Promise<TRes> {
  const timeoutMs = tenant.timeoutMs ?? 30_000
  const maxRetries = tenant.retries ?? 2
  const f: typeof fetch = tenant.fetchImpl ?? ((...args) => fetch(...args))
  const url = `${tenant.endpoint.replace(/\/$/, '')}${path}`

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ourTimeout = AbortSignal.timeout(timeoutMs)
    const combinedSignal = opts.signal ? AbortSignal.any([opts.signal, ourTimeout]) : ourTimeout
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${tenant.apiKey}`,
        'x-tangle-tenant-id': tenant.tenantId,
        'x-tangle-wire-version': HOSTED_WIRE_VERSION,
      }
      if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey

      const res = await f(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combinedSignal,
      })
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429
        if (!retryable || attempt === maxRetries) {
          const text = await res.text().catch(() => '')
          throw new Error(`hosted ingest ${url} failed (${res.status}): ${text.slice(0, 500)}`)
        }
        await sleep(2 ** attempt * 200 + Math.random() * 200)
        continue
      }
      return (await res.json()) as TRes
    } catch (err) {
      if (opts.signal?.aborted) throw err
      lastError = err
      if (attempt === maxRetries) throw err
      await sleep(2 ** attempt * 200 + Math.random() * 200)
    }
  }
  throw lastError ?? new Error('hosted ingest exhausted retries')
}

export function createHostedClient(tenant: HostedTenant): HostedClient {
  return {
    tenant,
    wireVersion: HOSTED_WIRE_VERSION,

    async ingestEvalRun(event, idempotencyKey) {
      return this.ingestEvalRuns([event], idempotencyKey)
    },

    async ingestEvalRuns(events, idempotencyKey) {
      const body: IngestEvalRunsRequest = { wireVersion: HOSTED_WIRE_VERSION, events }
      return post<IngestEvalRunsRequest, IngestResponse>(tenant, '/v1/ingest/eval-runs', body, {
        idempotencyKey,
      })
    },

    async ingestTraces(spans, idempotencyKey) {
      const body: IngestTracesRequest = { wireVersion: HOSTED_WIRE_VERSION, spans }
      return post<IngestTracesRequest, IngestResponse>(tenant, '/v1/ingest/traces', body, {
        idempotencyKey,
      })
    },
  }
}
