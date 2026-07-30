import type { CostChannel, CostLedgerFilter, CostLedgerHandle } from '../cost-ledger'
import type { AnalystUsageReceipt } from './types'

export const DEFAULT_USAGE_SETTLEMENT_TIMEOUT_MS = 5_000

/** Convert one ledger channel's complete call set into one analyst receipt. */
export function usageReceiptFromCostLedger(
  ledger: CostLedgerHandle,
  filter: CostChannel | CostLedgerFilter = 'analyst',
): AnalystUsageReceipt {
  const resolvedFilter = typeof filter === 'string' ? { channel: filter } : filter
  const summary = ledger.summary(resolvedFilter)
  const receipts = ledger.list(resolvedFilter)
  const hasReasoningUsage = receipts.some((receipt) => receipt.reasoningTokens !== undefined)
  const hasCacheWriteUsage = receipts.some((receipt) => receipt.cacheWriteTokens !== undefined)
  const cost = summary.costProvenance
  return {
    calls: summary.totalCalls + summary.pendingCalls,
    tokens: summary.usageComplete
      ? {
          input: summary.inputTokens,
          output: summary.outputTokens,
          ...(hasReasoningUsage ? { reasoning: summary.reasoningTokens ?? 0 } : {}),
          ...(summary.cachedTokens > 0 ? { cached: summary.cachedTokens } : {}),
          ...(hasCacheWriteUsage ? { cacheWrite: summary.cacheWriteTokens ?? 0 } : {}),
        }
      : null,
    cost,
    ...(cost.kind === 'uncaptured' ? { knownCostUsd: summary.totalCostUsd } : {}),
  }
}

export interface SettledUsageReceipt {
  settled: boolean
  pendingCalls: number
  receipt: AnalystUsageReceipt
}

/** Wait a bounded time for late provider receipts, then take one immutable snapshot. */
export async function settleUsageReceiptFromCostLedger(
  ledger: CostLedgerHandle,
  options: CostLedgerFilter & { timeoutMs?: number } = {},
): Promise<SettledUsageReceipt> {
  const { timeoutMs: requestedTimeoutMs, ...requestedFilter } = options
  const filter: CostLedgerFilter = {
    channel: requestedFilter.channel ?? 'analyst',
    ...(requestedFilter.phase === undefined ? {} : { phase: requestedFilter.phase }),
    ...(requestedFilter.tags === undefined ? {} : { tags: requestedFilter.tags }),
  }
  const timeoutMs = validateUsageSettlementTimeout(requestedTimeoutMs)
  const initial = ledger.summary(filter)
  const waitResult =
    initial.pendingCalls === 0
      ? true
      : ledger.waitForIdle
        ? await ledger.waitForIdle({ timeoutMs })
        : false
  const pendingCalls = ledger.summary(filter).pendingCalls
  return {
    settled: waitResult && pendingCalls === 0,
    pendingCalls,
    receipt: usageReceiptFromCostLedger(ledger, filter),
  }
}

export function validateUsageSettlementTimeout(timeoutMs?: number): number {
  const resolved = timeoutMs ?? DEFAULT_USAGE_SETTLEMENT_TIMEOUT_MS
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 2_147_483_647) {
    throw new TypeError(
      'settlementTimeoutMs must be a non-negative safe integer no greater than 2147483647',
    )
  }
  return resolved
}

export function assertValidAnalystUsageReceipt(
  receipt: AnalystUsageReceipt,
  context = 'AnalystContext.recordUsage',
): void {
  if (receipt.calls !== null && (!Number.isSafeInteger(receipt.calls) || receipt.calls < 0)) {
    throw new Error(`${context}: calls must be a non-negative safe integer or null`)
  }
  if (receipt.tokens) {
    assertNonNegativeSafeInteger(receipt.tokens.input, 'tokens.input', context)
    assertNonNegativeSafeInteger(receipt.tokens.output, 'tokens.output', context)
    if (receipt.tokens.reasoning !== undefined) {
      assertNonNegativeSafeInteger(receipt.tokens.reasoning, 'tokens.reasoning', context)
      if (receipt.tokens.reasoning > receipt.tokens.output) {
        throw new Error(`${context}: tokens.reasoning must not exceed tokens.output`)
      }
    }
    if (receipt.tokens.cached !== undefined) {
      assertNonNegativeSafeInteger(receipt.tokens.cached, 'tokens.cached', context)
    }
    if (receipt.tokens.cacheWrite !== undefined) {
      assertNonNegativeSafeInteger(receipt.tokens.cacheWrite, 'tokens.cacheWrite', context)
    }
  }
  if (receipt.cost.kind !== 'uncaptured') {
    assertNonNegativeFinite(receipt.cost.usd, 'cost.usd', context)
  } else if (receipt.cost.usd !== null) {
    throw new Error(`${context}: uncaptured cost.usd must be null`)
  }
  if (receipt.knownCostUsd !== undefined) {
    assertNonNegativeFinite(receipt.knownCostUsd, 'knownCostUsd', context)
  }
}

function assertNonNegativeSafeInteger(value: number, field: string, context: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context}: ${field} must be a non-negative safe integer`)
  }
}

function assertNonNegativeFinite(value: number, field: string, context: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${context}: ${field} must be a non-negative finite number`)
  }
}
