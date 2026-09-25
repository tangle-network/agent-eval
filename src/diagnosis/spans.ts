/**
 * Ingest for the diagnosis engine: flat spans in, filtered and normalized spans
 * out. Nothing downstream of this file sees an unfiltered value.
 *
 * Input is the flat-span shape trace-adapters and the traces CLI emit, one
 * object per span: `{trace_id, span_id, parent_span_id, name, kind,
 * start_time, end_time, status | status_code, status_message, attributes,
 * resource?}`. Times may be OTLP nanosecond strings, epoch milliseconds, or
 * ISO-8601; the generic OTLP line reader treats every digit string as
 * milliseconds, so time parsing is owned here.
 */

import { createHmac, randomBytes } from 'node:crypto'
import {
  type ContractSpan,
  MODEL_ATTR_KEYS,
  resolveSpanKind,
  SPAN_KINDS,
  type SpanKind,
  TOOL_NAME_ATTR_KEYS,
} from '@tangle-network/agent-trace-contract'
import { emptyRedactionReport, type RedactionReport, redact, redactText } from '../trace/redact'

export type DiagnosisSpanStatus = 'OK' | 'ERROR' | 'UNSET'

export interface DiagnosisSpan {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  kind: SpanKind
  startMs: number | null
  endMs: number | null
  status: DiagnosisSpanStatus
  statusMessage: string | null
  toolName: string | null
  model: string | null
  /**
   * Keyed fingerprint of the tool call's input, taken before redaction so calls
   * that differ only in secret material stay distinct. The key is random per
   * ingest, so the fingerprint cannot be matched against a guessed payload or
   * joined across diagnoses. Null when the span carries no input.
   */
  inputDigest: string | null
  attributes: Record<string, unknown>
}

export interface IngestReport {
  received: number
  accepted: number
  /** Lines without a trace id or span id, which no evidence could ever cite. */
  unreadable: number
  /** Identical (trace id, span id) pairs seen again; the first occurrence is kept. */
  duplicateSpans: number
  /** Span ids that occur in more than one trace, which evidence cannot cite unambiguously. */
  ambiguousSpanIds: string[]
  secrets: RedactionReport
  /** Attribute keys removed because content was not included. */
  droppedAttributes: string[]
}

/**
 * Attributes that carry prompt, response, or tool payload text. When content is
 * not included they are removed before anything reads the span, rather than
 * trusting pattern redaction over free-form prose.
 */
const CONTENT_ATTRIBUTE =
  /^(?:input\.value|output\.value|input|output|result|prompt|completion|text|thinking|message|messages|tool\.(?:input|output|arguments|result)|tool_input|tool_output|tool_arguments|arguments|args|full_command|gen_ai\.(?:prompt|completion|input\.messages|output\.messages|system_instructions|tool\.call\.(?:arguments|result))(?:\..*)?|llm\.(?:input|output)_messages(?:\..*)?|llm\.prompts?(?:\..*)?|content|body|request|response|command)$|\.content$/i
const PROSE_ATTRIBUTE =
  /(?:^|[._])(?:error|exception|status)(?:[._][a-zA-Z0-9]+)*[._](?:message|stacktrace|stack|description|details|reason)$|^(?:error|exception|status)$|^(?:log|event)[._]message$|^otel\.status_description$|^(?:events?|logs?)$/i

const INPUT_ATTRIBUTE_KEYS = [
  'input.value',
  'input',
  'tool.input',
  'tool.arguments',
  'tool_input',
  'tool_arguments',
  'arguments',
  'args',
  'full_command',
  'gen_ai.tool.call.arguments',
]

export function isContentAttribute(key: string): boolean {
  return CONTENT_ATTRIBUTE.test(key) || PROSE_ATTRIBUTE.test(key)
}

/**
 * Filter secrets from every string, drop content attributes unless content is
 * included, and normalize each span. Order matters: the input fingerprint is
 * keyed and taken before redaction and the content drop, so repeated-call
 * detection works on metadata-only runs without the payload itself surviving.
 */
export function ingestSpans(
  raw: readonly unknown[],
  options: { contentIncluded: boolean },
): { spans: DiagnosisSpan[]; report: IngestReport } {
  const secrets = emptyRedactionReport()
  const dropped = new Set<string>()
  const seen = new Set<string>()
  const spans: DiagnosisSpan[] = []
  let unreadable = 0
  let duplicateSpans = 0
  const traceOfSpan = new Map<string, string>()
  const ambiguous = new Set<string>()
  const digestKey = randomBytes(32)
  for (const line of raw) {
    if (line === null || typeof line !== 'object' || Array.isArray(line)) {
      unreadable += 1
      continue
    }
    const record = line as Record<string, unknown>
    const traceId = idField(record, 'trace_id', 'traceId')
    const spanId = idField(record, 'span_id', 'spanId')
    if (!traceId || !spanId) {
      unreadable += 1
      continue
    }
    const key = `${traceId}\u0000${spanId}`
    if (seen.has(key)) {
      duplicateSpans += 1
      continue
    }
    seen.add(key)
    const firstTrace = traceOfSpan.get(spanId)
    if (firstTrace === undefined) traceOfSpan.set(spanId, traceId)
    else if (firstTrace !== traceId) ambiguous.add(spanId)
    const merged = mergedAttributes(record)
    const inputDigest = digestInput(merged, digestKey)
    const attributes = redact(merged, { report: secrets }).value
    if (!options.contentIncluded) {
      for (const [key, value] of Object.entries(attributes)) {
        if (isContentAttribute(key) || (value !== null && typeof value === 'object')) {
          delete attributes[key]
          dropped.add(key)
        }
      }
    }
    const status = readStatus(record)
    const statusMessage =
      status.message === null ? null : redactText(status.message, { report: secrets })
    const toolName = firstString(attributes, TOOL_NAME_ATTR_KEYS)
    const model = firstString(attributes, MODEL_ATTR_KEYS)
    const name = redactText(stringOr(record.name, 'unknown'), { report: secrets })
    spans.push({
      traceId,
      spanId,
      parentSpanId: idField(record, 'parent_span_id', 'parentSpanId') ?? null,
      name,
      kind: resolveKind(record.kind, name, attributes),
      startMs: epochMillis(record.start_time ?? record.startTime ?? record.startTimeUnixNano),
      endMs: epochMillis(record.end_time ?? record.endTime ?? record.endTimeUnixNano),
      status: status.code,
      statusMessage: options.contentIncluded ? statusMessage : null,
      toolName,
      model,
      inputDigest,
      attributes,
    })
  }
  return {
    spans,
    report: {
      received: raw.length,
      accepted: spans.length,
      unreadable,
      duplicateSpans,
      ambiguousSpanIds: [...ambiguous].sort(),
      secrets,
      droppedAttributes: [...dropped].sort(),
    },
  }
}

/** The contract shape `validateTraceSpans` reads. */
export function toContractSpan(span: DiagnosisSpan): ContractSpan {
  return {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    name: span.name,
    ...(span.kind === 'UNKNOWN' ? {} : { kind: span.kind }),
    start_time: isoOrEmpty(span.startMs),
    end_time: isoOrEmpty(span.endMs),
    status: {
      code:
        span.status === 'ERROR'
          ? 'STATUS_CODE_ERROR'
          : span.status === 'OK'
            ? 'STATUS_CODE_OK'
            : 'STATUS_CODE_UNSET',
      ...(span.statusMessage ? { message: span.statusMessage } : {}),
    },
    attributes: span.attributes,
  }
}

export function durationMs(span: DiagnosisSpan): number | null {
  return span.startMs !== null && span.endMs !== null
    ? Math.max(0, span.endMs - span.startMs)
    : null
}

/**
 * Epoch milliseconds from OTLP nanoseconds, epoch milliseconds, epoch seconds,
 * or ISO-8601. Digit strings are classified by length: 17 or more digits are
 * nanoseconds, 15-16 microseconds, 12-14 milliseconds, and fewer are seconds.
 */
export function epochMillis(value: unknown): number | null {
  if (typeof value === 'number')
    return Number.isFinite(value) ? scaleEpoch(value, String(Math.trunc(value)).length) : null
  if (typeof value !== 'string' || value.length === 0) return null
  if (/^\d+$/.test(value)) {
    if (value.length >= 17) return Number(BigInt(value) / 1_000_000n)
    return scaleEpoch(Number(value), value.length)
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function scaleEpoch(value: number, digits: number): number {
  if (digits >= 17) return Math.trunc(value / 1_000_000)
  if (digits >= 15) return Math.trunc(value / 1_000)
  if (digits >= 12) return value
  return value * 1000
}

function isoOrEmpty(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString()
}

function mergedAttributes(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const resource = record.resource
  if (resource && typeof resource === 'object' && !Array.isArray(resource)) {
    const attrs = (resource as Record<string, unknown>).attributes
    if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) Object.assign(out, attrs)
  }
  const attrs = record.attributes
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) Object.assign(out, attrs)
  if (typeof record.scope_name === 'string' && out['otel.scope.name'] === undefined) {
    out['otel.scope.name'] = record.scope_name
  }
  return out
}

function readStatus(record: Record<string, unknown>): {
  code: DiagnosisSpanStatus
  message: string | null
} {
  let code: unknown = record.status_code
  let message: unknown = record.status_message
  const status = record.status
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    const object = status as Record<string, unknown>
    code = object.code ?? code
    message = object.message ?? message
  }
  const text = typeof code === 'string' ? code.toUpperCase() : code
  const normalized: DiagnosisSpanStatus =
    text === 2 || text === 'STATUS_CODE_ERROR' || text === 'ERROR' || text === '2'
      ? 'ERROR'
      : text === 1 || text === 'STATUS_CODE_OK' || text === 'OK' || text === '1'
        ? 'OK'
        : 'UNSET'
  return {
    code: normalized,
    message: typeof message === 'string' && message.length > 0 ? message : null,
  }
}

/**
 * The contract's classifier decides the kind, so the capability table and the
 * findings count the same tool and LLM spans. A top-level `kind` counts as a
 * declaration only when it is a contract kind; OTLP words such as
 * SPAN_KIND_INTERNAL fall through to the attribute and name signals.
 */
function resolveKind(kind: unknown, name: string, attributes: Record<string, unknown>): SpanKind {
  const declared =
    typeof kind === 'string' && (SPAN_KINDS as readonly string[]).includes(kind.toUpperCase())
      ? kind.toUpperCase()
      : undefined
  return resolveSpanKind({ ...(declared ? { kind: declared } : {}), name, attributes })
}

function digestInput(attributes: Record<string, unknown>, key: Buffer): string | null {
  for (const name of INPUT_ATTRIBUTE_KEYS) {
    const value = attributes[name]
    if (value === undefined || value === null || value === '') continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return createHmac('sha256', key).update(text).digest('hex').slice(0, 16)
  }
  return null
}

function idField(
  record: Record<string, unknown>,
  snake: string,
  camel: string,
): string | undefined {
  const value = record[snake] ?? record[camel]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function firstString(attributes: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}
