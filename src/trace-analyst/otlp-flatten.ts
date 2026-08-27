/**
 * `flattenOtlpExportToNdjson` — flatten an `OtlpExport` (the shape
 * `exportRunAsOtlp` produces) into the per-line JSON the analyst's
 * `OtlpFileTraceStore` index reads. Replaces three per-consumer OTLP
 * flatteners with one canonical projection.
 *
 * Pure function, no I/O — the caller does `.map(JSON.stringify).join('\n')`
 * and writes the file (consumers want control over rotation + naming).
 */

import type { OtlpExport, OtlpSpan } from '../trace/otel'
import {
  LLM_INPUT_TOKENS,
  LLM_MODEL_NAME,
  LLM_OUTPUT_TOKENS,
  OPENINFERENCE_SPAN_KIND,
  TOOL_NAME,
} from '../trace/otlp-attributes'

export interface OtlpFlatLine {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: string
  start_time: string
  end_time: string
  status: {
    code: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR' | 'STATUS_CODE_UNSET'
    message?: string
  }
  resource: { attributes: Record<string, string | number | boolean> }
  attributes: Record<string, string | number | boolean>
  events?: Array<{ name: string; timeUnixNano?: string; attributes?: Record<string, unknown> }>
}

export interface FlattenOtlpOptions {
  /** `'openinference'` (default) mirrors legacy per-span attributes into the
   *  canonical OpenInference vocabulary the analyst readers consume. `'none'`
   *  passes attributes through untouched. */
  attributeVocabulary?: 'openinference' | 'none'
  /** Override the numeric-kind → otlp-string mapping. */
  kindMap?: Partial<Record<number, string>>
}

const DEFAULT_KIND_MAP: Record<number, string> = {
  0: 'SPAN_KIND_UNSPECIFIED',
  1: 'SPAN_KIND_INTERNAL',
  2: 'SPAN_KIND_SERVER',
  3: 'SPAN_KIND_CLIENT',
  4: 'SPAN_KIND_PRODUCER',
  5: 'SPAN_KIND_CONSUMER',
}

const STATUS_MAP: Record<number, OtlpFlatLine['status']['code']> = {
  0: 'STATUS_CODE_UNSET',
  1: 'STATUS_CODE_OK',
  2: 'STATUS_CODE_ERROR',
}

/** Unwrap an OTLP attribute-value union to a scalar. */
function attrValue(v: OtlpSpan['attributes'][number]['value']): string | number | boolean {
  if (v.stringValue !== undefined) return v.stringValue
  if (v.intValue !== undefined) return Number(v.intValue)
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.boolValue !== undefined) return v.boolValue
  return ''
}

function attrsToRecord(attrs: OtlpSpan['attributes']): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const a of attrs) out[a.key] = attrValue(a.value)
  return out
}

function nanoToIso(nano: string): string {
  const ms = Number(nano) / 1_000_000
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString()
}

/** Mirror selected attributes into the OpenInference vocabulary in place. */
function applyOpenInference(attrs: Record<string, string | number | boolean>): void {
  if ('llm.model' in attrs && !(LLM_MODEL_NAME in attrs)) {
    attrs[LLM_MODEL_NAME] = attrs['llm.model']!
  }
  if ('llm.input_tokens' in attrs && !(LLM_INPUT_TOKENS in attrs)) {
    attrs[LLM_INPUT_TOKENS] = attrs['llm.input_tokens']!
  }
  if ('inference.llm.input_tokens' in attrs && !(LLM_INPUT_TOKENS in attrs)) {
    attrs[LLM_INPUT_TOKENS] = attrs['inference.llm.input_tokens']!
  }
  if ('llm.output_tokens' in attrs && !(LLM_OUTPUT_TOKENS in attrs)) {
    attrs[LLM_OUTPUT_TOKENS] = attrs['llm.output_tokens']!
  }
  if ('inference.llm.output_tokens' in attrs && !(LLM_OUTPUT_TOKENS in attrs)) {
    attrs[LLM_OUTPUT_TOKENS] = attrs['inference.llm.output_tokens']!
  }
  if (TOOL_NAME in attrs && !('inference.tool.name' in attrs)) {
    attrs['inference.tool.name'] = attrs[TOOL_NAME]!
  }
  if ('span.kind' in attrs && !(OPENINFERENCE_SPAN_KIND in attrs)) {
    attrs[OPENINFERENCE_SPAN_KIND] = String(attrs['span.kind']).toUpperCase()
  }
}

export function flattenOtlpExportToNdjson(
  otlpExport: OtlpExport,
  opts: FlattenOtlpOptions = {},
): OtlpFlatLine[] {
  const vocab = opts.attributeVocabulary ?? 'openinference'
  const kindMap = { ...DEFAULT_KIND_MAP, ...opts.kindMap }
  const lines: OtlpFlatLine[] = []

  for (const rs of otlpExport.resourceSpans ?? []) {
    const resource = { attributes: attrsToRecord(rs.resource?.attributes ?? []) }
    for (const scope of rs.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const attributes = attrsToRecord(span.attributes ?? [])
        if (vocab === 'openinference') applyOpenInference(attributes)
        const line: OtlpFlatLine = {
          trace_id: span.traceId,
          span_id: span.spanId,
          parent_span_id: span.parentSpanId ?? null,
          name: span.name,
          kind: kindMap[span.kind] ?? 'SPAN_KIND_UNSPECIFIED',
          start_time: nanoToIso(span.startTimeUnixNano),
          end_time: nanoToIso(span.endTimeUnixNano),
          status: {
            code: STATUS_MAP[span.status?.code ?? 0] ?? 'STATUS_CODE_UNSET',
            ...(span.status?.message ? { message: span.status.message } : {}),
          },
          resource,
          attributes,
        }
        if (span.events && span.events.length > 0) {
          line.events = span.events.map((e) => ({
            name: e.name,
            timeUnixNano: e.timeUnixNano,
            ...(e.attributes ? { attributes: attrsToRecord(e.attributes) } : {}),
          }))
        }
        lines.push(line)
      }
    }
  }

  return lines
}
