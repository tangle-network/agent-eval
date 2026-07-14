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
