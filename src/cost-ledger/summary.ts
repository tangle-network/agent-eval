/** Derive attribution rollups and accounting completeness from one snapshot of ledger records. */
import type {
  ChannelRollup,
  CostBreakdown,
  CostChannel,
  CostLedgerRecord,
  CostLedgerSummary,
  CostProvenance,
  CostReceipt,
  PendingCostCall,
} from './contract'

export function summarizeCostLedger(
  records: readonly CostLedgerRecord[],
  activeCallIds: ReadonlySet<string>,
  lateCallIds: ReadonlySet<string>,
): CostLedgerSummary {
  const pending = records.filter((record): record is PendingCostCall => record.status === 'pending')
  const receipts = records.filter((record): record is CostReceipt => record.status === 'settled')
  const byChannel = new Map<string, ChannelRollup>()
  const unpriced = new Set<string>()
  const incompleteReasons: string[] = pending.map(
    (record) => `call '${record.callId}' for '${record.actor}' is pending`,
  )
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cachedTokens = 0
  let cacheWriteTokens = 0
  let totalCostUsd = 0

  for (const receipt of receipts) {
    inputTokens += receipt.inputTokens
    outputTokens += receipt.outputTokens
    reasoningTokens += receipt.reasoningTokens ?? 0
    cachedTokens += receipt.cachedTokens ?? 0
    cacheWriteTokens += receipt.cacheWriteTokens ?? 0
    totalCostUsd += receipt.costUsd
    if (receipt.costUnknown) {
      unpriced.add(receipt.model)
      incompleteReasons.push(
        receipt.error ?? `cost unknown for '${receipt.actor}' using '${receipt.model}'`,
      )
    }
    if (receipt.usageUnknown) {
      incompleteReasons.push(`token usage unknown for '${receipt.actor}' using '${receipt.model}'`)
    }
    if (receipt.maximumCostUsd !== undefined && receipt.costUsd > receipt.maximumCostUsd) {
      incompleteReasons.push(
        `'${receipt.actor}' charged ${receipt.costUsd}, exceeding its enforced maximum ${receipt.maximumCostUsd}`,
      )
    }
    const rollup = byChannel.get(receipt.channel) ?? emptyRollup(receipt.channel)
    rollup.calls += 1
    rollup.inputTokens += receipt.inputTokens
    rollup.outputTokens += receipt.outputTokens
    rollup.reasoningTokens = (rollup.reasoningTokens ?? 0) + (receipt.reasoningTokens ?? 0)
    rollup.cachedTokens += receipt.cachedTokens ?? 0
    rollup.cacheWriteTokens = (rollup.cacheWriteTokens ?? 0) + (receipt.cacheWriteTokens ?? 0)
    rollup.costUsd += receipt.costUsd
    if (receipt.costUnknown) rollup.unpricedCalls += 1
    if (receipt.usageUnknown) rollup.unknownUsageCalls += 1
    byChannel.set(receipt.channel, rollup)
  }

  return {
    ...(receipts.some((r) => r.costBreakdown)
      ? { costBreakdown: summarizeBreakdown(records) }
      : {}),
    totalCalls: receipts.length,
    pendingCalls: pending.length,
    unresolvedCalls: pending.filter(
      (record) => !activeCallIds.has(record.callId) || lateCallIds.has(record.callId),
    ).length,
    reservedCostUsd: pending.reduce((sum, record) => sum + (record.maximumCostUsd ?? 0), 0),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    cacheWriteTokens,
    totalCostUsd,
    costProvenance:
      pending.length > 0 || receipts.some((receipt) => receipt.costUnknown)
        ? { kind: 'uncaptured', usd: null }
        : receipts.every((receipt) => receipt.actualCostUsd !== undefined)
          ? { kind: 'observed', usd: totalCostUsd }
          : { kind: 'estimated', usd: totalCostUsd },
    byChannel: [...byChannel.values()].sort((a, b) => a.channel.localeCompare(b.channel)),
    unpricedModels: [...unpriced].sort(),
    fullyPriced: unpriced.size === 0,
    usageComplete: pending.length === 0 && receipts.every((receipt) => !receipt.usageUnknown),
    accountingComplete: incompleteReasons.length === 0,
    incompleteReasons: [...new Set(incompleteReasons)],
  }
}

function emptyRollup(channel: CostChannel): ChannelRollup {
  return {
    channel,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    unknownUsageCalls: 0,
  }
}

function summarizeBreakdown(records: readonly CostLedgerRecord[]): CostBreakdown {
  const details = records.map((r) => (r.status === 'settled' ? r.costBreakdown : undefined))
  const money = (key: 'router' | 'sandbox'): CostProvenance => {
    if (details.some((d) => !d || d[key].kind === 'uncaptured'))
      return { kind: 'uncaptured', usd: null }
    const values = details.map((d) => d![key])
    return {
      kind: values.every((v) => v.kind === 'observed') ? 'observed' : 'estimated',
      usd: values.reduce((sum, v) => sum + (v.usd ?? 0), 0),
    }
  }
  return {
    router: money('router'),
    sandbox: money('sandbox'),
    seatCredits: details.some((d) => !d || d.seatCredits.kind === 'uncaptured')
      ? {
          kind: 'uncaptured',
          credits: null,
          reason: 'One or more calls lack captured standard model credits',
        }
      : {
          kind: 'estimated',
          credits: details.reduce((sum, d) => sum + (d!.seatCredits.credits ?? 0), 0),
        },
    sources: structuredClone(details.flatMap((d) => d?.sources ?? [])),
  }
}
