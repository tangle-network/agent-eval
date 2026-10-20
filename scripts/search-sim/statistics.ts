import { pairedBootstrap, pairedSignTest } from '../../src/statistics/paired-tests'
import { round } from './objective'

export function interval(value: { lower: number; upper: number }): [number, number] {
  return [round(value.lower), round(value.upper)]
}

/** The exact binomial interval, by bisection on the binomial tail. */
export function clopperPearson(successes: number, n: number, confidence: number): [number, number] {
  const alpha = (1 - confidence) / 2
  const cdf = (k: number, p: number): number => {
    // P(X <= k) for X ~ Binomial(n, p), summed in log space.
    let total = 0
    for (let i = 0; i <= k; i++) {
      total += Math.exp(
        logChoose(n, i) +
          (i === 0 ? 0 : i * Math.log(p)) +
          (n - i === 0 ? 0 : (n - i) * Math.log1p(-p)),
      )
    }
    return total
  }
  const solve = (f: (p: number) => number): number => {
    let low = 0
    let high = 1
    for (let step = 0; step < 100; step++) {
      const mid = (low + high) / 2
      if (f(mid) > 0) low = mid
      else high = mid
    }
    return (low + high) / 2
  }
  const lower = successes === 0 ? 0 : solve((p) => (1 - cdf(successes - 1, p) < alpha ? 1 : -1))
  const upper = successes === n ? 1 : solve((p) => (cdf(successes, p) > alpha ? 1 : -1))
  return [round(lower), round(upper)]
}

function logChoose(n: number, k: number): number {
  let total = 0
  for (let i = 1; i <= k; i++) total += Math.log(n - k + i) - Math.log(i)
  return total
}

/** Two-sided exact binomial test of `a` against `b` discordant pairs at p = 1/2. */
export function exactSignTest(a: number, b: number): number {
  const n = a + b
  if (n === 0) return 1
  let tail = 0
  for (let k = 0; k <= Math.min(a, b); k++) tail += Math.exp(logChoose(n, k) - n * Math.LN2)
  return Math.min(1, 2 * tail)
}

/** Paired differences (arm B minus arm A, one per seed) with a mean, a
 * percentile bootstrap interval on the mean (descriptive below 20 pairs) and
 * the exact one-sided sign test that B is better, chosen before the run:
 * `higher` when a larger value is better (quality), `lower` when a smaller
 * one is (cells). */
export function pairedReport(differences: readonly number[], better: 'higher' | 'lower' = 'higher') {
  const zeros = differences.map(() => 0)
  const bootstrap = pairedBootstrap(zeros, [...differences], {
    statistic: 'mean',
    resamples: 4000,
    seed: 1,
  })
  const sign = pairedSignTest(differences, better === 'higher' ? 'greater' : 'less')
  return {
    n: differences.length,
    mean: round(bootstrap.mean),
    bootstrap95: [round(bootstrap.low), round(bootstrap.high)],
    bootstrapGateEligible: bootstrap.gateEligible,
    better: better === 'higher' ? sign.positive : sign.negative,
    same: sign.ties,
    worse: better === 'higher' ? sign.negative : sign.positive,
    signTestP: round(sign.pValue),
    method: `mean of per-seed differences (B minus A); 95% percentile bootstrap on the mean (4000 resamples, seed 1; descriptive below 20 pairs); exact one-sided sign test that B is better (${better} is better), ties excluded`,
  }
}
