import type { OptimizerModelBudget } from '../../src/campaign'
import { optionalNonNegativeNumberEnv, positiveIntegerEnv, positiveNumberEnv } from './env'

export function optimizerModelBudgetFromEnv(
  prefix: 'GEPA' | 'SKILLOPT',
  defaultMaxCostUsd: number,
  fallbackPricing?: {
    inputUsdPerMillion: number
    outputUsdPerMillion: number
  },
): OptimizerModelBudget {
  const inputUsdPerMillion =
    optionalNonNegativeNumberEnv(`${prefix}_PRICE_IN_PER_M`) ?? fallbackPricing?.inputUsdPerMillion
  const outputUsdPerMillion =
    optionalNonNegativeNumberEnv(`${prefix}_PRICE_OUT_PER_M`) ??
    fallbackPricing?.outputUsdPerMillion
  if (inputUsdPerMillion === undefined || outputUsdPerMillion === undefined) {
    throw new Error(
      `Set ${prefix}_PRICE_IN_PER_M and ${prefix}_PRICE_OUT_PER_M to the exact endpoint rates`,
    )
  }
  return {
    maxCostUsd: positiveNumberEnv(`${prefix}_MAX_MODEL_COST_USD`, defaultMaxCostUsd),
    maxRequests: positiveIntegerEnv(`${prefix}_MAX_MODEL_REQUESTS`, 100),
    maxRequestBytes: positiveIntegerEnv(`${prefix}_MAX_REQUEST_BYTES`, 2_000_000),
    maxResponseBytes: positiveIntegerEnv(`${prefix}_MAX_RESPONSE_BYTES`, 2_000_000),
    maxOutputTokensPerRequest: positiveIntegerEnv(
      `${prefix}_MAX_OUTPUT_TOKENS_PER_REQUEST`,
      32_768,
    ),
    requestTimeoutMs: positiveIntegerEnv(`${prefix}_MODEL_TIMEOUT_MS`, 300_000),
    pricing: {
      inputUsdPerMillion,
      outputUsdPerMillion,
    },
  }
}
