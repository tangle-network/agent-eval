/** Matched split scores and paired statistical evidence for report consumers. */

import { interpolatedQuantile } from './math/quantile'
import { pairRunRecords } from './paired-arms'
import { observedSplitScore, type ScorePreference } from './rollout/reward'
import type { RunRecord } from './run-record'
import { pairedBootstrap, pairedMde } from './statistics'
import { makeRng } from './statistics/internal'

export function pairScoresByKey(
  candidate: RunRecord[],
  baseline: RunRecord[],
  split: ScorePreference,
): {
  before: number[]
  after: number[]
  unpairedCandidateN: number
  unpairedComparatorN: number
} {
  // RAW, split-exact reads through `observedSplitScore` — the single allowed
  // spelling of the split-score derivation (see rollout/score-derivation-guard).
  const scoreOf = (run: RunRecord): number | undefined => {
    const v = observedSplitScore(run, split)
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const scoredCandidate = candidate.filter((run) => scoreOf(run) !== undefined)
  const scoredBaseline = baseline.filter((run) => scoreOf(run) !== undefined)
  const pairing = pairRunRecords(scoredBaseline, scoredCandidate)
  return {
    before: pairing.pairs.map((pair) => scoreOf(pair.baseline) as number),
    after: pairing.pairs.map((pair) => scoreOf(pair.treatment) as number),
    unpairedCandidateN: pairing.unpairedTreatment.length,
    unpairedComparatorN: pairing.unpairedBaseline.length,
  }
}

/**
 * Internal: paired posterior summary on (candidate − comparator) deltas.
 *
 * Returns the bootstrap CI on the median (matching `gainHistogram`) plus
 * Bayesian-bootstrap posterior summaries Pr(Δ>0) and Pr(Δ∈ROPE) computed
 * from Dirichlet(1, ..., 1) weights on the observed paired deltas
 * (Rubin 1981), and the
 * minimum detectable paired effect at the configured power and α.
 *
 * `null` is returned when no paired observations exist; callers must
 * gate on `n` before consuming the bootstrap statistics.
 */
export function pairedPosterior(
  runs: RunRecord[],
  candidateId: string,
  comparator: string,
  opts: {
    split: 'search' | 'holdout'
    confidence: number
    seed?: number
    rope: { low: number; high: number } | null
    mdePower: number
    mdeAlpha: number
  },
): {
  n: number
  meanDelta: number
  medianDelta: number
  sdDelta: number
  ci: { low: number; high: number }
  prGreaterThanZero: number
  prInRope: number | null
  mde: number
} | null {
  const candidate = runs.filter((r) => r.candidateId === candidateId && r.splitTag === opts.split)
  const baseline = runs.filter((r) => r.candidateId === comparator && r.splitTag === opts.split)
  const { before, after } = pairScoresByKey(candidate, baseline, opts.split)
  const n = before.length
  if (n === 0) return null

  const deltas = before.map((b, i) => after[i]! - b)
  const meanDelta = deltas.reduce((s, x) => s + x, 0) / n
  const sortedDeltas = [...deltas].sort((a, b) => a - b)
  const medianDelta = interpolatedQuantile(sortedDeltas, 0.5)
  const sdDelta = stdev(deltas, meanDelta)

  const ci = pairedBootstrap(before, after, {
    confidence: opts.confidence,
    resamples: 2000,
    statistic: 'median',
    seed: opts.seed,
  })

  const meanSamples = bayesianBootstrapMeanSamples(deltas, 2000, opts.seed)
  const prGreaterThanZero =
    meanSamples.length === 0 ? 0 : meanSamples.filter((s) => s > 0).length / meanSamples.length
  const prInRope =
    opts.rope === null || meanSamples.length === 0
      ? null
      : meanSamples.filter((s) => s >= opts.rope!.low && s <= opts.rope!.high).length /
        meanSamples.length

  const dStandardised = pairedMde({ nPaired: n, alpha: opts.mdeAlpha, power: opts.mdePower })
  const mde = sdDelta === 0 ? 0 : dStandardised * sdDelta

  return {
    n,
    meanDelta,
    medianDelta,
    sdDelta,
    ci: { low: ci.low, high: ci.high },
    prGreaterThanZero,
    prInRope,
    mde,
  }
}

function bayesianBootstrapMeanSamples(
  deltas: number[],
  resamples: number,
  seed?: number,
): number[] {
  const n = deltas.length
  if (n === 0) return []
  if (n === 1) return new Array<number>(resamples).fill(deltas[0]!)
  const rng = makeRng(seed, deltas)
  const samples = new Array<number>(resamples)
  for (let b = 0; b < resamples; b++) {
    let weightedSum = 0
    let weightSum = 0
    for (let k = 0; k < n; k++) {
      const weight = -Math.log(Math.max(Number.MIN_VALUE, rng()))
      weightedSum += deltas[k]! * weight
      weightSum += weight
    }
    samples[b] = weightedSum / weightSum
  }
  return samples
}

function stdev(xs: number[], mean: number): number {
  if (xs.length < 2) return 0
  let sse = 0
  for (const x of xs) sse += (x - mean) ** 2
  return Math.sqrt(sse / (xs.length - 1))
}
