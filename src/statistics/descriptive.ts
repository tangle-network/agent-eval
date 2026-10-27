/**
 * Descriptive statistics: means, bootstrap spread, correlation, and the
 * weighted judge-dimension composite. Nothing here is a significance test.
 */

import { ValidationError } from '../errors'
import { studentTQuantile } from '../math/student-t'
import { assertFiniteSample, makeRng } from './internal'
import { mean } from './mean'

/** Weighted mean — falls back to uniform weights when omitted */
export function weightedMean(scores: { score: number; weight?: number }[]): number {
  if (scores.length === 0) return 0
  let totalWeight = 0
  let weightedSum = 0
  for (const { score, weight } of scores) {
    const w = weight ?? 1
    weightedSum += score * w
    totalWeight += w
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0
}

/**
 * Percentile bootstrap confidence interval on the mean of `scores`.
 *
 * Descriptive spread. It is not a significance test, and at small n its bounds
 * are anti-conservative in the same way {@link pairedBootstrap}'s are — see
 * {@link BOOTSTRAP_GATE_MIN_N}. With no `seed` the resampling is seeded from
 * the scores themselves, so the interval is reproducible either way.
 */
export function confidenceInterval(
  scores: number[],
  confidence = 0.95,
  opts: { seed?: number; resamples?: number } = {},
): { mean: number; lower: number; upper: number } {
  if (scores.length === 0) return { mean: 0, lower: 0, upper: 0 }
  if (scores.length === 1) return { mean: scores[0]!, lower: scores[0]!, upper: scores[0]! }

  const n = scores.length
  const mean = scores.reduce((a, b) => a + b, 0) / n

  const B = opts.resamples ?? 1000
  const rng = makeRng(opts.seed, scores)
  const bootstrapMeans: number[] = []

  for (let i = 0; i < B; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) {
      sum += scores[Math.floor(rng() * n)]!
    }
    bootstrapMeans.push(sum / n)
  }

  bootstrapMeans.sort((a, b) => a - b)

  const alpha = 1 - confidence
  const lowerIdx = Math.floor((alpha / 2) * B)
  const upperIdx = Math.floor((1 - alpha / 2) * B) - 1

  return {
    mean,
    lower: bootstrapMeans[lowerIdx]!,
    upper: bootstrapMeans[Math.min(upperIdx, B - 1)]!,
  }
}

/**
 * Two-sided Student-t critical value: the `t` with `P(|T| ≤ t) = confidence`
 * for `df` degrees of freedom. Exact, from {@link studentTQuantile}, so any
 * confidence in (0, 1) and fractional `df` are supported.
 */
export function studentTCritical(df: number, confidence = 0.95): number {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new ValidationError(`studentTCritical: confidence must be in (0, 1), got ${confidence}`)
  }
  if (!Number.isFinite(df) || df <= 0) {
    throw new ValidationError(`studentTCritical: df must be positive and finite, got ${df}`)
  }
  return studentTQuantile(1 - (1 - confidence) / 2, df)
}

/** One-sample Student-t interval on the mean; see {@link meanConfidenceInterval}. */
export interface MeanConfidenceInterval {
  readonly n: number
  /** Null for an empty sample. */
  readonly mean: number | null
  /** Sample standard deviation (n − 1 denominator); null below two samples. */
  readonly stdev: number | null
  readonly low: number | null
  readonly high: number | null
  /** Two-sided Student-t critical value for df = n − 1; null below two samples. */
  readonly criticalValue: number | null
}

/**
 * Student-t confidence interval on the mean of one sample:
 * `mean ± t(df = n − 1) · s / √n`. Below two samples there is no spread to
 * estimate, so the bounds are null rather than a zero-width interval that
 * would read as certainty. Unlike {@link confidenceInterval} (a percentile
 * bootstrap), the width keeps the small-n t penalty that z = 1.96 drops.
 */
export function meanConfidenceInterval(
  samples: readonly number[],
  confidence = 0.95,
): MeanConfidenceInterval {
  assertFiniteSample('meanConfidenceInterval', 'samples', samples)
  const n = samples.length
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new ValidationError(
      `meanConfidenceInterval: confidence must be in (0, 1), got ${confidence}`,
    )
  }
  if (n < 2) {
    return {
      n,
      mean: n === 0 ? null : samples[0]!,
      stdev: null,
      low: null,
      high: null,
      criticalValue: null,
    }
  }
  const center = mean(samples)
  const sumSquares = samples.reduce((sum, value) => sum + (value - center) ** 2, 0)
  const stdev = Math.sqrt(sumSquares / (n - 1))
  const criticalValue = studentTCritical(n - 1, confidence)
  const halfWidth = (criticalValue * stdev) / Math.sqrt(n)
  return {
    n,
    mean: center,
    stdev,
    low: center - halfWidth,
    high: center + halfWidth,
    criticalValue,
  }
}

/** Partial credit: returns 0-1 ratio of current toward target */
export function partialCredit(current: number, target: number): number {
  if (target <= 0) return 1
  return Math.min(1, Math.max(0, current / target))
}

/** Distribution summary of a number series: count, extremes, quantiles, sum. */
export interface SeriesDistribution {
  readonly n: number
  readonly min: number
  readonly p50: number
  readonly p90: number
  readonly max: number
  readonly sum: number
  readonly percentiles?: Readonly<Record<number, number>>
  readonly medianInterval?: {
    readonly method: 'normal-order-statistics'
    readonly criticalValue: number
    readonly sampleSize: number
    readonly lowRank: number
    readonly highRank: number
    readonly low: number
    readonly high: number
  }
}

export interface SeriesDistributionOptions {
  /** Nearest-rank percentiles on a 0–100 scale, including fractional tails. */
  percentiles?: readonly number[]
  /** Descriptive median rank band, not a bootstrap interval or promotion test. */
  medianInterval?: { criticalValue: number }
}

/**
 * Fold a number series into its distribution summary. Quantiles use the
 * nearest-rank definition — the `ceil(q·n)`-th order statistic — so every
 * reported quantile is a value from the series. Returns `null` for an empty
 * series: an empty series has no distribution, and a zero-filled summary
 * would read as a measured all-zero series.
 */
export function summarizeNumberSeries(
  values: readonly number[],
  options?: SeriesDistributionOptions,
): SeriesDistribution | null {
  const criticalValue = options?.medianInterval?.criticalValue
  if (options) {
    assertFiniteSample('summarizeNumberSeries', 'values', values)
    for (const percentile of options.percentiles ?? []) {
      if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
        throw new ValidationError(
          'summarizeNumberSeries: percentiles must be finite and between 0 and 100',
        )
      }
    }
    if (
      options.medianInterval &&
      (criticalValue === undefined || !Number.isFinite(criticalValue) || criticalValue < 0)
    ) {
      throw new ValidationError(
        'summarizeNumberSeries: median criticalValue must be finite and nonnegative',
      )
    }
  }
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const rank = (q: number): number =>
    sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))] as number
  const sum = sorted.reduce((a, b) => a + b, 0)
  if (options && !Number.isFinite(sum)) {
    throw new ValidationError('summarizeNumberSeries: sample sum exceeded finite range')
  }
  const spread = criticalValue === undefined ? undefined : (criticalValue / 2) * Math.sqrt(n)
  const lowRank = spread === undefined ? 1 : Math.max(1, Math.floor(n / 2 - spread))
  const highRank = spread === undefined ? n : Math.min(n, Math.ceil(n / 2 + 1 + spread))
  return {
    n,
    min: sorted[0] as number,
    p50: rank(0.5),
    p90: rank(0.9),
    max: sorted[sorted.length - 1] as number,
    sum,
    ...(options?.percentiles === undefined
      ? {}
      : {
          percentiles: Object.fromEntries(
            options.percentiles.map((percentile) => [percentile, rank(percentile / 100)]),
          ),
        }),
    ...(criticalValue === undefined
      ? {}
      : {
          medianInterval: {
            method: 'normal-order-statistics' as const,
            criticalValue,
            sampleSize: n,
            lowRank,
            highRank,
            low: sorted[lowRank - 1] as number,
            high: sorted[highRank - 1] as number,
          },
        }),
  }
}

// ── Correlation (Pearson / Spearman) ─────────────────────────────────
//
// The single source for linear (Pearson) and rank (Spearman) correlation.
// Edge-case contract is explicit so every caller agrees on what a
// degenerate input means:
//   - length mismatch or n < 2  → NaN   (correlation is undefined; not 0)
//   - both series constant      → 1     (degenerate perfect agreement)
//   - exactly one series constant → 0   (no covariation to detect)
// Returning NaN for n < 2 (rather than 0) keeps "not enough data" distinct
// from "measured zero correlation", which a 0 would silently conflate.

/**
 * Average-rank-with-ties transform (1-indexed). Tied values receive the mean
 * of the ranks they span, the standard correction for Spearman's ρ.
 */
export function ranks(xs: number[]): number[] {
  const indexed = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const r = new Array<number>(xs.length)
  let i = 0
  while (i < indexed.length) {
    let j = i
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) r[indexed[k]!.i] = avg
    i = j + 1
  }
  return r
}

/**
 * Pearson product-moment correlation coefficient r ∈ [-1, 1] between two
 * equal-length series. See the edge-case contract above: NaN for n < 2 or
 * unequal lengths, 1 when both series are constant, 0 when exactly one is.
 */
export function pearsonR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return Number.NaN
  const n = a.length
  const meanA = a.reduce((s, v) => s + v, 0) / n
  const meanB = b.reduce((s, v) => s + v, 0) / n
  let num = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA
    const db = b[i]! - meanB
    num += da * db
    varA += da * da
    varB += db * db
  }
  if (varA === 0 || varB === 0) return varA === 0 && varB === 0 ? 1 : 0
  return num / Math.sqrt(varA * varB)
}

/**
 * Spearman's rank correlation ρ — Pearson over the average-rank-with-ties
 * transform of each series. Same edge-case contract as {@link pearsonR}.
 */
export function spearmanR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return Number.NaN
  return pearsonR(ranks(a), ranks(b))
}

export interface WeightedCompositeInput {
  /** Per-dimension scores (typically 0..1). */
  dims: Record<string, number>
  /** Weight per dimension. Every weighted dimension MUST be present in
   *  `dims` — a weight for an absent dimension is a config error and throws,
   *  because silently dropping it would renormalise the composite onto a
   *  different denominator than intended. */
  weights: Record<string, number>
  /** Optional pass threshold; when set, the result reports `pass`. */
  threshold?: number
}

export interface WeightedCompositeResult {
  composite: number
  pass?: boolean
}

/**
 * Weighted composite over judge dimensions: `Σ(score_d · w_d) / Σ(w_d)` across
 * the weighted dimensions. The canonical replacement for the per-consumer
 * hand-rolled composite math (tax/legal/creative/gtm each ship a copy).
 *
 * Fail-loud: throws if a weighted dimension is missing from `dims`, if any
 * weight is negative, or if the weights sum to 0 — none of which can produce
 * a meaningful composite.
 */
export function weightedComposite(input: WeightedCompositeInput): WeightedCompositeResult {
  const entries = Object.entries(input.weights)
  if (entries.length === 0) {
    throw new Error('weightedComposite: `weights` is empty — nothing to combine')
  }
  let weightedSum = 0
  let weightTotal = 0
  for (const [dim, weight] of entries) {
    if (weight < 0) {
      throw new Error(`weightedComposite: weight for '${dim}' is negative (${weight})`)
    }
    if (!(dim in input.dims)) {
      throw new Error(
        `weightedComposite: weighted dimension '${dim}' is absent from \`dims\` — ` +
          'refusing to renormalise onto a different denominator',
      )
    }
    weightedSum += input.dims[dim]! * weight
    weightTotal += weight
  }
  if (weightTotal === 0) {
    throw new Error('weightedComposite: weights sum to 0 — composite is undefined')
  }
  const composite = weightedSum / weightTotal
  return input.threshold === undefined
    ? { composite }
    : { composite, pass: composite >= input.threshold }
}
