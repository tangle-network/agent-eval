/** Canonical OpenInference-over-OTLP attribute names used at trace boundaries. */

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
