import { ValidationError } from '../errors'
import { studentTQuantile } from '../math/student-t'
import { mulberry32 } from './random'

/** One paired difference (treatment minus control) and the cluster it belongs to. */
export interface ClusteredPair {
  cluster: string
  delta: number
}

export interface JackknifeInterval {
  estimate: number | null
  low: number | null
  high: number | null
  clusters: number
}

export interface ClusteredPairedContrast extends JackknifeInterval {
  pairs: number
  /** Cluster sign-flip randomization p-value for a zero mean difference; null below two clusters. */
  pValue: number | null
}

const groupsOf = <T>(items: readonly T[], cluster: (item: T, index: number) => string) => {
  const groups = new Map<string, T[]>()
  items.forEach((item, index) => {
    const key = cluster(item, index)
    if (typeof key !== 'string' || !key) throw new ValidationError('clustered statistics require a string cluster id')
    groups.set(key, [...(groups.get(key) ?? []), item])
  })
  return [...groups.values()]
}

/**
 * Leave-one-cluster-out jackknife: theta +- t_{(1+level)/2, G-1} * sqrt((G-1)/G * sum_g (theta_(g) - mean)^2).
 * Deterministic, so its tails carry no resampling noise; null bounds below two clusters or for a non-finite statistic.
 */
export function clusterJackknife<T>(
  items: readonly T[],
  cluster: (item: T, index: number) => string,
  statistic: (sample: T[]) => number,
  { level = 0.95 }: { level?: number } = {},
): JackknifeInterval {
  if (!(level > 0 && level < 1)) throw new ValidationError('clusterJackknife: level must be in (0,1)')
  const groups = groupsOf(items, cluster)
  const theta = statistic([...items])
  const estimate = Number.isFinite(theta) ? theta : null
  if (groups.length < 2 || estimate === null) return { estimate, low: null, high: null, clusters: groups.length }
  const leave = groups.map((_, g) => statistic(groups.flatMap((rows, h) => (h === g ? [] : rows)))).filter(Number.isFinite)
  const mean = leave.reduce((sum, value) => sum + value, 0) / leave.length
  const g = groups.length
  const half = studentTQuantile((1 + level) / 2, g - 1) * Math.sqrt(((g - 1) / g) * leave.reduce((sum, value) => sum + (value - mean) ** 2, 0))
  return { estimate, low: estimate - half, high: estimate + half, clusters: g }
}

/**
 * Two-sided cluster sign-flip randomization test of a zero mean difference: each cluster's summed difference keeps or
 * flips its sign at random; p = (1 + #|mean*| >= |mean|) / (1 + resamples). Its level is exact when the null distribution
 * of each cluster's sum is symmetric about zero, which a t interval on few clusters of binary pairs is not at small alpha.
 */
export function clusterSignFlipTest(
  pairs: readonly ClusteredPair[],
  { resamples = 4999, seed = 1 }: { resamples?: number; seed?: number } = {},
): number | null {
  if (!Number.isSafeInteger(resamples) || resamples < 1) throw new ValidationError('clusterSignFlipTest: resamples must be a positive integer')
  const sums = groupsOf(pairs, (pair) => pair.cluster).map((rows) => rows.reduce((sum, pair) => sum + pair.delta, 0))
  if (sums.length < 2) return null
  const observed = Math.abs(sums.reduce((sum, value) => sum + value, 0) / pairs.length)
  const rng = mulberry32(seed)
  let extreme = 0
  for (let b = 0; b < resamples; b++) {
    let total = 0
    for (const sum of sums) total += rng() < 0.5 ? -sum : sum
    if (Math.abs(total / pairs.length) >= observed - 1e-12) extreme++
  }
  return (1 + extreme) / (1 + resamples)
}

/** Mean paired difference with its cluster jackknife interval and cluster sign-flip p-value. */
export function clusteredPairedContrast(
  pairs: readonly ClusteredPair[],
  { level = 0.95, resamples, seed }: { level?: number; resamples?: number; seed?: number } = {},
): ClusteredPairedContrast {
  const mean = (sample: ClusteredPair[]) => (sample.length ? sample.reduce((sum, pair) => sum + pair.delta, 0) / sample.length : Number.NaN)
  return { pairs: pairs.length, ...clusterJackknife(pairs, (pair) => pair.cluster, mean, { level }), pValue: clusterSignFlipTest(pairs, { resamples, seed }) }
}

export interface ClusteredBinaryDesign {
  /** Paired units, assigned to clusters round-robin. */
  pairs: number
  clusters: number
  controlRate: number
  /** Intraclass correlation of the success probability within a cluster. */
  icc: number
  alpha: number
  power?: number
}

/**
 * Minimum detectable paired difference in success rate, the fixed point of
 * delta = (t_{1-alpha/2, G-1} + t_{power, G-1}) * sqrt((p(1-p) + (p+delta)(1-p-delta)) * (1 + (m-1) icc) / n),
 * n pairs in G clusters of m = n / G. Conservative: no within-pair correlation, arm-specific cluster effects.
 */
export function clusteredBinaryMde({ pairs, clusters, controlRate, icc, alpha, power = 0.8 }: ClusteredBinaryDesign) {
  if (!(clusters >= 2 && pairs >= clusters)) throw new ValidationError('clusteredBinaryMde: needs at least two clusters and one pair per cluster')
  const design = 1 + (pairs / clusters - 1) * icc
  const z = studentTQuantile(1 - alpha / 2, clusters - 1) + studentTQuantile(power, clusters - 1)
  let delta = z * Math.sqrt((2 * controlRate * (1 - controlRate) * design) / pairs)
  for (let i = 0; i < 50; i++) {
    const p = Math.min(1, controlRate + delta)
    delta = z * Math.sqrt(((controlRate * (1 - controlRate) + p * (1 - p)) * design) / pairs)
  }
  return { designEffect: design, mde: delta, detectable: delta <= 1 - controlRate }
}

/** Paired binary outcomes with arm-specific cluster effects N(0, icc p(1-p)) on the success probability and a planted effect. */
function simulatedPairs({ pairs, clusters, controlRate, icc }: ClusteredBinaryDesign, effect: number, rng: () => number): ClusteredPair[] {
  const normal = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng())
  const sd = Math.sqrt(icc * controlRate * (1 - controlRate))
  const shift = [0, 1].map(() => Array.from({ length: clusters }, () => sd * normal()))
  return Array.from({ length: pairs }, (_, i) => {
    const [control, treatment] = [0, 1].map((arm) => Number(rng() < Math.min(1, Math.max(0, controlRate + (arm ? effect : 0) + shift[arm]![i % clusters]!))))
    return { cluster: `c${i % clusters}`, delta: treatment! - control! }
  })
}

/**
 * Seeded simulation of the cluster sign-flip test on clustered paired binary outcomes: the false-positive rate at effect
 * 0 and the power at `effect`, with Monte Carlo standard errors. Without an effect it measures the test's own detectable
 * effect by bisecting simulated power over [mde, 1.5 mde] on reps/4 draws per step.
 */
export function simulateClusteredBinaryContrast(design: ClusteredBinaryDesign & { reps: number; effect?: number; seed?: number }) {
  const { reps, seed = 1, alpha, power = 0.8 } = design
  const { mde } = clusteredBinaryMde(design)
  const rate = (effect: number, offset: number, n = reps) => {
    let rejected = 0
    for (let rep = 0; rep < n; rep++) {
      const p = clusterSignFlipTest(simulatedPairs(design, effect, mulberry32(seed + offset + rep)))
      if (p !== null && p <= alpha) rejected++
    }
    return { rate: rejected / n, se: Math.sqrt(((rejected / n) * (1 - rejected / n)) / n) }
  }
  let effect = design.effect
  if (effect === undefined) {
    let [low, high] = [mde, 1.5 * mde]
    for (let step = 0; step < 6; step++) {
      const middle = (low + high) / 2
      if (rate(middle, 2_000_003 + step * reps, Math.ceil(reps / 4)).rate >= power) high = middle
      else low = middle
    }
    effect = high
  }
  const falsePositive = rate(0, 0)
  const detected = rate(effect, 1_000_003)
  return { ...design, power, mde, effect, falsePositiveRate: falsePositive.rate, falsePositiveSe: falsePositive.se, simulatedPower: detected.rate, simulatedPowerSe: detected.se }
}
