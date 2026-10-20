/** Create, validate, filter, and detach the receipts stored by a cost ledger. */
import { z } from 'zod'
import { ValidationError } from '../errors'
import { resolveModelPricing } from '../metrics'
import type {
  CostCallBase,
  CostLedgerFilter,
  CostLedgerRecord,
  CostReceipt,
  CostReceiptInput,
  CostUsage,
  PendingCostCall,
  RunPaidCallInput,
} from './contract'
import { costForUsage, costFromPricing, pricingSnapshot } from './pricing'
import { assertNonNegative, assertString, assertUsage, validationMessage } from './validation'

const NonEmptyString = z.string().refine((value) => value.trim().length > 0, 'must be non-empty')
export const TokenCount = z.number().int().nonnegative().finite()
export const NonNegative = z.number().nonnegative().finite()
const Tags = z.record(NonEmptyString, z.string())
const CostPricingSchema = z.strictObject({
  inputUsdPerThousand: NonNegative,
  cachedInputUsdPerThousand: NonNegative.optional(),
  cacheWriteUsdPerThousand: NonNegative.optional(),
  outputUsdPerThousand: NonNegative,
})
const CostCallBaseShape = {
  callId: NonEmptyString,
  channel: NonEmptyString,
  phase: NonEmptyString,
  actor: NonEmptyString,
  model: NonEmptyString,
  maximumCostUsd: NonNegative.optional(),
  tags: Tags.optional(),
  timestamp: NonNegative,
}
export const PendingCostCallSchema = z.strictObject({
  status: z.literal('pending'),
  ...CostCallBaseShape,
})
const CostReceiptBaseShape = {
  status: z.literal('settled'),
  ...CostCallBaseShape,
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cachedTokens: TokenCount.optional(),
  costUsd: NonNegative,
  costUnknown: z.boolean(),
  usageUnknown: z.boolean().default(false),
  pricing: CostPricingSchema.optional(),
  actualCostUsd: NonNegative.optional(),
  estimatedCostUsd: NonNegative.optional(),
  error: NonEmptyString.optional(),
}
export const CostReceiptSchema = z
  .strictObject({
    ...CostReceiptBaseShape,
    reasoningTokens: TokenCount.optional(),
    cacheWriteTokens: TokenCount.optional(),
  })
  .superRefine((receipt, ctx) => validateCostReceipt(receipt, ctx))

function validateCostReceipt(
  receipt: CostUsage & {
    costUsd: number
    costUnknown: boolean
    usageUnknown: boolean
    pricing?: NonNullable<CostReceipt['pricing']>
    actualCostUsd?: number
    estimatedCostUsd?: number
  },
  ctx: z.RefinementCtx,
): void {
  if (receipt.reasoningTokens !== undefined && receipt.reasoningTokens > receipt.outputTokens) {
    ctx.addIssue({ code: 'custom', message: 'reasoningTokens must not exceed outputTokens' })
  }

  if (receipt.actualCostUsd !== undefined && receipt.estimatedCostUsd !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'actual and external estimated costs cannot both be present',
    })
  }

  if (receipt.actualCostUsd !== undefined) {
    if (receipt.costUnknown || receipt.costUsd !== receipt.actualCostUsd) {
      ctx.addIssue({ code: 'custom', message: 'actual cost must be known and equal costUsd' })
    }
    if (receipt.pricing !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'actual cost must not include estimated pricing' })
    }
    return
  }

  if (receipt.estimatedCostUsd !== undefined) {
    if (receipt.costUnknown || receipt.costUsd !== receipt.estimatedCostUsd) {
      ctx.addIssue({ code: 'custom', message: 'external estimate must be known and equal costUsd' })
    }
    if (receipt.pricing !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'external estimate must not include token pricing' })
    }
    return
  }

  if (receipt.costUnknown) {
    if (receipt.costUsd !== 0) {
      ctx.addIssue({ code: 'custom', message: 'unknown cost must have costUsd 0' })
    }
    if (receipt.pricing !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'unknown cost must not include estimated pricing' })
    }
    return
  }

  if (receipt.usageUnknown) {
    ctx.addIssue({ code: 'custom', message: 'known estimated cost requires known usage' })
  }
  if (!receipt.pricing) {
    ctx.addIssue({ code: 'custom', message: 'known estimated cost requires a pricing snapshot' })
    return
  }

  const expected = costFromPricing(receipt, receipt.pricing)
  if (!costAmountsMatch(receipt.costUsd, expected)) {
    ctx.addIssue({
      code: 'custom',
      message: `estimated cost ${receipt.costUsd} does not match pricing snapshot ${expected}`,
    })
  }
}

function costAmountsMatch(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= Number.EPSILON * scale * 8
}

export function buildReceipt(
  pending: PendingCostCall,
  observed: CostReceiptInput,
  failed = false,
  error?: string,
): CostReceipt {
  assertUsage(observed)
  assertString(observed.model, 'receipt.model')
  const suppliedAmounts = [
    observed.actualCostUsd,
    observed.estimatedCostUsd,
    observed.customTokenPricing,
  ].filter((value) => value !== undefined)
  if (suppliedAmounts.length > 1) {
    throw new ValidationError(
      'CostLedger: a receipt can have only one of actualCostUsd, estimatedCostUsd, or customTokenPricing',
    )
  }
  const customPricingSnapshot =
    observed.customTokenPricing === undefined
      ? undefined
      : pricingSnapshot(observed.customTokenPricing)
  const estimated = customPricingSnapshot
    ? {
        costUsd: costFromPricing(observed, customPricingSnapshot),
        costUnknown: false,
      }
    : costForUsage(observed.model, observed)
  const hasActual = observed.actualCostUsd !== undefined
  const hasExternalEstimate = observed.estimatedCostUsd !== undefined
  if (hasActual && observed.costUnknown === true) {
    throw new ValidationError(
      'CostLedger: a receipt cannot have both actualCostUsd and costUnknown=true',
    )
  }
  if (hasActual) assertNonNegative(observed.actualCostUsd!, 'actualCostUsd')
  if (hasExternalEstimate) assertNonNegative(observed.estimatedCostUsd!, 'estimatedCostUsd')
  if (hasExternalEstimate && observed.costUnknown === true) {
    throw new ValidationError(
      'CostLedger: a receipt cannot have both estimatedCostUsd and costUnknown=true',
    )
  }
  const usageUnknown = observed.usageUnknown === true
  const costUnknown =
    observed.costUnknown === true ||
    (!hasActual && !hasExternalEstimate && (usageUnknown || estimated.costUnknown))
  const resolvedModelPricing =
    !customPricingSnapshot && !hasActual && !hasExternalEstimate && !costUnknown
      ? resolveModelPricing(observed.model)
      : null
  const receiptPricing =
    !hasActual && !hasExternalEstimate && !costUnknown
      ? (customPricingSnapshot ??
        (resolvedModelPricing
          ? {
              inputUsdPerThousand: resolvedModelPricing.input,
              outputUsdPerThousand: resolvedModelPricing.output,
            }
          : undefined))
      : undefined
  return parseReceipt(
    {
      status: 'settled',
      callId: pending.callId,
      channel: pending.channel,
      phase: pending.phase,
      actor: pending.actor,
      model: observed.model,
      inputTokens: observed.inputTokens,
      outputTokens: observed.outputTokens,
      ...(observed.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: observed.reasoningTokens }),
      ...(observed.cachedTokens === undefined ? {} : { cachedTokens: observed.cachedTokens }),
      ...(observed.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: observed.cacheWriteTokens }),
      costUsd: costUnknown
        ? 0
        : hasActual
          ? observed.actualCostUsd!
          : hasExternalEstimate
            ? observed.estimatedCostUsd!
            : estimated.costUsd,
      costUnknown,
      usageUnknown,
      ...(receiptPricing ? { pricing: receiptPricing } : {}),
      ...(hasActual ? { actualCostUsd: observed.actualCostUsd } : {}),
      ...(hasExternalEstimate ? { estimatedCostUsd: observed.estimatedCostUsd } : {}),
      ...(pending.maximumCostUsd === undefined ? {} : { maximumCostUsd: pending.maximumCostUsd }),
      ...(failed ? { error: error ?? 'paid-call-failed' } : {}),
      ...(pending.tags ? { tags: { ...pending.tags } } : {}),
      timestamp: pending.timestamp,
    },
    'provider receipt',
  )
}

export function parseReceipt(value: unknown, path: string): CostReceipt {
  try {
    return CostReceiptSchema.parse(value) as CostReceipt
  } catch (cause) {
    throw new ValidationError(`CostLedger: invalid ${path}: ${validationMessage(cause)}`, { cause })
  }
}

export function parseImportedReceipt(value: unknown, path: string): CostReceipt {
  if (typeof value !== 'object' || value === null) return parseReceipt(value, path)
  const candidate = { ...value } as Record<string, unknown>
  if (
    candidate.status === 'settled' &&
    candidate.actualCostUsd === undefined &&
    candidate.estimatedCostUsd === undefined &&
    candidate.costUnknown === false &&
    candidate.pricing === undefined &&
    typeof candidate.model === 'string'
  ) {
    const pricing = resolveModelPricing(candidate.model)
    if (pricing) {
      candidate.pricing = {
        inputUsdPerThousand: pricing.input,
        outputUsdPerThousand: pricing.output,
      }
    }
  }
  return parseReceipt(candidate, path)
}

export function validateAttribution(
  input: Pick<RunPaidCallInput<unknown>, 'channel' | 'phase' | 'actor' | 'model' | 'tags'>,
): void {
  assertString(input.channel, 'channel')
  assertString(input.phase, 'phase')
  assertString(input.actor, 'actor')
  if (input.model !== undefined) assertString(input.model, 'model')
  if (input.tags !== undefined) {
    const parsed = Tags.safeParse(input.tags)
    if (!parsed.success)
      throw new ValidationError(`CostLedger: invalid tags: ${parsed.error.message}`)
  }
}

export function matches(record: CostCallBase, filter: CostLedgerFilter | undefined): boolean {
  if (!filter) return true
  if (filter.channel !== undefined && record.channel !== filter.channel) return false
  if (filter.phase !== undefined && record.phase !== filter.phase) return false
  return Object.entries(filter.tags ?? {}).every(([key, value]) => record.tags?.[key] === value)
}

export function cloneRecord(record: CostLedgerRecord): CostLedgerRecord {
  if (record.status === 'settled') return cloneReceipt(record)
  return clonePendingCall(record)
}

export function clonePendingCall(record: PendingCostCall): PendingCostCall {
  const { tags, ...rest } = record
  return { ...rest, ...(tags ? { tags: { ...tags } } : {}) }
}

export function cloneReceipt(receipt: CostReceipt): CostReceipt {
  const { pricing, tags, ...rest } = receipt
  return {
    ...rest,
    ...(tags ? { tags: { ...tags } } : {}),
    ...(pricing ? { pricing: { ...pricing } } : {}),
  }
}
