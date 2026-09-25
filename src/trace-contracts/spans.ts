import {
  firstNumberAttr,
  firstStringAttr,
  INPUT_TOKEN_ATTR_KEYS,
  MODEL_ATTR_KEYS,
  OUTPUT_TOKEN_ATTR_KEYS,
  resolveSpanKind,
  SPAN_KINDS,
  type SpanKind,
  TOOL_NAME_ATTR_KEYS,
} from '@tangle-network/agent-trace-contract'
import type { ContractSpan } from './types'

// ── Span readers ──────────────────────────────────────────────────────

// Eval kinds whose names are not contract kinds. `tool`, `llm`, and `agent`
// already resolve by upper-casing; `sandbox` and `custom` stay undeclared and
// fall through to inference.
const EVAL_KIND_TO_CONTRACT_KIND: ReadonlyMap<string, SpanKind> = new Map([
  ['judge', 'EVALUATOR'],
  ['retrieval', 'RETRIEVER'],
])

/**
 * The span's contract kind: a declared kind when recognised, else inferred.
 * A top-level `kind` counts as a declaration only when it names a contract
 * kind; OTLP words such as `SPAN_KIND_INTERNAL` and the eval kinds `sandbox`
 * and `custom` fall through to the span-kind attribute and name signals.
 */
export function contractSpanKind(span: ContractSpan): SpanKind {
  const raw = typeof span.kind === 'string' ? span.kind : undefined
  const mapped =
    raw === undefined ? undefined : (EVAL_KIND_TO_CONTRACT_KIND.get(raw) ?? raw.toUpperCase())
  const declared =
    mapped !== undefined && (SPAN_KINDS as readonly string[]).includes(mapped) ? mapped : undefined
  return resolveSpanKind({
    ...(declared === undefined ? {} : { kind: declared }),
    name: span.name,
    attributes: span.attributes ?? {},
  })
}

/**
 * Tool name: `span.toolName` (typed ToolSpan) → the tool-name attributes
 * (`gen_ai.tool.name`, `tool.name`, ..., `toolName`) → `span.name` when the
 * span is a TOOL span.
 */
export function contractSpanToolName(span: ContractSpan): string | undefined {
  if (typeof span.toolName === 'string') return span.toolName
  const attributes = span.attributes ?? {}
  const fromAttr =
    firstStringAttr(attributes, TOOL_NAME_ATTR_KEYS) ?? firstStringAttr(attributes, ['toolName'])
  if (fromAttr !== undefined) return fromAttr
  if (typeof span.name === 'string' && contractSpanKind(span) === 'TOOL') return span.name
  return undefined
}

export function spanModel(span: ContractSpan): string | undefined {
  if (typeof span.model === 'string' && span.model.length > 0) return span.model
  return firstStringAttr(span.attributes ?? {}, MODEL_ATTR_KEYS)
}

/** Input plus output tokens, or `undefined` when either side is unrecorded. */
export function spanTotalTokens(span: ContractSpan): number | undefined {
  const attributes = span.attributes ?? {}
  const input = finite(span.inputTokens) ?? firstNumberAttr(attributes, INPUT_TOKEN_ATTR_KEYS)
  const output = finite(span.outputTokens) ?? firstNumberAttr(attributes, OUTPUT_TOKEN_ATTR_KEYS)
  return input === undefined || output === undefined ? undefined : input + output
}

const ARGUMENT_ATTR_KEYS = ['gen_ai.tool.call.arguments', 'tool.arguments', 'input.value'] as const

export type ArgumentEvidence = { known: true; value: unknown } | { known: false; reason: string }

/** The call's arguments: the typed `args` field, else the argument attributes.
 *  JSON strings are parsed; an unparseable string is kept as a string. */
export function spanArguments(span: ContractSpan): ArgumentEvidence {
  if (span.argsCaptured === false || span.attributes?.['tool.args_captured'] === false) {
    return { known: false, reason: 'arguments were not captured' }
  }
  if (span.args !== undefined) return { known: true, value: parseJsonString(span.args) }
  for (const key of ARGUMENT_ATTR_KEYS) {
    const value = span.attributes?.[key]
    if (value !== undefined && value !== null) return { known: true, value: parseJsonString(value) }
  }
  return { known: false, reason: 'the span carries no argument evidence' }
}

/** The OTel GenAI attribute listing the tool definitions offered to the
 *  model: an array (or its JSON string) of `{ name }`, `{ function: { name } }`
 *  or plain names. */
export const TOOL_DEFINITIONS_ATTR = 'gen_ai.tool.definitions'

export type OfferedTools =
  | { recorded: false }
  | { recorded: true; names: string[] }
  | { recorded: true; unreadable: string }

/** The tool names a span records as offered to the model. */
export function spanOfferedTools(span: ContractSpan): OfferedTools {
  const raw = span.attributes?.[TOOL_DEFINITIONS_ATTR]
  if (raw === undefined || raw === null) return { recorded: false }
  const value = parseJsonString(raw)
  if (!Array.isArray(value)) {
    return { recorded: true, unreadable: `${TOOL_DEFINITIONS_ATTR} is not a list` }
  }
  const names: string[] = []
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry : definitionName(entry)
    if (name === undefined) {
      return {
        recorded: true,
        unreadable: `${TOOL_DEFINITIONS_ATTR} has an entry without a tool name`,
      }
    }
    names.push(name)
  }
  return { recorded: true, names }
}

function definitionName(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  if (typeof record.name === 'string' && record.name.length > 0) return record.name
  const fn = record.function as Record<string, unknown> | undefined
  return fn !== null && typeof fn === 'object' && typeof fn.name === 'string' && fn.name.length > 0
    ? fn.name
    : undefined
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function isSpanError(span: ContractSpan): boolean {
  return typeof span.status === 'string' && /^(?:error|status_code_error)$/i.test(span.status)
}
