/** Canonical OpenInference-over-OTLP attribute names used at trace boundaries. */

import {
  GEN_AI_INPUT_TOKEN_KEYS,
  GEN_AI_MODEL_KEYS,
  GEN_AI_OUTPUT_TOKEN_KEYS,
} from '@tangle-network/agent-core/telemetry'

export const OPENINFERENCE_SPAN_KIND = 'openinference.span.kind'
export const LLM_MODEL_NAME = 'llm.model_name'
export const LLM_INPUT_TOKENS = 'llm.token_count.prompt'
export const LLM_OUTPUT_TOKENS = 'llm.token_count.completion'
export const LLM_REASONING_TOKENS = 'llm.token_count.reasoning'
export const LLM_CACHED_TOKENS = 'llm.token_count.prompt_cache_hit'
export const LLM_CACHE_WRITE_TOKENS = 'llm.token_count.prompt_cache_write'
/** Exact prompt context after summing mutually exclusive input/cache categories. */
export const LLM_CONTEXT_TOKENS = 'tangle.llm.context_tokens'
export const LLM_COST_USD = 'llm.cost_usd'
export const TOOL_NAME = 'tool.name'
export const TOOL_ARGS_CAPTURED = 'tool.args_captured'
export const TOOL_LATENCY_MS = 'tool.latency_ms'
export const INPUT_VALUE = 'input.value'
export const OUTPUT_VALUE = 'output.value'

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

/** Read a numeric attribute, tolerating numeric strings; `null` if absent or invalid. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** First finite numeric value across a list of candidate attribute keys. */
export function firstNumberAttr(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = asNumber(attributes[key])
    if (value !== null) return value
  }
  return null
}

/** Sum producer-supplied, mutually exclusive prompt-token categories. */
export function contextInputTokens(usage: {
  inputTokens?: number | null
  cachedTokens?: number | null
  cacheWriteTokens?: number | null
}): number | undefined {
  if (usage.inputTokens === undefined || usage.inputTokens === null) return undefined
  return usage.inputTokens + (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

export interface LlmSpanOtlpInput {
  model?: string
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
  finishReason?: string
}

/** Write the canonical LLM attributes shared by trace producers. */
export function applyLlmSpanOtlpAttributes(
  attributes: Record<string, unknown>,
  span: LlmSpanOtlpInput,
): void {
  if (span.model !== undefined) attributes[LLM_MODEL_NAME] = span.model
  if (span.inputTokens !== undefined) attributes[LLM_INPUT_TOKENS] = span.inputTokens
  if (span.outputTokens !== undefined) attributes[LLM_OUTPUT_TOKENS] = span.outputTokens
  if (span.reasoningTokens !== undefined) attributes[LLM_REASONING_TOKENS] = span.reasoningTokens
  if (span.cachedTokens !== undefined) attributes[LLM_CACHED_TOKENS] = span.cachedTokens
  if (span.cacheWriteTokens !== undefined) {
    attributes[LLM_CACHE_WRITE_TOKENS] = span.cacheWriteTokens
  }
  const contextTokens = contextInputTokens(span)
  if (contextTokens !== undefined) attributes[LLM_CONTEXT_TOKENS] = contextTokens
  if (span.costUsd !== undefined) attributes[LLM_COST_USD] = span.costUsd
  if (span.finishReason) attributes['llm.finish_reason'] = span.finishReason
}
