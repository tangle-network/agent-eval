// Per-model cost estimator for multishot legs whose transport reported token
// usage but no billed amount.

/**
 * Rough per-model cost estimate from token counts. Underestimates Anthropic,
 * overestimates open-weight models — accurate enough for a cost ceiling, and
 * never presented as a billed amount: a leg metered from this table is
 * recorded with `estimated` provenance.
 */
export function estimateMultishotCost(
  model: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number },
): number {
  if (!usage) return 0
  const inputTok = usage.prompt_tokens ?? 0
  const outputTok = usage.completion_tokens ?? 0
  let inPer1k = 0.003
  let outPer1k = 0.015
  if (model.includes('gpt-4o-mini')) {
    inPer1k = 0.00015
    outPer1k = 0.0006
  } else if (model.includes('gpt-5.4') || model.includes('claude-sonnet')) {
    inPer1k = 0.003
    outPer1k = 0.015
  } else if (model.includes('kimi') || model.includes('glm') || model.includes('deepseek')) {
    inPer1k = 0.0005
    outPer1k = 0.002
  }
  return (inputTok * inPer1k + outputTok * outPer1k) / 1000
}
