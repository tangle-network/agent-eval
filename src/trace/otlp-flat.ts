/** Canonical flattened OTLP span shape shared by trace producers and readers. */

import type { SpanStatus } from './schema'

export type OtlpStatusCode = 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR' | 'STATUS_CODE_UNSET'

export interface OtlpFlatLine {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: string
  start_time: string
  end_time: string
  status: {
    code: OtlpStatusCode
    message?: string
  }
  resource: { attributes: Record<string, unknown> }
  attributes: Record<string, unknown>
  events?: Array<{ name: string; timeUnixNano?: string; attributes?: Record<string, unknown> }>
}

export interface CreateOtlpFlatLineInput {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  kind: string
  startTime: string
  endTime: string
  statusCode: OtlpStatusCode
  statusMessage?: string
  resource: OtlpFlatLine['resource']
  attributes: Record<string, unknown>
  events?: OtlpFlatLine['events']
}

export function createOtlpFlatLine(input: CreateOtlpFlatLineInput): OtlpFlatLine {
  return {
    trace_id: input.traceId,
    span_id: input.spanId,
    parent_span_id: input.parentSpanId,
    name: input.name,
    kind: input.kind,
    start_time: input.startTime,
    end_time: input.endTime,
    status: {
      code: input.statusCode,
      ...(input.statusMessage ? { message: input.statusMessage } : {}),
    },
    resource: input.resource,
    attributes: input.attributes,
    ...(input.events && input.events.length > 0 ? { events: input.events } : {}),
  }
}

/** Map the canonical trace status while letting each caller choose its legacy default. */
export function spanStatusToOtlp(
  status: SpanStatus | undefined,
  error: string | undefined,
  defaultCode: OtlpStatusCode,
): OtlpStatusCode {
  if (status === 'error' || error) return 'STATUS_CODE_ERROR'
  if (status === 'ok') return 'STATUS_CODE_OK'
  return defaultCode
}

/** Convert epoch milliseconds, returning `undefined` for invalid or out-of-range values. */
export function epochMillisToIso(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined
  try {
    return new Date(value).toISOString()
  } catch {
    return undefined
  }
}
