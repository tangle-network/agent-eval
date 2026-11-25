/**
 * Model-price lookup, the owner of per-model rates, and caller-supplied token pricing,
 * including receipt snapshots. A cache read or write is priced only at a rate the table
 * names for it; a model without one is unpriced for that usage, never billed as fresh input.
 */
import type { CostReceipt, CostUsage, CustomTokenPricing } from './contract'
import { assertNonNegative, assertTokenCount, assertUsage } from './validation'

/** Per-1K rates. `cacheRead` and `cacheWrite` are absent when no published rate was read. */
export interface TokenPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  /** Rates for a request whose prompt (input, cache reads and cache writes) exceeds `aboveTokens`. */
  longPrompt?: Omit<TokenPrice, 'longPrompt'> & { aboveTokens: number }
}

/** Per-1K token pricing for exact model ids. */
export const MODEL_PRICING: Record<string, TokenPrice> = {
  // Anthropic published prices, https://platform.claude.com/docs/en/about-claude/pricing
  // (read 2026-11-25), per Mtok: input / 5-minute cache write / cache read / output.
  // A cache write is priced at the 5-minute rate; the 1-hour rate is 2x input and no
  // recorded usage says which duration a write used.
  // Fable 5.2: $8 / $10 / $0.20 / $40.
  'claude-fable-5-2': { input: 0.008, output: 0.04, cacheRead: 0.0002, cacheWrite: 0.01 },
  // Opus 5.5: $4 / $5 / $0.20 / $20.
  'claude-opus-5-5': { input: 0.004, output: 0.02, cacheRead: 0.0002, cacheWrite: 0.005 },
  // Sonnet 5.5: $2 / $2.50 / $0.10 / $10.
  'claude-sonnet-5-5': { input: 0.002, output: 0.01, cacheRead: 0.0001, cacheWrite: 0.0025 },
  // Haiku 5.5 bills a request whose prompt (input + cache reads + cache writes) is over
  // 100,000 tokens at the higher rates: $0.50 / $0.625 / $0.05 / $2.50. Up to 100,000:
  // $0.10 / $0.125 / $0.01 / $0.50.
  'claude-haiku-5-5': {
    input: 0.0001,
    output: 0.0005,
    cacheRead: 0.00001,
    cacheWrite: 0.000125,
    longPrompt: {
      aboveTokens: 100_000,
      input: 0.0005,
      output: 0.0025,
      cacheRead: 0.00005,
      cacheWrite: 0.000625,
    },
  },
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  'claude-opus-4-20250514': { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
  'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },
  // Router response-header rates observed for the exact served model on
  // 2026-08-15. Keep this exact row ahead of the deliberately coarse family
  // fallback so glm-5.3 campaign costs are not understated by ~2.5x.
  'glm-5.3': { input: 0.00168, output: 0.00528 },
  // Tangle Router's published rate (`GET /v1/models`) on 2026-10-09:
  // $0.10 / $0.50 per Mtok. Exact, because the coarse gpt-5 family row would
  // overstate it 12x on input and 20x on output.
  'gpt-6-luna': { input: 0.0001, output: 0.0005 },
  // Router receipts for the served id `gpt-5-mini-2025-08-07` solve exactly
  // to $0.25 / $2 per Mtok; the gpt-5 family row is 5x too high.
  'gpt-5-mini': { input: 0.00025, output: 0.002 },
}

/** Family-level pricing fallbacks (per-1K), matched against a normalized id
 *  after exact lookup misses. Ordered — first match wins. Covers the model
 *  ids actually used through the Tangle router + cli-bridge harnesses, none
 *  of which appear in the exact table above — without this they priced to a
 *  silent $0, blanking every cost/Pareto axis downstream. */
const FAMILY_PRICING: Array<[RegExp, TokenPrice]> = [
  // OpenRouter stealth previews (`stealth/union-alpha`, …) bill $0 during
  // their preview window. A real zero row lets the budget ledger admit them;
  // an unpriced id is refused before the first call.
  [/^stealth\//, { input: 0, output: 0 }],
  [/claude.*opus/, { input: 0.015, output: 0.075 }],
  [/claude.*haiku/, { input: 0.0008, output: 0.004 }],
  [/claude.*sonnet|claude-code|claude-sonnet/, { input: 0.003, output: 0.015 }],
  [/gpt-4o-mini/, { input: 0.00015, output: 0.0006 }],
  [/gpt-5|gpt-4\.1|o[134]\b/, { input: 0.00125, output: 0.01 }],
  [/gpt-4o|gpt-4/, { input: 0.0025, output: 0.01 }],
  [/deepseek/, { input: 0.0003, output: 0.0011 }],
  [/glm|zhipu|zai/, { input: 0.0006, output: 0.0022 }],
  [/kimi|moonshot/, { input: 0.0006, output: 0.0025 }],
  [/qwen/, { input: 0.0004, output: 0.0012 }],
  [/gemini.*flash/, { input: 0.0001, output: 0.0004 }],
  [/gemini/, { input: 0.00125, output: 0.005 }],
  [/llama/, { input: 0.0002, output: 0.0006 }],
]

/** Normalize a model id for pricing: drop `@snapshot` and trailing
 *  `-YYYY-MM-DD` dated-snapshot suffixes, lowercase, and return the complete
 *  id plus its final served-model segment for exact-row lookup. */
function normalizedModelIds(model: string): string[] {
  const stripped = (model.split('@')[0] ?? model).trim().toLowerCase()
  const id = stripped.replace(/-(?:19|20)\d{2}-\d{2}-\d{2}$/, '')
  const finalSegment = id.slice(id.lastIndexOf('/') + 1)
  return finalSegment === id ? [id] : [id, finalSegment]
}

/** Resolve pricing for a model id: exact table, then family fallback.
 *  Returns null when the id matches nothing (caller decides — never a
 *  silent-zero masquerading as a real $0 cost). */
export function resolveModelPricing(model: string): TokenPrice | null {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]
  const ids = normalizedModelIds(model)
  for (const id of ids) {
    if (MODEL_PRICING[id]) return MODEL_PRICING[id]
  }
  for (const [pattern, price] of FAMILY_PRICING) {
    if (ids.some((id) => pattern.test(id))) return price
  }
  return null
}

/** True when `model` has known pricing: distinguishes a real $0 from unpriced. */
export function isModelPriced(model: string): boolean {
  return resolveModelPricing(model) !== null
}

const warnedUnpricedModels = new Set<string>()

/** Calculate cost in USD from token counts and model. Unknown models warn once
 *  (not a silent zero) and return 0; cost-sensitive callers gate on {@link isModelPriced}. */
export function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  const pricing = resolveModelPricing(model)
  if (!pricing) {
    if (!warnedUnpricedModels.has(model)) {
      warnedUnpricedModels.add(model)
      console.warn(`estimateCost: no pricing for "${model}" — returning 0; add it to MODEL_PRICING`)
    }
    return 0
  }
  return (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output
}

export interface CostResult {
  costUsd: number
  costUnknown: boolean
}

/** The rates that apply to one request: the long-prompt rates when its prompt is over their threshold. */
export function priceForUsage(price: TokenPrice, usage: CostUsage): TokenPrice {
  const long = price.longPrompt
  if (!long) return price
  const prompt = usage.inputTokens + (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return prompt > long.aboveTokens ? { ...long } : price
}

/**
 * Price one response from the table. Unknown when the model has no row, or when the usage
 * has cache reads or writes and the row has no rate for them.
 */
export function costForUsage(model: string, usage: CostUsage): CostResult {
  assertUsage(usage)
  const row = resolveModelPricing(model)
  if (!row) return { costUsd: 0, costUnknown: true }
  const price = priceForUsage(row, usage)
  const cached = usage.cachedTokens ?? 0
  const written = usage.cacheWriteTokens ?? 0
  if ((cached > 0 && price.cacheRead === undefined) || (written > 0 && price.cacheWrite === undefined)) {
    return { costUsd: 0, costUnknown: true }
  }
  return {
    costUsd:
      (usage.inputTokens / 1000) * price.input +
      (cached / 1000) * (price.cacheRead ?? 0) +
      (written / 1000) * (price.cacheWrite ?? 0) +
      (usage.outputTokens / 1000) * price.output,
    costUnknown: false,
  }
}

/** The receipt pricing snapshot for a table row, with the cache rates it names. */
export function modelPricingSnapshot(
  row: TokenPrice,
  usage: CostUsage,
): NonNullable<CostReceipt['pricing']> {
  const price = priceForUsage(row, usage)
  return {
    inputUsdPerThousand: price.input,
    outputUsdPerThousand: price.output,
    ...(price.cacheRead === undefined ? {} : { cachedInputUsdPerThousand: price.cacheRead }),
    ...(price.cacheWrite === undefined ? {} : { cacheWriteUsdPerThousand: price.cacheWrite }),
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
