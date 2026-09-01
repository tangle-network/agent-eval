/**
 * Campaign aggregation: per-judge and per-scenario summaries with seeded
 * bootstrap CI95 bands, the order statistics of the same scores, plus the
 * failure-class cell counts.
 *
 * The spread comes from `summarizeNumberSeries`, the package's one
 * distribution summary, so a campaign aggregate and any other series summary
 * in this package report the same fields under the same quantile definition.
 */

import type { CostLedgerSummary } from '../cost-ledger'
import { confidenceInterval, summarizeNumberSeries } from '../statistics'
import { projectCampaignCellQuality } from './run-record'
import type {
  CampaignAggregates,
  CampaignCellResult,
  JudgeAggregate,
  JudgeConfig,
  ScenarioAggregate,
} from './types'

export function computeAggregates<TArtifact>(
  cells: CampaignCellResult<TArtifact>[],
  judges: JudgeConfig<TArtifact>[],
  seed: number,
  cost: CostLedgerSummary,
): CampaignAggregates {
  const cellQuality = cells.map((cell) => ({
    cell,
    quality: projectCampaignCellQuality(cell),
  }))
  const byJudge: Record<string, JudgeAggregate> = {}
  for (const judge of judges) {
    const scores: number[] = []
    for (const { quality } of cellQuality) {
      const s = quality.successfulJudgeScores[judge.name]
      if (s !== undefined) scores.push(s.composite)
    }
    if (scores.length > 0) byJudge[judge.name] = aggregate(scores, seed)
  }
  const byScenario: Record<string, ScenarioAggregate> = {}
  const scenarioGroups = new Map<string, number[]>()
  for (const { cell, quality } of cellQuality) {
    const score = quality.score
    if (score === undefined) continue
    const arr = scenarioGroups.get(cell.scenarioId) ?? []
    arr.push(score)
    scenarioGroups.set(cell.scenarioId, arr)
  }
  for (const [scenarioId, samples] of scenarioGroups) {
    const ag = aggregate(samples, seed)
    byScenario[scenarioId] = {
      meanComposite: ag.mean,
      ci95: ag.ci95,
      n: ag.n,
      distribution: ag.distribution,
    }
  }
  const dispatchFailures = cells.filter((cell) => cell.errorStage === 'dispatch')
  const judgeFailures = cellQuality
    .filter(({ cell, quality }) => cell.errorStage === 'judge' || quality.failedJudges.length > 0)
    .map(({ cell }) => cell)
  const unclassifiedFailures = cells.filter(
    (cell) =>
      Boolean(cell.error) && !cell.error?.startsWith('skipped:') && cell.errorStage === undefined,
  )
  return {
    byJudge,
    byScenario,
    cost,
    cellsExecuted: cells.filter(
      (cell) =>
        !cell.error?.startsWith('skipped:') &&
        cell.errorStage !== 'dispatch' &&
        !(cell.error && cell.errorStage === undefined),
    ).length,
    cellsSkipped: cells.filter((c) => c.error?.startsWith('skipped:')).length,
    cellsCached: cells.filter((c) => c.cached).length,
    cellsFailed: new Set([...dispatchFailures, ...judgeFailures, ...unclassifiedFailures]).size,
    cellsDispatchFailed: dispatchFailures.length,
    cellsJudgeFailed: judgeFailures.length,
    cellsUnclassifiedFailed: unclassifiedFailures.length,
  }
}

// Percentile bootstrap CI95 via seeded resampling. Deterministic for a given
// seed — same campaign re-run produces identical CI bands. Falls back to
// degenerate intervals at n<=1 (the bootstrap is undefined there).
function aggregate(samples: number[], seed: number): JudgeAggregate {
  // `summarizeNumberSeries` returns null for an empty series, which is the one
  // input this function has never accepted. Reading the refusal from the helper
  // keeps one guard instead of two that could drift apart.
  const distribution = summarizeNumberSeries(samples)
  if (distribution === null) throw new Error('aggregate requires at least one finite score')
  const n = distribution.n
  const mean = samples.reduce((a, b) => a + b, 0) / n
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)
  const stdev = Math.sqrt(variance)
  const ci = confidenceInterval(samples, 0.95, { seed, resamples: 1000 })
  return { mean, stdev, ci95: [ci.lower, ci.upper], n, distribution }
}
