/**
 * Cost tracker — token + USD accounting per scenario and per run.
 *
 * Lifted from tax/legal metrics.ts + tangle-router UsageEvent. Every
 * optimizer needs to know "is the quality gain worth the cost delta?",
 * and every dashboard needs dollars-per-completed-task. MODEL_PRICING
 * from metrics.ts stays authoritative for estimate math; this module
 * adds the aggregation + per-scenario roll-up that was duplicated
 * across 4 verticals.
 */

import { estimateCost } from './metrics'

export interface TokenSpec {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  reasoningTokens?: number
}

export interface CostEntry extends TokenSpec {
  scenarioId: string
  model: string
  /** Override estimate with an observed cost (e.g. from provider response). */
  actualCostUsd?: number
  timestamp: number
  /** Free-form tags (variant id, round #, etc.). */
  tags?: Record<string, string>
}

export interface ScenarioCost {
  scenarioId: string
  entries: CostEntry[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedTokens: number
  totalCostUsd: number
  /** Pass flag — set by consumer via markOutcome; used for cost-per-completed-task. */
  completed?: boolean
}

export class CostTracker {
  private byScenario = new Map<string, ScenarioCost>()

  record(entry: Omit<CostEntry, 'timestamp'> & { timestamp?: number }): CostEntry {
    const full: CostEntry = { timestamp: entry.timestamp ?? Date.now(), ...entry }
    assertNonNegative(full.inputTokens, 'inputTokens')
    assertNonNegative(full.outputTokens, 'outputTokens')
    let bucket = this.byScenario.get(full.scenarioId)
    if (!bucket) {
      bucket = {
        scenarioId: full.scenarioId,
        entries: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalCostUsd: 0,
      }
      this.byScenario.set(full.scenarioId, bucket)
    }
    bucket.entries.push(full)
    bucket.totalInputTokens += full.inputTokens
    bucket.totalOutputTokens += full.outputTokens
    bucket.totalCachedTokens += full.cachedTokens ?? 0
    bucket.totalCostUsd += costFor(full)
    return full
  }

  markOutcome(scenarioId: string, completed: boolean): void {
    const bucket = this.byScenario.get(scenarioId)
    if (!bucket) throw new Error(`CostTracker.markOutcome: unknown scenario "${scenarioId}"`)
    bucket.completed = completed
  }

  get(scenarioId: string): ScenarioCost | undefined {
    return this.byScenario.get(scenarioId)
  }

  list(): ScenarioCost[] {
    return [...this.byScenario.values()]
  }

  summary(): CostSummary {
    const scenarios = this.list()
    const completed = scenarios.filter((s) => s.completed === true)
    const totalCost = scenarios.reduce((a, s) => a + s.totalCostUsd, 0)
    const totalInput = scenarios.reduce((a, s) => a + s.totalInputTokens, 0)
    const totalOutput = scenarios.reduce((a, s) => a + s.totalOutputTokens, 0)
    const totalCompletedCost = completed.reduce((a, s) => a + s.totalCostUsd, 0)
    return {
      scenarioCount: scenarios.length,
      completedCount: completed.length,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCostUsd: totalCost,
      avgCostPerScenarioUsd: scenarios.length ? totalCost / scenarios.length : 0,
      costPerCompletedTaskUsd: completed.length ? totalCompletedCost / completed.length : null,
    }
  }
}

export interface CostSummary {
  scenarioCount: number
  completedCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  avgCostPerScenarioUsd: number
  /** Total USD / completed scenarios — null when nothing completed. */
  costPerCompletedTaskUsd: number | null
}

function costFor(entry: CostEntry): number {
  if (typeof entry.actualCostUsd === 'number' && Number.isFinite(entry.actualCostUsd)) {
    return entry.actualCostUsd
  }
  return estimateCost(entry.inputTokens, entry.outputTokens, entry.model)
}

function assertNonNegative(n: number, name: string): void {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`CostTracker: ${name} must be a non-negative finite number, got ${n}`)
  }
}
