/**
 * `flattenOtlpExportToNdjson` — flatten an `OtlpExport` (the shape
 * `exportRunAsOtlp` produces) into the per-line JSON the analyst's
 * `OtlpFileTraceStore` index reads. The SDK owns OTLP decoding; this module
 * selects its collector output or applies the analyst vocabulary and ISO times.
 *
 * Pure function, no I/O — the caller does `.map(JSON.stringify).join('\n')`
 * and writes the file (consumers want control over rotation + naming).
 */

import { decodeOtlpTraceExport, type OtlpFlatSpan } from '@tangle-network/agent-trace-contract/otlp'
import type { OtlpExport } from '../trace/otel'
import {
  LLM_INPUT_TOKENS,
  LLM_MODEL_NAME,
  LLM_OUTPUT_TOKENS,
  OPENINFERENCE_SPAN_KIND,
  TOOL_NAME,
} from '../trace/otlp-attributes'
import { createOtlpFlatLine, type OtlpFlatLine } from '../trace/otlp-flat'

export type { OtlpFlatLine } from '../trace/otlp-flat'

/** Select the collector projection: agent-trace-contract's lossless rows, with
 *  the export's own nanosecond strings and merged resource + span attributes. */
export interface FlattenOtlpCollectorOptions {
  projection: 'collector'
}

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

function nanoToIso(nano: string): string {
  const ms = Number(nano) / 1_000_000
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString()
}

/** Mirror selected attributes into the OpenInference vocabulary in place. */
function applyOpenInference(attrs: Record<string, unknown>): void {
  for (const [source, target] of [
    ['llm.model', LLM_MODEL_NAME],
    ['llm.input_tokens', LLM_INPUT_TOKENS],
    ['inference.llm.input_tokens', LLM_INPUT_TOKENS],
    ['llm.output_tokens', LLM_OUTPUT_TOKENS],
    ['inference.llm.output_tokens', LLM_OUTPUT_TOKENS],
    [TOOL_NAME, 'inference.tool.name'],
  ] as const) {
    if (source in attrs && !(target in attrs)) attrs[target] = attrs[source]
  }
  if ('span.kind' in attrs && !(OPENINFERENCE_SPAN_KIND in attrs)) {
    attrs[OPENINFERENCE_SPAN_KIND] = String(attrs['span.kind']).toUpperCase()
  }
}

/**
 * By default, the analyst's line: scalar attribute values, ISO times, named
 * kind and status codes, and the OpenInference vocabulary. With
 * `{ projection: 'collector' }`, `decodeOtlpTraceExport`'s rows unchanged.
 */
export function flattenOtlpExportToNdjson(
  otlpExport: unknown,
  opts: FlattenOtlpCollectorOptions,
): OtlpFlatSpan[]
export function flattenOtlpExportToNdjson(
  otlpExport: OtlpExport,
  opts?: FlattenOtlpOptions,
): OtlpFlatLine[]
export function flattenOtlpExportToNdjson(
  otlpExport: unknown,
  opts: FlattenOtlpOptions | FlattenOtlpCollectorOptions = {},
): OtlpFlatSpan[] | OtlpFlatLine[] {
  if ('projection' in opts && opts.projection === 'collector') {
    return decodeOtlpTraceExport(otlpExport)
  }
  const legacy = opts as FlattenOtlpOptions
  const kindMap = { ...DEFAULT_KIND_MAP, ...legacy.kindMap }
  return decodeOtlpTraceExport(otlpExport, { attributeValues: 'scalar' }).map((span) => {
    const attributes = span.span_attributes
    if ((legacy.attributeVocabulary ?? 'openinference') === 'openinference')
      applyOpenInference(attributes)
    return createOtlpFlatLine({
      traceId: span.trace_id,
      spanId: span.span_id,
      parentSpanId: span.parent_span_id,
      name: span.name,
      kind: (span.kind === undefined ? undefined : kindMap[span.kind]) ?? 'SPAN_KIND_UNSPECIFIED',
      startTime: nanoToIso(span.start_time_unix_nano ?? ''),
      endTime: nanoToIso(span.end_time_unix_nano ?? ''),
      statusCode: STATUS_MAP[span.status_code ?? 0] ?? 'STATUS_CODE_UNSET',
      statusMessage: span.status_message,
      resource: { attributes: span.resource_attributes },
      attributes,
      events: span.events?.map((event) => ({
        name: event.name,
        timeUnixNano: event.time_unix_nano,
        ...(event.attributes ? { attributes: event.attributes } : {}),
      })),
    })
  })
}
