/**
 * BudgetBreachView — aggregates breach events across the corpus.
 *
 * Answers: which dimensions get hit most often? Which scenarios are
 * underbudgeted? Which variants trigger the most breaches?
 */

import type { BudgetSpec } from '../trace/schema'
import type { TraceStore } from '../trace/store'

export interface BudgetBreachFinding {
  runId: string
  scenarioId: string
  variantId?: string
  dimension: keyof BudgetSpec
  limit: number
  consumed: number
  excessRatio: number
  timestamp: number
}

export interface BudgetBreachReport {
  findings: BudgetBreachFinding[]
  byDimension: Record<string, number>
  byScenario: Record<string, number>
  byVariant: Record<string, number>
  totalRuns: number
  breachedRunRatio: number
}

export async function budgetBreachView(
  store: TraceStore,
  options: { scenarioId?: string; variantId?: string } = {},
): Promise<BudgetBreachReport> {
  const runs = await store.listRuns({
    scenarioId: options.scenarioId,
    variantId: options.variantId,
  })
  const findings: BudgetBreachFinding[] = []
  const byDimension: Record<string, number> = {}
  const byScenario: Record<string, number> = {}
  const byVariant: Record<string, number> = {}

  for (const run of runs) {
    const entries = await store.budget(run.runId)
    for (const e of entries) {
      if (!e.breached) continue
      const excessRatio = e.limit > 0 ? e.consumed / e.limit : Infinity
      findings.push({
        runId: run.runId,
        scenarioId: run.scenarioId,
        variantId: run.variantId,
        dimension: e.dimension,
        limit: e.limit,
        consumed: e.consumed,
        excessRatio,
        timestamp: e.timestamp,
      })
      byDimension[e.dimension] = (byDimension[e.dimension] ?? 0) + 1
      byScenario[run.scenarioId] = (byScenario[run.scenarioId] ?? 0) + 1
      if (run.variantId) byVariant[run.variantId] = (byVariant[run.variantId] ?? 0) + 1
    }
  }

  const breachedRuns = new Set(findings.map((f) => f.runId))
  return {
    findings,
    byDimension,
    byScenario,
    byVariant,
    totalRuns: runs.length,
    breachedRunRatio: runs.length > 0 ? breachedRuns.size / runs.length : 0,
  }
}
