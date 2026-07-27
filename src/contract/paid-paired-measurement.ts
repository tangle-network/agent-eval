import {
  type CostChannel,
  CostLedger,
  type CostLedgerHandle,
  type CostProvenance,
  type CostReceiptInput,
} from '../cost-ledger'
import { mapPairedConcurrent } from './concurrent-map'

export interface PaidPairedMeasurementResult<T> {
  measurements: Array<{ baseline: T; candidate: T }>
  wallDurationMs: number
  cost: Exclude<CostProvenance, { kind: 'uncaptured' }>
}

export interface RunPaidPairedMeasurementOptions<T> {
  count: number
  maxConcurrency: number
  label: string
  budgetUsd?: number
  costLedger?: CostLedgerHandle
  maximumCostUsd: number
  call: {
    callId: string
    channel: CostChannel
    phase: string
    actor: string
    model: string
    tags?: Record<string, string>
  }
  signal?: AbortSignal
  execute(index: number, arm: 'baseline' | 'candidate', signal: AbortSignal): Promise<T>
  receipt(measurements: Array<{ baseline: T; candidate: T }>): CostReceiptInput
}

/**
 * Reserve the complete signed suite before its first cell starts.
 *
 * The host executor receives each task's signed cap through `execute`; this
 * batch reservation prevents a complete comparison from turning into a partial
 * one after earlier analysis or search has used the remaining budget.
 */
export async function runPaidPairedMeasurement<T>(
  options: RunPaidPairedMeasurementOptions<T>,
): Promise<PaidPairedMeasurementResult<T>> {
  assertNonNegativeFinite(options.maximumCostUsd, 'maximumCostUsd')
  const costLedger = resolveCostLedger(options)
  const startedAt = performance.now()
  const paid = await costLedger.runPaidCall({
    callId: options.call.callId,
    channel: options.call.channel,
    phase: options.call.phase,
    actor: options.call.actor,
    model: options.call.model,
    maximumCharge: { externallyEnforcedMaximumUsd: options.maximumCostUsd },
    ...(options.call.tags ? { tags: options.call.tags } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    execute: async (signal) =>
      await mapPairedConcurrent({
        count: options.count,
        maxConcurrency: options.maxConcurrency,
        label: options.label,
        signal,
        map: options.execute,
      }),
    receipt: options.receipt,
  })
  const wallDurationMs = performance.now() - startedAt
  if (!paid.succeeded) throw paid.error
  if (paid.receipt.costUnknown) {
    throw new Error(`${options.label} did not capture the complete measurement cost`)
  }
  return {
    measurements: paid.value,
    wallDurationMs,
    cost:
      paid.receipt.actualCostUsd === undefined
        ? { kind: 'estimated', usd: paid.receipt.costUsd }
        : { kind: 'observed', usd: paid.receipt.costUsd },
  }
}

function resolveCostLedger(options: RunPaidPairedMeasurementOptions<unknown>): CostLedgerHandle {
  if (options.budgetUsd === undefined) return options.costLedger ?? new CostLedger()
  assertNonNegativeFinite(options.budgetUsd, 'budgetUsd')
  if (!options.costLedger) {
    throw new Error(`${options.label} with a policy budget requires one shared CostLedger`)
  }
  if (options.costLedger.costCeilingUsd !== options.budgetUsd) {
    throw new Error(`${options.label} CostLedger ceiling must equal the frozen policy budget`)
  }
  return options.costLedger
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`)
  }
}
