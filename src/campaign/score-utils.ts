/**
 * @experimental
 *
 * Shared campaign-score reductions used by every optimizer preset
 * (`runOptimization`, `runSkillOpt`, `compareDrivers`). ONE definition of
 * "composite of a campaign" and "per-scenario / per-dimension breakdown" so
 * the optimizers cannot drift on how a surface's score is computed.
 */

import type { CampaignResult, Scenario } from './types'

/** Mean composite across a campaign: per cell, the mean of its judges'
 *  composites; then the mean across cells. Cells with no judge scores are
 *  skipped. Empty ⇒ 0. */
export function campaignMeanComposite<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
): number {
  const composites: number[] = []
  for (const cell of campaign.cells) {
    const cellComposites = Object.values(cell.judgeScores).map((s) => s.composite)
    if (cellComposites.length > 0) {
      composites.push(cellComposites.reduce((a, b) => a + b, 0) / cellComposites.length)
    }
  }
  return composites.length === 0 ? 0 : composites.reduce((a, b) => a + b, 0) / composites.length
}

export interface CampaignBreakdown {
  /** Mean score per judge dimension across all cells. */
  dimensions: Record<string, number>
  /** Per-scenario composite (mean over reps + judges). */
  scenarios: Array<{ scenarioId: string; composite: number }>
}

/** Per-candidate evidence a reflective/patch driver grounds its next proposal
 *  on: mean score per judge dimension + per-scenario composite. */
export function campaignBreakdown<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
): CampaignBreakdown {
  const dimSums: Record<string, number> = {}
  const dimCounts: Record<string, number> = {}
  const byScenario = new Map<string, number[]>()
  for (const cell of campaign.cells) {
    const judgeScores = Object.values(cell.judgeScores)
    if (judgeScores.length === 0) continue
    const cellComposite = judgeScores.reduce((a, s) => a + s.composite, 0) / judgeScores.length
    const arr = byScenario.get(cell.scenarioId) ?? []
    arr.push(cellComposite)
    byScenario.set(cell.scenarioId, arr)
    for (const score of judgeScores) {
      for (const [key, value] of Object.entries(score.dimensions)) {
        dimSums[key] = (dimSums[key] ?? 0) + value
        dimCounts[key] = (dimCounts[key] ?? 0) + 1
      }
    }
  }
  const dimensions: Record<string, number> = {}
  for (const key of Object.keys(dimSums)) {
    const count = dimCounts[key] ?? 0
    dimensions[key] = count > 0 ? (dimSums[key] ?? 0) / count : 0
  }
  const scenarios = [...byScenario.entries()].map(([scenarioId, comps]) => ({
    scenarioId,
    composite: comps.reduce((a, b) => a + b, 0) / comps.length,
  }))
  return { dimensions, scenarios }
}
