/** Observed score distributions, judge agreement, and downstream quality correlation. */

import { continuousAgreement } from '../judge-calibration'
import { interpolatedQuantile as percentile } from '../math/quantile'
import { observedSplitScore } from '../rollout/reward'
import type { RunRecord } from '../run-record'
import { pearsonR, spearmanR } from '../statistics'
import { mean as arithmeticMean, meanOrZero } from '../statistics/mean'
import type {
  InterRaterInsight,
  JudgeInsight,
  OutcomeCorrelationInsight,
  ScalarDistribution,
} from './insight-report'

export function resolveSplit(
  runs: RunRecord[],
  pref: 'search' | 'holdout' | 'auto',
): 'search' | 'holdout' {
  if (pref !== 'auto') return pref
  const hasHoldout = runs.some((r) => Number.isFinite(observedSplitScore(r, 'holdout')))
  return hasHoldout ? 'holdout' : 'search'
}

/**
 * RAW (`observedSplitScore`): `analyzeRuns` describes what a set of runs
 * reported, and every downstream reader of this composite — distributions,
 * per-candidate summaries, the reward-hacking correlation — needs the ungated
 * number to see an inflated run at all.
 */
export function compositeOf(run: RunRecord, split: 'search' | 'holdout'): number {
  // Split-exact, no cross-split fallthrough: answering "what did this run
  // score on the split I am summarising" with the other split's number
  // silently mixes populations.
  const score = observedSplitScore(run, split)
  return Number.isFinite(score) ? (score as number) : Number.NaN
}

export function distributionOf(
  values: number[],
  bins: number,
  withIds?: Array<{ runId: string; score: number }>,
): ScalarDistribution {
  if (values.length === 0) {
    return {
      n: 0,
      mean: null,
      p50: null,
      p95: null,
      stddev: null,
      min: null,
      max: null,
      histogram: [],
    }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = arithmeticMean(sorted)
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)
  const tailRuns = withIds
    ? [...withIds].sort((a, b) => a.score - b.score).slice(0, Math.min(5, withIds.length))
    : undefined
  return {
    n,
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    stddev,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    histogram: histogram(sorted, bins),
    ...(tailRuns ? { tailRuns } : {}),
  }
}

/** Even-width histogram over the value range. Returns inclusive-lo /
 *  exclusive-hi bins (closed on right for the last bin) compatible with
 *  the substrate's `GainDistributionBin` shape. */
function histogram(sorted: number[], bins: number): ScalarDistribution['histogram'] {
  if (sorted.length === 0 || bins < 1) return []
  const min = sorted[0]!
  const max = sorted[sorted.length - 1]!
  if (min === max) return [{ lo: min, hi: max, count: sorted.length }]
  const width = (max - min) / bins
  const out: ScalarDistribution['histogram'] = []
  for (let i = 0; i < bins; i++) {
    const lo = min + i * width
    const hi = i === bins - 1 ? max : lo + width
    out.push({ lo, hi, count: 0 })
  }
  for (const v of sorted) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / width))
    out[idx]!.count++
  }
  return out
}

export function computePerDimension(
  runs: RunRecord[],
  bins: number,
): Record<string, ScalarDistribution> {
  // JudgeScoresRecord pre-aggregates `perDimMean` (mean across judges per
  // dimension). We collect those means across runs to produce a per-dim
  // distribution at the corpus level. Consumers who want per-judge
  // dimension values reach into `perJudge[judgeId][dim]` themselves.
  const byDim = new Map<string, number[]>()
  for (const run of runs) {
    const scores = run.outcome.judgeScores
    if (!scores) continue
    for (const [dim, value] of Object.entries(scores.perDimMean ?? {})) {
      if (!Number.isFinite(value)) continue
      const arr = byDim.get(dim) ?? []
      arr.push(value)
      byDim.set(dim, arr)
    }
  }
  const out: Record<string, ScalarDistribution> = {}
  for (const [dim, values] of byDim) out[dim] = distributionOf(values, bins)
  return out
}

/** Collect per-dimension values across runs (from outcome.judgeScores.perDimMean). */
export function collectPerDimension(runs: RunRecord[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const r of runs) {
    const perDim = r.outcome.judgeScores?.perDimMean
    if (!perDim) continue
    for (const [dim, value] of Object.entries(perDim)) {
      if (!Number.isFinite(value)) continue
      if (!out[dim]) out[dim] = []
      out[dim].push(value as number)
    }
  }
  return out
}

export function computeJudgeInsights(runs: RunRecord[]): Record<string, JudgeInsight> {
  // Each judge's per-run mean is the average of its per-dimension scores
  // for that run. We aggregate those means across all runs each judge
  // scored — giving consumers a "this judge's typical verdict" reading.
  const out: Record<string, JudgeInsight> = {}
  const byJudge = new Map<string, number[]>()
  for (const run of runs) {
    const scores = run.outcome.judgeScores
    if (!scores?.perJudge) continue
    for (const [judgeId, dims] of Object.entries(scores.perJudge)) {
      const dimValues = Object.values(dims).filter(Number.isFinite) as number[]
      if (dimValues.length === 0) continue
      const judgeMean = dimValues.reduce((s, v) => s + v, 0) / dimValues.length
      const arr = byJudge.get(judgeId) ?? []
      arr.push(judgeMean)
      byJudge.set(judgeId, arr)
    }
  }
  for (const [judgeId, values] of byJudge) {
    out[judgeId] = {
      n: values.length,
      meanScore: values.reduce((s, v) => s + v, 0) / values.length,
    }
  }
  return out
}

export function computeInterRater(
  ratings: Array<{ runId: string; rater: string; score: number }>,
): InterRaterInsight | undefined {
  const byRun = new Map<string, Array<{ rater: string; score: number }>>()
  for (const r of ratings) {
    if (!Number.isFinite(r.score)) continue
    const list = byRun.get(r.runId) ?? []
    list.push({ rater: r.rater, score: r.score })
    byRun.set(r.runId, list)
  }
  const raters = new Set(ratings.map((r) => r.rater))
  const jointlyRated: string[] = []
  for (const [runId, ratersForRun] of byRun) {
    const seen = new Set(ratersForRun.map((r) => r.rater))
    let all = true
    for (const r of raters) if (!seen.has(r)) all = false
    if (all) jointlyRated.push(runId)
  }
  if (raters.size < 2 || jointlyRated.length === 0) return undefined

  const raterList = [...raters].sort()
  const perPair: Record<string, number> = {}
  for (let i = 0; i < raterList.length; i++) {
    for (let j = i + 1; j < raterList.length; j++) {
      const a = raterList[i]!
      const b = raterList[j]!
      const aScores: number[] = []
      const bScores: number[] = []
      for (const runId of jointlyRated) {
        const ratersForRun = byRun.get(runId)!
        const sa = ratersForRun.find((r) => r.rater === a)?.score
        const sb = ratersForRun.find((r) => r.rater === b)?.score
        if (sa !== undefined && sb !== undefined) {
          aScores.push(sa)
          bScores.push(sb)
        }
      }
      const agreement = continuousAgreement(
        aScores.map((score, index) => [score, bScores[index]!]),
        { bootstrap: 0 },
      )
      perPair[`${a}::${b}`] = agreement.weightedKappa
    }
  }
  const matrix = jointlyRated.map((runId) => {
    const ratingsByRater = new Map(byRun.get(runId)!.map((rating) => [rating.rater, rating.score]))
    return raterList.map((rater) => ratingsByRater.get(rater)!)
  })
  const agreement = continuousAgreement(matrix, { bootstrap: 0 })

  const disagreementCases = jointlyRated
    .map((runId) => {
      const ratersForRun = byRun.get(runId)!
      const scores = ratersForRun.map((r) => r.score)
      const range = Math.max(...scores) - Math.min(...scores)
      return { runId, ratings: ratersForRun, range }
    })
    .sort((a, b) => b.range - a.range)
    .slice(0, 20)

  return {
    raters: raters.size,
    jointlyRated: jointlyRated.length,
    kappa: Number.isFinite(agreement.weightedKappa) ? agreement.weightedKappa : 0,
    icc: agreement.icc,
    pearson: agreement.pearson,
    spearman: agreement.spearman,
    perPair,
    disagreementCases,
  }
}

export function computeOutcomeCorrelation(
  runs: RunRecord[],
  outcome: { metric: string; valueByRunId: Record<string, number> },
  split: 'search' | 'holdout',
): OutcomeCorrelationInsight | undefined {
  const xs: number[] = []
  const ys: number[] = []
  for (const run of runs) {
    const y = outcome.valueByRunId[run.runId]
    if (y === undefined || !Number.isFinite(y)) continue
    const x = compositeOf(run, split)
    if (!Number.isFinite(x)) continue
    xs.push(x)
    ys.push(y)
  }
  if (xs.length < 3) return undefined

  const p = pearsonR(xs, ys)
  const s = spearmanR(xs, ys)
  const meanX = meanOrZero(xs)
  const meanY = meanOrZero(ys)
  let num = 0
  let denom = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY)
    denom += (xs[i]! - meanX) ** 2
  }
  const slope = denom === 0 ? 0 : num / denom
  const intercept = meanY - slope * meanX
  const ssTot = ys.reduce((a, y) => a + (y - meanY) ** 2, 0)
  const ssRes = ys.reduce((a, y, i) => a + (y - (intercept + slope * xs[i]!)) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot

  return {
    metric: outcome.metric,
    n: xs.length,
    pearson: p,
    spearman: s,
    rewardModel: { intercept, slope, r2 },
  }
}

export function finiteCompositeScores(
  runs: readonly RunRecord[],
  split: 'search' | 'holdout',
): number[] {
  return runs.map((run) => compositeOf(run, split)).filter(Number.isFinite)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
