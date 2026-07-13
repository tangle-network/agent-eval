/** Canonical OpenInference-over-OTLP attribute vocabulary used at the trace boundary. */

import type { ToolSpan } from './schema'

export const OPENINFERENCE_SPAN_KIND = 'openinference.span.kind'
export const LLM_MODEL_NAME = 'llm.model_name'
export const LLM_INPUT_TOKENS = 'llm.token_count.prompt'
export const LLM_OUTPUT_TOKENS = 'llm.token_count.completion'
export const LLM_CACHED_TOKENS = 'llm.token_count.prompt_cache_hit'
export const LLM_COST_USD = 'llm.cost_usd'
export const TOOL_NAME = 'tool.name'
export const TOOL_ARGS_CAPTURED = 'tool.args_captured'
export const TOOL_LATENCY_MS = 'tool.latency_ms'
export const INPUT_VALUE = 'input.value'
export const OUTPUT_VALUE = 'output.value'

const TOOL_SPAN_ATTRIBUTE_KEYS = [
  TOOL_NAME,
  TOOL_ARGS_CAPTURED,
  TOOL_LATENCY_MS,
  INPUT_VALUE,
  OUTPUT_VALUE,
] as const

export const SPAN_KIND_ATTR_KEYS = [OPENINFERENCE_SPAN_KIND, 'inference.observation_kind'] as const

export const LLM_MODEL_ATTR_KEYS = [
  LLM_MODEL_NAME,
  'inference.llm.model_name',
  'llm.model',
  'gen_ai.request.model',
  'gen_ai.response.model',
] as const

export const LLM_INPUT_TOKEN_ATTR_KEYS = [
  LLM_INPUT_TOKENS,
  'inference.llm.input_tokens',
  'llm.input_tokens',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.prompt_tokens',
] as const

export const LLM_OUTPUT_TOKEN_ATTR_KEYS = [
  LLM_OUTPUT_TOKENS,
  'inference.llm.output_tokens',
  'llm.output_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.completion_tokens',
] as const

export const LLM_CACHED_TOKEN_ATTR_KEYS = [
  LLM_CACHED_TOKENS,
  'inference.llm.cached_tokens',
  'llm.cached_tokens',
  'gen_ai.usage.cached_tokens',
] as const

export const LLM_COST_ATTR_KEYS = [
  LLM_COST_USD,
  'inference.llm.cost.total',
  'llm.cost.total',
  'gen_ai.usage.cost',
] as const

export const TOOL_NAME_ATTR_KEYS = [TOOL_NAME, 'inference.tool.name'] as const

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
