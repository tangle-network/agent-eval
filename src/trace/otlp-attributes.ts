/** Canonical OpenInference-over-OTLP attribute vocabulary used at the trace boundary. */

import {
  INPUT_VALUE,
  OUTPUT_VALUE,
  TOOL_ARGS_CAPTURED,
  TOOL_LATENCY_MS,
  TOOL_NAME,
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
      return 'GUARDRAIL'
    case 'sandbox':
      return 'CHAIN'
    case 'agent':
      return 'AGENT'
    default:
      return 'SPAN'
  }
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
