/** Canonical OpenInference-over-OTLP attribute vocabulary used at the trace boundary. */

import {
  INPUT_VALUE,
  LLM_MODEL_ATTR_KEYS,
  OUTPUT_VALUE,
  SPAN_KIND_ATTR_KEYS,
  TOOL_ARGS_CAPTURED,
  TOOL_LATENCY_MS,
  TOOL_NAME,
  TOOL_NAME_ATTR_KEYS,
} from './attribute-vocabulary'
import type { ToolSpan } from './schema'

export * from './attribute-vocabulary'

const TOOL_SPAN_ATTRIBUTE_KEYS = [
  TOOL_NAME,
  TOOL_ARGS_CAPTURED,
  TOOL_LATENCY_MS,
  INPUT_VALUE,
  OUTPUT_VALUE,
] as const

export type ToolSpanOtlpInput = Pick<
  ToolSpan,
  'toolName' | 'args' | 'argsCaptured' | 'result' | 'latencyMs'
>

export type OtlpSpanRole =
  | 'AGENT'
  | 'CHAIN'
  | 'EVALUATOR'
  | 'GUARDRAIL'
  | 'LLM'
  | 'SPAN'
  | 'TOOL'
  | 'UNKNOWN'

export interface OtlpSpanRoleInput {
  name: string
  attributes: Record<string, unknown>
  kind?: string | null
}

const EXPLICIT_SPAN_ROLES = new Set<OtlpSpanRole>([
  'AGENT',
  'CHAIN',
  'EVALUATOR',
  'GUARDRAIL',
  'LLM',
  'SPAN',
  'TOOL',
])

/**
 * Classify a span once for both measurement and error accounting.
 * An explicit OpenInference kind wins; untyped spans use the same tool and
 * model signals in online and offline intake.
 */
export function classifyOtlpSpanRole(input: OtlpSpanRoleInput): OtlpSpanRole {
  const explicitKind = input.kind ?? firstStringAttribute(input.attributes, SPAN_KIND_ATTR_KEYS)
  if (explicitKind) {
    const normalized = explicitKind.toUpperCase() as OtlpSpanRole
    if (EXPLICIT_SPAN_ROLES.has(normalized)) return normalized
  }

  if (
    firstStringAttribute(input.attributes, TOOL_NAME_ATTR_KEYS) !== undefined ||
    /^(?:function|tool)[.:/]/i.test(input.name)
  ) {
    return 'TOOL'
  }

  const spanType = input.attributes['span.type']
  if (
    (typeof spanType === 'string' && spanType.toLowerCase() === 'llm_request') ||
    /(?:^|[.:/_-])(?:chat[._-]?completions?|llm)(?:$|[.:/_-])/i.test(input.name) ||
    firstStringAttribute(input.attributes, LLM_MODEL_ATTR_KEYS) !== undefined ||
    typeof input.attributes['gen_ai.operation.name'] === 'string'
  ) {
    return 'LLM'
  }

  return 'UNKNOWN'
}

export function isOtlpModelCall(input: OtlpSpanRoleInput): boolean {
  return classifyOtlpSpanRole(input) === 'LLM'
}

function toolSpanOtlpAttributes(
  span: ToolSpanOtlpInput,
): Record<string, string | number | boolean> {
  const argsCaptured = span.argsCaptured !== false
  const attributes: Record<string, string | number | boolean> = {
    [TOOL_NAME]: span.toolName,
    [TOOL_ARGS_CAPTURED]: argsCaptured,
  }
  if (span.latencyMs !== undefined) attributes[TOOL_LATENCY_MS] = span.latencyMs
  if (argsCaptured) attributes[INPUT_VALUE] = stringifyTraceValue(span.args)
  if (span.result !== undefined) attributes[OUTPUT_VALUE] = stringifyTraceValue(span.result)
  return attributes
}

export function applyToolSpanOtlpAttributes(
  attributes: Record<string, unknown>,
  span: ToolSpanOtlpInput,
): void {
  for (const key of TOOL_SPAN_ATTRIBUTE_KEYS) delete attributes[key]
  Object.assign(attributes, toolSpanOtlpAttributes(span))
}

export function traceSpanKindToOpenInferenceKind(kind: string): string {
  switch (kind) {
    case 'llm':
      return 'LLM'
    case 'tool':
      return 'TOOL'
    case 'retrieval':
      return 'CHAIN'
    case 'judge':
      return 'EVALUATOR'
    case 'sandbox':
      return 'CHAIN'
    case 'agent':
      return 'AGENT'
    default:
      return 'SPAN'
  }
}

function firstStringAttribute(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function stringifyTraceValue(value: unknown): string {
  if (value === undefined) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
