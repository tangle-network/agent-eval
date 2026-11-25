export {
  estimateCost,
  isModelPriced,
  MODEL_PRICING,
  resolveModelPricing,
  type TokenPrice,
} from './cost-ledger/pricing'

/** Estimate token count from string length (chars / 4 approximation) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
