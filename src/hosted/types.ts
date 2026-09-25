/**
 * # Hosted-tier wire format: the shapes every orchestrator (ours, a partner's
 * self-hosted one, a future open implementation) must accept.
 *
 * This package implements exactly one wire version. Servers reject every
 * other version instead of translating old payloads.
 *
 * The wire carries two streams in one transport:
 *
 *   1. **Search ledgers** (`/v1/search-blobs/*`, `/v1/ingest/search-ledger`).
 *      A producer ships a search's hash-chained ledger lines and the blobs
 *      they name; `./search-ledger-wire.ts` owns those shapes.
 *
 *   2. **Trace spans** (`POST /v1/ingest/traces`). Standard OTLP-shaped
 *      spans with a few additional attributes so the orchestrator can
 *      pivot from a search cell to its underlying execution. Compatible
 *      with any OTel collector.
 *
 * Every endpoint is authenticated with a bearer token and a tenant id
 * header. Tenants isolate everything downstream of ingest; no tenant
 * ever sees another tenant's data.
 */

export const HOSTED_WIRE_VERSION = '2026-07-24.v1' as const
export type HostedWireVersion = typeof HOSTED_WIRE_VERSION

// ── Transport headers ───────────────────────────────────────────────

/** Every ingest request carries these. */
export interface HostedIngestHeaders {
  /** Bearer token. The orchestrator validates against the tenant key. */
  authorization: `Bearer ${string}`
  /** Stable tenant id (the orchestrator-side primary key for the tenant). */
  'x-tangle-tenant-id': string
  /** Wire-version pin so the server can reject incompatible payloads. */
  'x-tangle-wire-version': HostedWireVersion
  /** Stable request key generated once and reused across retries. */
  'idempotency-key': string
}

// ── Trace span event ────────────────────────────────────────────────

/**
 * Canonical unsigned 64-bit integer encoded as a base-10 string.
 * JSON numbers cannot represent OTLP nanosecond timestamps exactly.
 */
export type UnixNanoTimestamp = string

/**
 * OTel-shape span with a few additional attributes for pivoting.
 * Compatible with any OTLP collector — `name`, `traceId`, `spanId`,
 * `startTimeUnixNano`, `endTimeUnixNano`, `attributes` are stock OTel.
 */
export interface TraceSpanEvent {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: UnixNanoTimestamp
  endTimeUnixNano: UnixNanoTimestamp
  attributes: Record<string, string | number | boolean>
  events?: Array<{
    timeUnixNano: UnixNanoTimestamp
    name: string
    attributes?: Record<string, string | number | boolean>
  }>
  status?: { code: 'OK' | 'ERROR' | 'UNSET'; message?: string }
  /** Pivot to the producing run. */
  'tangle.runId'?: string
  /** Pivot to the specific generation. */
  'tangle.generation'?: number
  /** Pivot to the specific cell. */
  'tangle.cellId'?: string
  /** Pivot to the specific scenario. */
  'tangle.scenarioId'?: string
}

// ── Ingest request bodies ───────────────────────────────────────────

export interface IngestTracesRequest {
  wireVersion: HostedWireVersion
  spans: TraceSpanEvent[]
}

export interface IngestResponse {
  /** Accepted spans count. */
  accepted: number
  /** Rejected spans with reasons (validation failures, conflicting identity). */
  rejected: Array<{ index: number; reason: string }>
}
