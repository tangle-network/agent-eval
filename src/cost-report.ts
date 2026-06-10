/**
 * Program cost report — a thin projection over `CostLedger.summary()` that
 * adds the per-model rollup the summary lacks, plus `attachCostToReport`, the
 * one way every artifact (capsules, campaign results, diagnose reports) gets
 * its cost stamp.
 *
 * Honesty contract carried through from the ledger: `total.unknownEntries`
 * and `perModel[].unpriced` surface the costUnknown axis — a $0 from an
 * unpriced model is a lower bound, never a measured zero.
 */

import type { ChannelRollup, CostLedger } from './cost-ledger'
import { ValidationError } from './errors'

export interface ModelCostRollup {
  model: string
  usd: number
  entries: number
  /** ≥1 entry for this model was costUnknown — `usd` is a lower bound. An
   *  `actualCostUsd` override clears the flag for that entry (the dollars are
   *  observed, even when the model has no pricing). */
  unpriced: boolean
}

export interface CostReport {
  /** Per-channel breakdown — `CostLedgerSummary.byChannel` verbatim. */
  perChannel: ChannelRollup[]
  total: {
    usd: number
    /** Entries whose cost was unknown — non-zero means `usd` is a lower bound. */
    unknownEntries: number
  }
  /** Per-model spend, sorted by model id. */
  perModel: ModelCostRollup[]
}

/** Project a ledger into the program cost report. Pure — no I/O, no clock. */
export function costReport(ledger: CostLedger): CostReport {
  const summary = ledger.summary()
  const perModel = new Map<string, ModelCostRollup>()
  for (const entry of ledger.list()) {
    const roll = perModel.get(entry.model) ?? {
      model: entry.model,
      usd: 0,
      entries: 0,
      unpriced: false,
    }
    roll.usd += entry.costUsd
    roll.entries += 1
    if (entry.costUnknown) roll.unpriced = true
    perModel.set(entry.model, roll)
  }
  return {
    perChannel: summary.byChannel,
    total: {
      usd: summary.totalCostUsd,
      unknownEntries: summary.byChannel.reduce((sum, c) => sum + c.unpricedCalls, 0),
    },
    perModel: [...perModel.values()].sort((a, b) => a.model.localeCompare(b.model)),
  }
}

/**
 * Stamp a report-shaped object with its cost projection under the `cost` key.
 * Generic so capsules, campaign results, and diagnose reports all stamp the
 * same way. Throws when the report already carries a `cost` key — silently
 * overwriting an existing stamp would corrupt the artifact's provenance.
 */
export function attachCostToReport<R extends object>(
  report: R,
  ledger: CostLedger,
): R & { cost: CostReport } {
  if ('cost' in report) {
    throw new ValidationError(
      "attachCostToReport: report already has a 'cost' key — refusing to overwrite an existing stamp",
    )
  }
  return { ...report, cost: costReport(ledger) }
}
