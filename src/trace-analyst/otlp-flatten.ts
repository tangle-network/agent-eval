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
import { createOtlpFlatLine, type OtlpFlatLine } from '../trace/otlp-flat'

export type { OtlpFlatLine } from '../trace/otlp-flat'

export interface FlattenOtlpOptions {
  /** `'openinference'` (default) maps source per-span attributes into the
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
        const line = createOtlpFlatLine({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId ?? null,
          name: span.name,
          kind: kindMap[span.kind] ?? 'SPAN_KIND_UNSPECIFIED',
          startTime: nanoToIso(span.startTimeUnixNano),
          endTime: nanoToIso(span.endTimeUnixNano),
          statusCode: STATUS_MAP[span.status?.code ?? 0] ?? 'STATUS_CODE_UNSET',
          statusMessage: span.status?.message,
          resource,
          attributes,
          events: span.events?.map((e) => ({
            name: e.name,
            timeUnixNano: e.timeUnixNano,
            ...(e.attributes ? { attributes: attrsToRecord(e.attributes) } : {}),
          })),
        })
        lines.push(line)
      }
    }
  }

  return lines
}
