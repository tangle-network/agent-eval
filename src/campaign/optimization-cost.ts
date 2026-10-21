import type {
  CostLedgerHandle,
  CostLedgerSummary,
  CostProvenance,
  CostReceipt,
} from '../cost-ledger'

/** Cost reported by a method or by final test scoring. */
export interface ComparisonCost {
  /** Known subtotal. Consult `costProvenance` before treating this as total spend. */
  totalCostUsd: number
  /** Exact origin of the total; uncaptured means `totalCostUsd` is only a known subtotal. */
  costProvenance: CostProvenance
  accountingComplete: boolean
  incompleteReasons: string[]
}

/** Attribute method calls while retaining the shared account's admission and read behavior. */
export function createMethodCostScope(account: CostLedgerHandle, methodName: string) {
  const tags = { [`optimizationAttempt:${crypto.randomUUID()}`]: methodName }
  const ledger: CostLedgerHandle = Object.freeze({
    costCeilingUsd: account.costCeilingUsd,
    runPaidCall: (input) => account.runPaidCall({ ...input, tags: { ...input.tags, ...tags } }),
    summary: account.summary.bind(account),
    list: account.list.bind(account),
    reconcile: account.reconcile.bind(account),
    markCompleted: account.markCompleted.bind(account),
    costPerCompletedTask: account.costPerCompletedTask.bind(account),
    ...(account.listPending ? { listPending: account.listPending.bind(account) } : {}),
    ...(account.waitForIdle ? { waitForIdle: account.waitForIdle.bind(account) } : {}),
  })
  return {
    ledger,
    reconcile(reported: ComparisonCost): ComparisonCost {
      const summary = account.summary({ tags })
      if (summary.pendingCalls > 0) {
        throw new Error(
          `optimization method '${methodName}' returned with ${summary.pendingCalls} pending paid call(s)`,
        )
      }
      const recorded = costFromLedgerSummary(summary)
      const totalCostUsd = Math.max(reported.totalCostUsd, recorded.totalCostUsd)
      const roundingToleranceUsd =
        Number.EPSILON * Math.max(1, totalCostUsd) * (summary.totalCalls + 1)
      const combined = combineComparisonCosts([
        { label: 'reported', cost: reported },
        { label: 'recorded', cost: recorded },
      ])
      const incompleteReasons = [
        ...reported.incompleteReasons,
        ...recorded.incompleteReasons.map((reason) => `recorded: ${reason}`),
        ...(recorded.totalCostUsd - reported.totalCostUsd > roundingToleranceUsd
          ? [`reported ${reported.totalCostUsd} USD below recorded ${recorded.totalCostUsd} USD`]
          : []),
      ]
      return {
        totalCostUsd,
        costProvenance:
          combined.costProvenance.kind === 'uncaptured'
            ? combined.costProvenance
            : { kind: combined.costProvenance.kind, usd: totalCostUsd },
        accountingComplete: incompleteReasons.length === 0,
        incompleteReasons,
      }
    },
  }
}

/** Keep the cost fields a custom optimization method must report. */
export function costFromLedgerSummary(summary: CostLedgerSummary): ComparisonCost {
  const cost = {
    totalCostUsd: summary.totalCostUsd,
    costProvenance: structuredClone(summary.costProvenance),
    accountingComplete: summary.accountingComplete,
    incompleteReasons: [...summary.incompleteReasons],
  }
  assertComparisonCost(cost, 'cost ledger')
  return cost
}

/** Combine method costs without turning one unknown bill into a known total. */
export function combineComparisonCosts(
  entries: ReadonlyArray<{ label: string; cost: ComparisonCost }>,
): ComparisonCost {
  const totalCostUsd = entries.reduce((total, entry) => total + entry.cost.totalCostUsd, 0)
  const costProvenance: CostProvenance = entries.some(
    (entry) => entry.cost.costProvenance.kind === 'uncaptured',
  )
    ? { kind: 'uncaptured', usd: null }
    : entries.every((entry) => entry.cost.costProvenance.kind === 'observed')
      ? { kind: 'observed', usd: totalCostUsd }
      : { kind: 'estimated', usd: totalCostUsd }
  const cost = {
    totalCostUsd,
    costProvenance,
    accountingComplete: entries.every((entry) => entry.cost.accountingComplete),
    incompleteReasons: entries.flatMap((entry) =>
      entry.cost.incompleteReasons.map((reason) => `${entry.label}: ${reason}`),
    ),
  }
  assertComparisonCost(cost, 'combined cost')
  return cost
}

export function assertComparisonCost(cost: ComparisonCost, label: string): void {
  if (!cost || typeof cost !== 'object') {
    throw new Error(`compareOptimizationMethods: ${label} returned no cost`)
  }
  if (!Number.isFinite(cost.totalCostUsd) || cost.totalCostUsd < 0) {
    throw new Error(`compareOptimizationMethods: ${label} returned an invalid totalCostUsd`)
  }
  const provenance = cost.costProvenance
  if (
    !provenance ||
    typeof provenance !== 'object' ||
    (provenance.kind !== 'observed' &&
      provenance.kind !== 'estimated' &&
      provenance.kind !== 'uncaptured') ||
    (provenance.kind === 'uncaptured'
      ? provenance.usd !== null
      : !Number.isFinite(provenance.usd) || provenance.usd < 0)
  ) {
    throw new Error(`compareOptimizationMethods: ${label} returned invalid costProvenance`)
  }
  if (provenance.kind !== 'uncaptured' && provenance.usd !== cost.totalCostUsd) {
    throw new Error(
      `compareOptimizationMethods: ${label} returned costProvenance inconsistent with totalCostUsd`,
    )
  }
  if (typeof cost.accountingComplete !== 'boolean') {
    throw new Error(`compareOptimizationMethods: ${label} returned invalid accountingComplete`)
  }
  if (
    !Array.isArray(cost.incompleteReasons) ||
    cost.incompleteReasons.some(
      (reason) => typeof reason !== 'string' || reason.trim().length === 0,
    )
  ) {
    throw new Error(`compareOptimizationMethods: ${label} returned invalid incompleteReasons`)
  }
  if (cost.accountingComplete !== (cost.incompleteReasons.length === 0)) {
    throw new Error(
      `compareOptimizationMethods: ${label} returned inconsistent cost completeness and reasons`,
    )
  }
  if (cost.accountingComplete && provenance.kind === 'uncaptured') {
    throw new Error(`compareOptimizationMethods: ${label} cannot mark uncaptured cost as complete`)
  }
}

export interface OptimizationTokenUsage {
  /** All input tokens, including cache reads and cache creation. */
  inputTokens: number
  /** Input tokens served from a provider cache. */
  cachedInputTokens?: number
  /** Input tokens used to create or write a provider cache entry. */
  cacheWriteInputTokens?: number
  outputTokens: number
  /** Reasoning tokens included in `outputTokens`. */
  reasoningTokens?: number
  totalTokens: number
  calls: number
}

/** Preserve every optimizer token class while keeping total input and output explicit. */
export function optimizationTokenUsageFromSummary(
  summary: CostLedgerSummary,
  receipts: readonly CostReceipt[],
): OptimizationTokenUsage | undefined {
  if (!summary.usageComplete) return undefined
  if (receipts.length !== summary.totalCalls) {
    throw new Error('optimization token usage receipt count does not match the cost summary')
  }
  const cachedInputTokens = summary.cachedTokens
  const cacheWriteInputTokens = summary.cacheWriteTokens ?? 0
  const inputTokens = summary.inputTokens + cachedInputTokens + cacheWriteInputTokens
  const cacheReadComplete =
    receipts.length === 0 || receipts.every((receipt) => receipt.cachedTokens !== undefined)
  const cacheWriteComplete =
    receipts.length === 0 || receipts.every((receipt) => receipt.cacheWriteTokens !== undefined)
  const reasoningComplete =
    receipts.length === 0 || receipts.every((receipt) => receipt.reasoningTokens !== undefined)
  return {
    inputTokens,
    ...(cacheReadComplete ? { cachedInputTokens } : {}),
    ...(cacheWriteComplete ? { cacheWriteInputTokens } : {}),
    outputTokens: summary.outputTokens,
    ...(reasoningComplete ? { reasoningTokens: summary.reasoningTokens ?? 0 } : {}),
    totalTokens: inputTokens + summary.outputTokens,
    calls: summary.totalCalls,
  }
}
