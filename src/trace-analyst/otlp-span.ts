/**
 * Canonical OTLP-flat-line readers shared by every consumer of the
 * OTLP-JSONL wire shape (one OTLP span per line; the form
 * `flattenOtlpExportToNdjson` produces and the form AppWorld / HALO
 * emit via their OpenInference OTLP exporter).
 *
 * `OtlpFileTraceStore` indexes spans with these; `otlpToRunRecords`
 * aggregates spans into `RunRecord`s with the same readers. One parser,
 * one vocabulary — a divergence between the analyst's view of a trace and
 * the RunRecord projected from it is a class of bug this consolidation
 * removes by construction.
 *
 * Vocabulary. The readers understand BOTH dialects that appear in the
 * wild:
 *   - the substrate's own `llm.*` / `tool.*` / `span.kind` attributes
 *     (`flattenSpanAttributes` in `trace/otel.ts`), and
 *   - the OpenInference / inference-export attributes AppWorld / HALO
 *     emit (`openinference.span.kind`, `inference.observation_kind`,
 *     `inference.llm.input_tokens`, `llm.token_count.prompt`, …).
 *
 * Pure, no I/O.
 */

import {
  LLM_MODEL_ATTR_KEYS,
  SPAN_KIND_ATTR_KEYS,
  TOOL_NAME_ATTR_KEYS,
} from '../trace/otlp-attributes'
import type { TraceAnalystSpanKind, TraceAnalystSpanStatus } from './types'

/**
 * The structural fields a flat OTLP-JSONL line projects to. `attributes`
 * is the merged resource+span attribute map (span overrides resource);
 * the named fields are the pivots every reader of a trace needs without
 * paying the full attribute materialisation.
 */
export interface ProjectedOtlpSpan {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: TraceAnalystSpanKind
  start_time: string
  end_time: string
  duration_ms: number
  status: TraceAnalystSpanStatus
  status_message: string | undefined
  service_name: string | null
  agent_name: string | null
  model_name: string | null
  tool_name: string | null
  /** Merged resource + span attributes, span winning on overlap. */
  attributes: Record<string, unknown>
}

/**
 * Project one parsed OTLP-JSONL object to `ProjectedOtlpSpan`, or `null`
 * when the line is missing the mandatory `trace_id` + `span_id`.
 */
export function projectOtlpFlatLine(raw: Record<string, unknown>): ProjectedOtlpSpan | null {
  const trace_id = stringField(raw, 'trace_id') ?? stringField(raw, 'traceId')
  const span_id = stringField(raw, 'span_id') ?? stringField(raw, 'spanId')
  if (!trace_id || !span_id) return null

  const parent_id = stringField(raw, 'parent_span_id') ?? stringField(raw, 'parentSpanId') ?? null
  const name = stringField(raw, 'name') ?? 'unknown'
  const start_time = stringField(raw, 'start_time') ?? stringField(raw, 'startTime') ?? ''
  const end_time = stringField(raw, 'end_time') ?? stringField(raw, 'endTime') ?? start_time

  const status = readOtlpStatus(raw)
  const attributes = extractOtlpAttributes(raw)

  const service_name =
    asString(attributes['service.name']) ??
    asString(attributes['resource.attributes.service.name']) ??
    null
  const agent_name =
    asString(attributes['agent.name']) ??
    asString(attributes['inference.agent.name']) ??
    asString(attributes['inference.agent_name']) ??
    null
  const model_name = firstStringAttr(attributes, LLM_MODEL_ATTR_KEYS)
  const tool_name = firstStringAttr(attributes, TOOL_NAME_ATTR_KEYS)

  const kind = inferOtlpKind(attributes)

  let duration_ms = 0
  if (start_time && end_time) {
    const a = spanEpochMillis(start_time)
    const b = spanEpochMillis(end_time)
    if (a !== null && b !== null) duration_ms = Math.max(0, b - a)
  }

  return {
    trace_id,
    span_id,
    parent_span_id: parent_id && parent_id.length > 0 ? parent_id : null,
    name,
    kind,
    start_time,
    end_time,
    duration_ms,
    status: status.code,
    status_message: status.message,
    service_name,
    agent_name,
    model_name,
    tool_name,
    attributes,
  }
}

export function readOtlpStatus(raw: Record<string, unknown>): {
  code: TraceAnalystSpanStatus
  message: string | undefined
} {
  const status = raw.status
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    const codeRaw = (status as Record<string, unknown>).code
    const code: TraceAnalystSpanStatus =
      codeRaw === 'STATUS_CODE_OK' || codeRaw === 'OK'
        ? 'OK'
        : codeRaw === 'STATUS_CODE_ERROR' || codeRaw === 'ERROR'
          ? 'ERROR'
          : 'UNSET'
    const messageRaw = (status as Record<string, unknown>).message
    const message = typeof messageRaw === 'string' && messageRaw.length > 0 ? messageRaw : undefined
    return { code, message }
  }
  return { code: 'UNSET', message: undefined }
}

export function inferOtlpKind(attrs: Record<string, unknown>): TraceAnalystSpanKind {
  const opik = firstStringAttr(attrs, SPAN_KIND_ATTR_KEYS)
  if (opik) {
    const upper = opik.toUpperCase()
    if (
      upper === 'AGENT' ||
      upper === 'LLM' ||
      upper === 'TOOL' ||
      upper === 'CHAIN' ||
      upper === 'GUARDRAIL' ||
      upper === 'SPAN'
    ) {
      return upper as TraceAnalystSpanKind
    }
  }
  return 'UNKNOWN'
}

/**
 * Flatten OTLP `attributes` + `resource.attributes` into a single
 * dotted-key map. Span attributes override resource attributes when keys
 * overlap. Nested objects/arrays are preserved as-is.
 */
export function extractOtlpAttributes(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const resource = raw.resource
  if (resource && typeof resource === 'object' && !Array.isArray(resource)) {
    const ra = (resource as Record<string, unknown>).attributes
    if (ra && typeof ra === 'object' && !Array.isArray(ra)) {
      for (const [k, v] of Object.entries(ra as Record<string, unknown>)) {
        out[k] = v
      }
    }
  }
  const spanAttrs = raw.attributes
  if (spanAttrs && typeof spanAttrs === 'object' && !Array.isArray(spanAttrs)) {
    for (const [k, v] of Object.entries(spanAttrs as Record<string, unknown>)) {
      out[k] = v
    }
  }
  return out
}

export function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key]
  return typeof v === 'string' ? v : undefined
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Read a numeric attribute, tolerating numeric strings; `null` if absent/NaN. */
export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** First finite numeric value across a list of candidate attribute keys. */
export function firstNumberAttr(
  attrs: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const k of keys) {
    const n = asNumber(attrs[k])
    if (n !== null) return n
  }
  return null
}

/** First non-empty string value across a list of candidate attribute keys. */
export function firstStringAttr(
  attrs: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const s = asString(attrs[k])
    if (s !== null) return s
  }
  return null
}

/**
 * Parse a span timestamp to epoch millis, or null when empty/unparseable. The
 * OTLP readers accept BOTH ISO-8601 and epoch-millis-string dialects, so raw
 * string comparison (`<`, `localeCompare`) mis-orders across dialects and
 * `Date.parse` returns NaN for a bare epoch-millis string.
 */
export function spanEpochMillis(ts: string | undefined | null): number | null {
  if (!ts) return null
  if (/^\d+$/.test(ts)) return Number(ts)
  const n = Date.parse(ts)
  return Number.isNaN(n) ? null : n
}

/**
 * Order comparator for span timestamps across mixed ISO/epoch dialects.
 * Unparseable timestamps sort as epoch 0 (earliest), never NaN (which would
 * make the sort non-deterministic).
 */
export function compareSpanTime(a: string, b: string): number {
  return (spanEpochMillis(a) ?? 0) - (spanEpochMillis(b) ?? 0)
}
