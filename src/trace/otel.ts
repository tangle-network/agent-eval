/**
 * OpenTelemetry JSON export — maps TraceSchema v1 to OTLP/JSON so
 * traces render natively in Jaeger / Honeycomb / Langfuse / Grafana.
 *
 * Wire format only. We do NOT depend on the @opentelemetry SDK — that
 * would drag in polyfills incompatible with Workers/Edge. Consumers
 * push the JSON to their collector of choice via HTTP.
 *
 * Reference: OTLP 1.3.2 (ResourceSpans / ScopeSpans / Span).
 */

import {
  applyLlmSpanOtlpAttributes,
  applyToolSpanOtlpAttributes,
  OPENINFERENCE_SPAN_KIND,
  traceSpanKindToOpenInferenceKind,
} from './otlp-attributes'
import type { Run, Span, TraceEvent } from './schema'
import type { TraceStore } from './store'

export const OTEL_AGENT_EVAL_SCOPE = { name: '@tangle-network/agent-eval', version: '0.3.0' }

export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Array<{
    key: string
    value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean }
  }>
  events?: Array<{ timeUnixNano: string; name: string; attributes?: OtlpSpan['attributes'] }>
  status?: { code: number; message?: string }
}

export interface OtlpResourceSpans {
  resource: { attributes: OtlpSpan['attributes'] }
  scopeSpans: Array<{ scope: typeof OTEL_AGENT_EVAL_SCOPE; spans: OtlpSpan[] }>
}

export interface OtlpExport {
  resourceSpans: OtlpResourceSpans[]
}

/** Export a single run's spans + events in OTLP/JSON. */
export async function exportRunAsOtlp(
  store: TraceStore,
  runId: string,
  resourceAttrs: Record<string, string | number | boolean> = {},
): Promise<OtlpExport> {
  const run = await store.getRun(runId)
  if (!run) throw new Error(`run ${runId} not found`)
  const spans = await store.spans({ runId })
  const events = await store.events({ runId })
  const eventsBySpan = new Map<string, TraceEvent[]>()
  for (const e of events) {
    if (!e.spanId) continue
    const arr = eventsBySpan.get(e.spanId) ?? []
    arr.push(e)
    eventsBySpan.set(e.spanId, arr)
  }
  const traceId = runToTraceId(run)
  const otlpSpans: OtlpSpan[] = spans.map((s) =>
    spanToOtlp(s, traceId, eventsBySpan.get(s.spanId) ?? []),
  )
  return {
    resourceSpans: [
      {
        resource: {
          attributes: toAttributes({
            'service.name': 'agent-eval',
            'run.id': run.runId,
            'run.scenario_id': run.scenarioId,
            'run.variant_id': run.variantId ?? '',
            'run.dataset_version': run.datasetVersion ?? '',
            'run.code_sha': run.codeSha ?? '',
            'run.model_fingerprint': run.modelFingerprint ?? '',
            ...resourceAttrs,
          }),
        },
        scopeSpans: [{ scope: OTEL_AGENT_EVAL_SCOPE, spans: otlpSpans }],
      },
    ],
  }
}

function spanToOtlp(span: Span, traceId: string, events: TraceEvent[]): OtlpSpan {
  const endedAt = span.endedAt ?? span.startedAt
  return {
    traceId,
    spanId: padSpanId(span.spanId),
    parentSpanId: span.parentSpanId ? padSpanId(span.parentSpanId) : undefined,
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: msToNs(span.startedAt),
    endTimeUnixNano: msToNs(endedAt),
    attributes: toAttributes(flattenSpanAttributes(span)),
    events: events.map((e) => ({
      timeUnixNano: msToNs(e.timestamp),
      name: e.kind,
      attributes: toAttributes(flattenPayload(e.payload)),
    })),
    status: span.status === 'error' ? { code: 2, message: span.error } : { code: 1 },
  }
}

function flattenSpanAttributes(span: Span): Record<string, string | number | boolean> {
  const base: Record<string, string | number | boolean> = {}
  if (span.attributes) {
    for (const [k, v] of Object.entries(span.attributes)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') base[k] = v
    }
  }
  base[OPENINFERENCE_SPAN_KIND] = traceSpanKindToOpenInferenceKind(span.kind)
  if (span.kind === 'llm') {
    applyLlmSpanOtlpAttributes(base, span)
  } else if (span.kind === 'tool') {
    applyToolSpanOtlpAttributes(base, span)
  } else if (span.kind === 'retrieval') {
    base['retrieval.query'] = span.query
    base['retrieval.hits'] = span.hits.length
  } else if (span.kind === 'judge') {
    base['judge.id'] = span.judgeId
    base['judge.dimension'] = span.dimension
    base['judge.score'] = span.score
    base['judge.target_span_id'] = span.targetSpanId
  } else if (span.kind === 'sandbox') {
    if (span.image) base['sandbox.image'] = span.image
    if (span.exitCode !== undefined) base['sandbox.exit_code'] = span.exitCode
    if (span.testsPassed !== undefined) base['sandbox.tests_passed'] = span.testsPassed
    if (span.testsTotal !== undefined) base['sandbox.tests_total'] = span.testsTotal
  }
  return base
}

function flattenPayload(
  payload: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else out[k] = JSON.stringify(v)
  }
  return out
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
  // OTLP wants 16-hex spanIds. UUIDs are 32-hex; strip dashes and take first 16.
  const cleaned = id.replace(/-/g, '')
  return cleaned.slice(0, 16).padEnd(16, '0')
}

function runToTraceId(run: Run): string {
  // OTLP wants 32-hex traceIds. Use runId directly when it's 32-hex already,
  // else SHA-ish truncate.
  const cleaned = run.runId.replace(/-/g, '')
  return cleaned.slice(0, 32).padEnd(32, '0')
}
