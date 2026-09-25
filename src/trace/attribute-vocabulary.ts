/**
 * Canonical OpenInference-over-OTLP attribute names used at trace boundaries.
 *
 * `@tangle-network/agent-trace-contract` owns the reader candidate lists; the
 * `*_ATTR_KEYS` below are its lists under the names this package exports. The
 * single-key constants are the keys this package's own producers write.
 */

import {
  ATTR,
  CACHE_READ_TOKEN_ATTR_KEYS,
  CACHE_WRITE_TOKEN_ATTR_KEYS,
  SPAN_KIND_ATTR_KEYS as CONTRACT_SPAN_KIND_ATTR_KEYS,
  TOOL_NAME_ATTR_KEYS as CONTRACT_TOOL_NAME_ATTR_KEYS,
  COST_ATTR_KEYS,
  INPUT_TOKEN_ATTR_KEYS,
  MODEL_ATTR_KEYS,
  OUTPUT_TOKEN_ATTR_KEYS,
  REASONING_TOKEN_ATTR_KEYS,
} from '@tangle-network/agent-trace-contract'

export const OPENINFERENCE_SPAN_KIND = ATTR.spanKind
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

export const SPAN_KIND_ATTR_KEYS: readonly string[] = CONTRACT_SPAN_KIND_ATTR_KEYS
export const LLM_MODEL_ATTR_KEYS: readonly string[] = MODEL_ATTR_KEYS
export const LLM_INPUT_TOKEN_ATTR_KEYS: readonly string[] = INPUT_TOKEN_ATTR_KEYS
export const LLM_OUTPUT_TOKEN_ATTR_KEYS: readonly string[] = OUTPUT_TOKEN_ATTR_KEYS
/** Reasoning-token subset of output, when a producer exposes it separately. */
export const LLM_REASONING_TOKEN_ATTR_KEYS: readonly string[] = REASONING_TOKEN_ATTR_KEYS
export const LLM_CACHED_TOKEN_ATTR_KEYS: readonly string[] = CACHE_READ_TOKEN_ATTR_KEYS
export const LLM_CACHE_WRITE_TOKEN_ATTR_KEYS: readonly string[] = CACHE_WRITE_TOKEN_ATTR_KEYS

/**
 * The contract's cost keys plus a bare `cost`. The contract refuses `cost` because
 * it answers "can this trace be costed" from key presence; this package reads it
 * only as a last-resort value on a span already known to be a model call.
 */
export const LLM_COST_ATTR_KEYS: readonly string[] = Object.freeze([...COST_ATTR_KEYS, 'cost'])

/** Explicit run-total cost keys safe to preserve on an untyped span. */
export const RUN_COST_ATTR_KEYS = ['tangle.cost.usd', 'cost.usd'] as const

export const TOOL_NAME_ATTR_KEYS: readonly string[] = CONTRACT_TOOL_NAME_ATTR_KEYS

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
