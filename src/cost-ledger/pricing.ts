/** Model-price lookup and caller-supplied token pricing, including receipt snapshots. */
import { estimateCost, resolveModelPricing } from '../metrics'
import type { CostReceipt, CostUsage, CustomTokenPricing } from './contract'
import { assertNonNegative, assertTokenCount, assertUsage } from './validation'



export interface CostResult {
  costUsd: number
  costUnknown: boolean
}

export function costForUsage(model: string, usage: CostUsage): CostResult {
  assertUsage(usage)
  if (!resolveModelPricing(model)) return { costUsd: 0, costUnknown: true }
  return {
    costUsd: estimateCost(
      usage.inputTokens + (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      usage.outputTokens,
      model,
    ),
    costUnknown: false,
  }
}

/** Price token counts with caller-supplied per-million rates. */
export function costForTokenPricing(
  pricing: CustomTokenPricing,
  usage: Pick<CostUsage, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens'>,
): number {
  assertTokenCount(usage.inputTokens, 'usage.inputTokens')
  assertTokenCount(usage.outputTokens, 'usage.outputTokens')
  if (usage.cachedTokens !== undefined) {
    assertTokenCount(usage.cachedTokens, 'usage.cachedTokens')
  }
  if (usage.cacheWriteTokens !== undefined) {
    assertTokenCount(usage.cacheWriteTokens, 'usage.cacheWriteTokens')
  }
  assertNonNegative(pricing.inputUsdPerMillion, 'pricing.inputUsdPerMillion')
  if (pricing.cachedInputUsdPerMillion !== undefined) {
    assertNonNegative(pricing.cachedInputUsdPerMillion, 'pricing.cachedInputUsdPerMillion')
  }
  if (pricing.cacheWriteUsdPerMillion !== undefined) {
    assertNonNegative(pricing.cacheWriteUsdPerMillion, 'pricing.cacheWriteUsdPerMillion')
  }
  assertNonNegative(pricing.outputUsdPerMillion, 'pricing.outputUsdPerMillion')
  const cachedInputRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion
  const cacheWriteRate = pricing.cacheWriteUsdPerMillion ?? pricing.inputUsdPerMillion
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillion +
    ((usage.cachedTokens ?? 0) / 1_000_000) * cachedInputRate +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) * cacheWriteRate +
    (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion
  )
}

export function costFromPricing(
  usage: CostUsage,
  pricing: NonNullable<CostReceipt['pricing']>,
): number {
  const cachedInputRate = pricing.cachedInputUsdPerThousand ?? pricing.inputUsdPerThousand
  const cacheWriteRate = pricing.cacheWriteUsdPerThousand ?? pricing.inputUsdPerThousand
  return (
    (usage.inputTokens / 1000) * pricing.inputUsdPerThousand +
    ((usage.cachedTokens ?? 0) / 1000) * cachedInputRate +
    ((usage.cacheWriteTokens ?? 0) / 1000) * cacheWriteRate +
    (usage.outputTokens / 1000) * pricing.outputUsdPerThousand
  )
}

export function pricingSnapshot(pricing: CustomTokenPricing): NonNullable<CostReceipt['pricing']> {
  costForTokenPricing(pricing, { inputTokens: 0, outputTokens: 0 })
  return {
    inputUsdPerThousand: pricing.inputUsdPerMillion / 1000,
    ...(pricing.cachedInputUsdPerMillion === undefined
      ? {}
      : { cachedInputUsdPerThousand: pricing.cachedInputUsdPerMillion / 1000 }),
    ...(pricing.cacheWriteUsdPerMillion === undefined
      ? {}
      : { cacheWriteUsdPerThousand: pricing.cacheWriteUsdPerMillion / 1000 }),
    outputUsdPerThousand: pricing.outputUsdPerMillion / 1000,
  }
}
