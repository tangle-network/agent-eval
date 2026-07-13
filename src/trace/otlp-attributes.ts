/** Canonical OpenInference-over-OTLP attribute vocabulary used at the trace boundary. */

import {
  GEN_AI_INPUT_TOKEN_KEYS,
  GEN_AI_MODEL_KEYS,
  GEN_AI_OUTPUT_TOKEN_KEYS,
} from '@tangle-network/agent-core/telemetry'
import type { ToolSpan } from './schema'

export const OPENINFERENCE_SPAN_KIND = 'openinference.span.kind'
export const LLM_MODEL_NAME = 'llm.model_name'
export const LLM_INPUT_TOKENS = 'llm.token_count.prompt'
export const LLM_OUTPUT_TOKENS = 'llm.token_count.completion'
export const LLM_REASONING_TOKENS = 'llm.token_count.reasoning'
export const LLM_CACHED_TOKENS = 'llm.token_count.prompt_cache_hit'
export const LLM_CACHE_WRITE_TOKENS = 'llm.token_count.prompt_cache_write'
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
  ...GEN_AI_MODEL_KEYS,
  'tangle.model',
] as const

export const LLM_INPUT_TOKEN_ATTR_KEYS = [
  LLM_INPUT_TOKENS,
  'inference.llm.input_tokens',
  'llm.input_tokens',
  ...GEN_AI_INPUT_TOKEN_KEYS,
  'tangle.tokens.in',
  'tokens.in',
] as const

export const LLM_OUTPUT_TOKEN_ATTR_KEYS = [
  LLM_OUTPUT_TOKENS,
  'inference.llm.output_tokens',
  'llm.output_tokens',
  ...GEN_AI_OUTPUT_TOKEN_KEYS,
  'tangle.tokens.out',
  'tokens.out',
] as const

/** Reasoning-token subset of output, when a producer exposes it separately. */
export const LLM_REASONING_TOKEN_ATTR_KEYS = [
  LLM_REASONING_TOKENS,
  'inference.llm.reasoning_tokens',
  'llm.reasoning_tokens',
  'gen_ai.usage.reasoning_tokens',
  'gen_ai.usage.reasoning_output_tokens',
  'reasoning_tokens',
  'reasoning_output_tokens',
  'tangle.tokens.reasoning',
  'gen_ai.usage.output_tokens_details.reasoning_tokens',
  'gen_ai.usage.completion_tokens_details.reasoning_tokens',
] as const

export const LLM_CACHED_TOKEN_ATTR_KEYS = [
  LLM_CACHED_TOKENS,
  'inference.llm.cached_tokens',
  'llm.cached_tokens',
  'gen_ai.usage.cached_tokens',
  'gen_ai.usage.prompt_tokens_details.cached_tokens',
  'gen_ai.usage.input_tokens_details.cached_tokens',
  'gen_ai.usage.cache_read_tokens',
  'gen_ai.usage.cache_read_input_tokens',
  'cache_read_tokens',
  'cache_read_input_tokens',
  'input_cache_read',
  'tangle.tokens.cached',
] as const

export const LLM_CACHE_WRITE_TOKEN_ATTR_KEYS = [
  LLM_CACHE_WRITE_TOKENS,
  'inference.llm.cache_write_tokens',
  'llm.cache_write_tokens',
  'gen_ai.usage.cache_creation_tokens',
  'gen_ai.usage.cache_creation_input_tokens',
  'cache_creation_tokens',
  'cache_creation_input_tokens',
  'input_cache_creation',
  'tangle.tokens.cache_write',
] as const

export const LLM_COST_ATTR_KEYS = [
  LLM_COST_USD,
  'inference.llm.cost.total',
  'llm.cost.total',
  'gen_ai.usage.cost',
  'gen_ai.usage.cost_usd',
  'tangle.cost.usd',
  'cost.usd',
  'cost',
] as const

/** Explicit run-total cost keys safe to preserve on an untyped span. */
export const RUN_COST_ATTR_KEYS = ['tangle.cost.usd', 'cost.usd'] as const

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
