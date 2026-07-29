import { CaptureIntegrityError } from '../errors'
import { applyToolSpanOtlpAttributes, OPENINFERENCE_SPAN_KIND } from '../trace/otlp-attributes'
import { createOtlpFlatLine, epochMillisToIso, spanStatusToOtlp } from '../trace/otlp-flat'
import type { ToolSpan } from '../trace/schema'
import type { TraceAnalysisStore } from './store'
import { createOtlpBufferTraceStore, type ToolSpansToTraceAnalysisStoreOptions } from './store-otlp'

/** Missing tool spans cannot distinguish a tool-free run from broken capture. */
export class ToolTraceMissingError extends CaptureIntegrityError {
  constructor() {
    super('toolSpansToTraceAnalysisStore: no tool spans supplied; trace evidence is missing')
  }
}

/**
 * Snapshot canonical tool spans into the read interface used by trace analysts.
 * One run becomes one trace while arguments, results, errors, and timing remain searchable.
 */
export function toolSpansToTraceAnalysisStore(
  spans: readonly ToolSpan[] | null | undefined,
  options: ToolSpansToTraceAnalysisStoreOptions = {},
): TraceAnalysisStore {
  if (!spans || spans.length === 0) throw new ToolTraceMissingError()

  const seen = new Set<string>()
  const lines = spans.map((span, index) => {
    assertToolSpanIdentity(span, index)
    const identity = `${span.runId}\u0000${span.spanId}`
    if (seen.has(identity)) {
      throw new CaptureIntegrityError(
        `toolSpansToTraceAnalysisStore: duplicate span '${span.spanId}' in run '${span.runId}'`,
      )
    }
    seen.add(identity)

    const attributes = { ...(span.attributes ?? {}) }
    applyToolSpanOtlpAttributes(attributes, span)
    attributes[OPENINFERENCE_SPAN_KIND] = 'TOOL'

    const endedAt = span.endedAt ?? span.startedAt + (span.latencyMs ?? 0)
    const line = createOtlpFlatLine({
      traceId: span.runId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId ?? null,
      name: span.name,
      kind: 'SPAN_KIND_INTERNAL',
      startTime: toolSpanTimeIso(span.startedAt, span.spanId, 'startedAt'),
      endTime: toolSpanTimeIso(endedAt, span.spanId, 'endedAt'),
      statusCode: spanStatusToOtlp(span.status, span.error, 'STATUS_CODE_UNSET'),
      statusMessage: span.error,
      resource: { attributes: {} },
      attributes,
    })
    try {
      return JSON.stringify(line)
    } catch (cause) {
      throw new CaptureIntegrityError(
        `toolSpansToTraceAnalysisStore: span '${span.spanId}' in run '${span.runId}' is not JSON-serializable`,
        { cause },
      )
    }
  })

  return createOtlpBufferTraceStore(Buffer.from(`${lines.join('\n')}\n`, 'utf8'), options)
}

function assertToolSpanIdentity(span: ToolSpan, index: number): void {
  if (span.kind !== 'tool') {
    throw new CaptureIntegrityError(
      `toolSpansToTraceAnalysisStore: span at index ${index} has kind '${String(span.kind)}', not 'tool'`,
    )
  }
  if (!span.runId || !span.spanId || !span.name || !span.toolName) {
    throw new CaptureIntegrityError(
      `toolSpansToTraceAnalysisStore: span at index ${index} is missing runId, spanId, name, or toolName`,
    )
  }
  if (!Number.isFinite(span.startedAt)) {
    throw new CaptureIntegrityError(
      `toolSpansToTraceAnalysisStore: span '${span.spanId}' has invalid startedAt`,
    )
  }
  if (span.endedAt !== undefined && !Number.isFinite(span.endedAt)) {
    throw new CaptureIntegrityError(
      `toolSpansToTraceAnalysisStore: span '${span.spanId}' has invalid endedAt`,
    )
  }
  if (span.endedAt !== undefined && span.endedAt < span.startedAt) {
    throw new CaptureIntegrityError(
      `toolSpansToTraceAnalysisStore: span '${span.spanId}' ends before it starts`,
    )
  }
  if (span.latencyMs !== undefined && (!Number.isFinite(span.latencyMs) || span.latencyMs < 0)) {
    throw new CaptureIntegrityError(
      `toolSpansToTraceAnalysisStore: span '${span.spanId}' has invalid latencyMs`,
    )
  }
}

function toolSpanTimeIso(value: number, spanId: string, field: string): string {
  const iso = epochMillisToIso(value)
  if (iso) return iso
  throw new CaptureIntegrityError(
    `toolSpansToTraceAnalysisStore: span '${spanId}' has invalid ${field}`,
  )
}
