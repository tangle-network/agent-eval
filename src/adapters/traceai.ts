/**
 * # `@tangle-network/agent-eval/adapters/traceai` — OTel→hosted bridge.
 *
 * Forwards OpenTelemetry-shaped spans (from `future-agi/traceai`, from the
 * OTel SDK directly, or from any library that emits OTel `ReadableSpan`s)
 * into the hosted-tier ingest endpoint via `createHostedClient`.
 *
 * **Why this exists:** future-agi ships the strongest OTel-native
 * instrumentation library in the TypeScript-agent ecosystem. Partners using
 * traceai for tracing should be able to plug it into Tangle Intelligence
 * with one config line — not rebuild OTel emission from scratch. Adapter
 * shape applies equally to any OTel SpanProcessor pipeline.
 *
 * **Pattern:**
 *
 *   ```ts
 *   import { createHostedClient } from '@tangle-network/agent-eval/hosted'
 *   import { createTraceAiBridge } from '@tangle-network/agent-eval/adapters/traceai'
 *
 *   const client = createHostedClient({ endpoint, apiKey, tenantId })
 *   const bridge = createTraceAiBridge({ client, defaultRunId: substrateRunId })
 *
 *   // Wherever your OTel SpanProcessor hands you a finished span:
 *   processor.onEnd = (span) => bridge.ingest([span])
 *   // …or in a SpanProcessor.onShutdown / batch flush:
 *   await bridge.ingest(batchedSpans)
 *   ```
 *
 * No `@opentelemetry/*` dependency is declared here — the adapter accepts
 * a structurally-typed `OtelLikeSpan`. This keeps the substrate dep graph
 * lean while remaining compatible with OTel SDK `ReadableSpan` instances
 * and with traceai's emitted spans. If a consumer's span shape differs
 * (e.g. `parentSpanId` as a top-level field rather than via
 * `parentSpanContext()`), the adapter accepts both forms.
 */

import type { HostedClient } from '../hosted/client'
import type { TraceSpanEvent } from '../hosted/types'

// ── OTel-compatible structural types ─────────────────────────────────

/**
 * `[seconds, nanoseconds]` — the OTel SDK's `HrTime` shape. Spans emitted
 * by the OTel SDK carry timestamps in this representation; we convert to
 * a single unix-nano number for the wire format.
 */
export type HrTime = [number, number]

/** Standard OTel `SpanStatusCode` numeric values: 0 = UNSET, 1 = OK, 2 = ERROR. */
export const OTEL_STATUS_UNSET = 0
export const OTEL_STATUS_OK = 1
export const OTEL_STATUS_ERROR = 2

export type OtelAttributeValue = string | number | boolean | null | undefined

/**
 * Structural surface compatible with `@opentelemetry/sdk-trace-base`'s
 * `ReadableSpan`. Consumers pass instances they get from their OTel SDK
 * (or from `future-agi/traceai`, which produces spans of this shape).
 */
export interface OtelLikeSpan {
  spanContext: () => { traceId: string; spanId: string; traceFlags?: number }
  /** Set on the span itself by some SDKs (legacy / OTLP-shape). Some SDKs
   *  expose the parent via `parentSpanContext()` instead — the adapter
   *  checks both. */
  parentSpanId?: string
  parentSpanContext?: () => { spanId: string } | undefined
  name: string
  startTime: HrTime
  endTime: HrTime
  attributes: Record<string, OtelAttributeValue>
  events?: Array<{
    name: string
    time: HrTime
    attributes?: Record<string, OtelAttributeValue>
  }>
  status?: { code: number; message?: string }
}

// ── Conversion ───────────────────────────────────────────────────────

/** `[seconds, nanoseconds]` → unix-nano number. */
export function hrTimeToUnixNano(hr: HrTime): number {
  const [seconds, nanos] = hr
  return seconds * 1_000_000_000 + nanos
}

function statusCodeName(code: number | undefined): 'OK' | 'ERROR' | 'UNSET' {
  if (code === OTEL_STATUS_OK) return 'OK'
  if (code === OTEL_STATUS_ERROR) return 'ERROR'
  return 'UNSET'
}

/** Drop null/undefined attribute values; keep string/number/boolean. */
function cleanAttributes(
  attrs: Record<string, OtelAttributeValue> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!attrs) return out
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    }
  }
  return out
}

function readPivotString(
  attrs: Record<string, OtelAttributeValue>,
  key: string,
): string | undefined {
  const v = attrs[key]
  return typeof v === 'string' ? v : undefined
}

function readPivotNumber(
  attrs: Record<string, OtelAttributeValue>,
  key: string,
): number | undefined {
  const v = attrs[key]
  return typeof v === 'number' ? v : undefined
}

function resolveParentSpanId(span: OtelLikeSpan): string | undefined {
  if (span.parentSpanId) return span.parentSpanId
  const ctx = span.parentSpanContext?.()
  return ctx?.spanId
}

// ── Bridge ───────────────────────────────────────────────────────────

export interface TraceAiBridgeOptions {
  /** Hosted client to forward spans to. */
  client: HostedClient
  /** When set, spans missing a `tangle.runId` attribute receive this value
   *  on the way out. Useful when the OTel emitter doesn't know which
   *  substrate run it's serving. */
  defaultRunId?: string
  /** Max spans per ingest call. Default 200. The hosted ingest endpoint
   *  caps at 5000 per call; we batch smaller by default to keep individual
   *  retries cheap. */
  batchSize?: number
  /** Called when a batch fails to ingest. Defaults to a console.warn. Hook
   *  this when you need backpressure or to spill to a fallback. */
  onError?: (err: unknown, batch: TraceSpanEvent[]) => void | Promise<void>
}

export interface TraceAiBridge {
  /** Convert + ingest a batch of OTel-shape spans. */
  ingest(spans: OtelLikeSpan[]): Promise<void>
  /** Convert one OTel span to the wire-format event. Useful for tests or
   *  custom batching pipelines. */
  spanToEvent(span: OtelLikeSpan): TraceSpanEvent
}

export function createTraceAiBridge(opts: TraceAiBridgeOptions): TraceAiBridge {
  const batchSize = opts.batchSize ?? 200
  const onError =
    opts.onError ??
    ((err) => {
      console.warn('[traceai-bridge] ingest batch failed:', err)
    })

  function convert(span: OtelLikeSpan): TraceSpanEvent {
    const ctx = span.spanContext()
    const attributes = cleanAttributes(span.attributes)
    // Pull pivot attributes off the cleaned attribute map so they round-trip
    // through the wire format's first-class fields. They REMAIN in
    // `attributes` as well so downstream OTel viewers see the same values.
    const runId = readPivotString(attributes, 'tangle.runId') ?? opts.defaultRunId
    const scenarioId = readPivotString(attributes, 'tangle.scenarioId')
    const cellId = readPivotString(attributes, 'tangle.cellId')
    const generation = readPivotNumber(attributes, 'tangle.generation')

    if (runId && !attributes['tangle.runId']) {
      attributes['tangle.runId'] = runId
    }

    const event: TraceSpanEvent = {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      name: span.name,
      startTimeUnixNano: hrTimeToUnixNano(span.startTime),
      endTimeUnixNano: hrTimeToUnixNano(span.endTime),
      attributes,
    }
    const parentSpanId = resolveParentSpanId(span)
    if (parentSpanId) event.parentSpanId = parentSpanId
    if (span.events && span.events.length > 0) {
      event.events = span.events.map((e) => {
        const eventAttrs = cleanAttributes(e.attributes)
        const node: {
          timeUnixNano: number
          name: string
          attributes?: Record<string, string | number | boolean>
        } = {
          timeUnixNano: hrTimeToUnixNano(e.time),
          name: e.name,
        }
        if (Object.keys(eventAttrs).length > 0) node.attributes = eventAttrs
        return node
      })
    }
    if (span.status) {
      event.status = { code: statusCodeName(span.status.code), message: span.status.message }
    }
    if (runId) event['tangle.runId'] = runId
    if (scenarioId) event['tangle.scenarioId'] = scenarioId
    if (cellId) event['tangle.cellId'] = cellId
    if (generation !== undefined) event['tangle.generation'] = generation
    return event
  }

  async function ingest(spans: OtelLikeSpan[]): Promise<void> {
    if (spans.length === 0) return
    const events = spans.map(convert)
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize)
      try {
        await opts.client.ingestTraces(batch)
      } catch (err) {
        await onError(err, batch)
      }
    }
  }

  return { ingest, spanToEvent: convert }
}
