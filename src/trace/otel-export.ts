/**
 * OTEL span exporter — streams spans to an OTLP/HTTP collector.
 *
 * Reads OTEL_EXPORTER_OTLP_ENDPOINT + OTEL_EXPORTER_OTLP_HEADERS from env
 * when no explicit config is given. Batches spans and flushes periodically
 * or when the batch fills. No @opentelemetry SDK dependency — minimal
 * OTLP/JSON serializer (~120 LOC) using the existing otel.ts helpers.
 */

import { OTEL_AGENT_EVAL_SCOPE, type OtlpExport, type OtlpSpan } from './otel'

export interface OtelExportConfig {
  /** OTLP endpoint. Reads OTEL_EXPORTER_OTLP_ENDPOINT env by default. */
  endpoint?: string
  /** OTLP headers. Reads OTEL_EXPORTER_OTLP_HEADERS env by default. */
  headers?: Record<string, string>
  /** Batch size before flush. Default 64. */
  batchSize?: number
  /** Flush interval ms. Default 5000. */
  flushIntervalMs?: number
  /** Resource attributes stamped on every export. */
  resourceAttributes?: Record<string, string | number | boolean>
  /** Service name. Default 'agent-eval'. */
  serviceName?: string
}

export interface OtelExporter {
  /** Called by the TraceEmitter on every span close. */
  exportSpan(span: ExportableSpan): void
  /** Force flush pending spans. */
  flush(): Promise<void>
  /** Shutdown cleanly — flushes remaining spans and stops the timer. */
  shutdown(): Promise<void>
}

export interface ExportableSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: string
  startedAt: number
  endedAt?: number
  status?: string
  error?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  attributes?: Record<string, unknown>
}

/**
 * Create an OTEL exporter. Returns undefined when no endpoint is configured
 * (neither via config nor env) — callers should check before attaching.
 */
export function createOtelExporter(config?: OtelExportConfig): OtelExporter | undefined {
  const resolvedEndpoint =
    config?.endpoint ??
    (typeof process !== 'undefined' ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT : undefined)
  if (!resolvedEndpoint) return undefined
  const endpoint: string = resolvedEndpoint

  const headers = config?.headers ?? parseHeadersFromEnv()
  const batchSize = config?.batchSize ?? 64
  const flushIntervalMs = config?.flushIntervalMs ?? 5000
  const serviceName = config?.serviceName ?? 'agent-eval'
  const resourceAttrs = config?.resourceAttributes ?? {}

  const pending: OtlpSpan[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  const exporter: OtelExporter = {
    exportSpan(span: ExportableSpan): void {
      if (stopped) return
      pending.push(toOtlpSpan(span))
      if (pending.length >= batchSize) {
        void doFlush()
      }
    },

    async flush(): Promise<void> {
      await doFlush()
    },

    async shutdown(): Promise<void> {
      stopped = true
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      await doFlush()
    },
  }

  timer = setInterval(() => {
    if (pending.length > 0) void doFlush()
  }, flushIntervalMs)
  // Unref so the timer doesn't keep the process alive.
  if (typeof timer === 'object' && 'unref' in timer) {
    ;(timer as NodeJS.Timeout).unref()
  }

  async function doFlush(): Promise<void> {
    if (pending.length === 0) return
    const batch = pending.splice(0)
    const body: OtlpExport = {
      resourceSpans: [
        {
          resource: {
            attributes: toAttributes({
              'service.name': serviceName,
              ...resourceAttrs,
            }),
          },
          scopeSpans: [{ scope: OTEL_AGENT_EVAL_SCOPE, spans: batch }],
        },
      ],
    }
    const url = endpoint.replace(/\/+$/, '') + '/v1/traces'
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      })
    } catch {
      // Best-effort — telemetry export must not crash the pipeline.
    }
  }

  return exporter
}

function parseHeadersFromEnv(): Record<string, string> {
  if (typeof process === 'undefined') return {}
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function toOtlpSpan(span: ExportableSpan): OtlpSpan {
  const endedAt = span.endedAt ?? span.startedAt
  const attrs: Record<string, string | number | boolean> = {
    'span.kind': span.kind,
  }
  if (span.model) attrs['llm.model'] = span.model
  if (span.inputTokens !== undefined) attrs['llm.input_tokens'] = span.inputTokens
  if (span.outputTokens !== undefined) attrs['llm.output_tokens'] = span.outputTokens
  if (span.costUsd !== undefined) attrs['llm.cost_usd'] = span.costUsd
  if (span.attributes) {
    for (const [k, v] of Object.entries(span.attributes)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attrs[k] = v
    }
  }
  return {
    traceId: padTraceId(span.traceId),
    spanId: padSpanId(span.spanId),
    parentSpanId: span.parentSpanId ? padSpanId(span.parentSpanId) : undefined,
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: msToNs(span.startedAt),
    endTimeUnixNano: msToNs(endedAt),
    attributes: toAttributes(attrs),
    status: span.status === 'error' ? { code: 2, message: span.error } : { code: 1 },
  }
}

function toAttributes(record: Record<string, string | number | boolean>): OtlpSpan['attributes'] {
  return Object.entries(record).map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? Number.isInteger(value)
          ? { intValue: value.toString() }
          : { doubleValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: value },
  }))
}

function msToNs(ms: number): string {
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString()
}

function padSpanId(id: string): string {
  const cleaned = id.replace(/-/g, '')
  return cleaned.slice(0, 16).padEnd(16, '0')
}

function padTraceId(id: string): string {
  const cleaned = id.replace(/-/g, '')
  return cleaned.slice(0, 32).padEnd(32, '0')
}
