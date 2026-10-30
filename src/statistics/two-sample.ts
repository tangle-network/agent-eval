import { studentTTwoSidedPValue } from './inference'

/**
 * Two-sample comparison for independent windows (perf gates, A/B arms).
 *
 * One home: the Welch statistic and mean-CI disjointness live here; the
 * p-value comes from ./inference, so no caller keeps a hand-rolled
 * t-critical table. Paired comparisons belong to ./paired-tests; this
 * module is only for independent arms.
 */

export interface SampleLike {
  n: number
  mean?: number
  stddev?: number
  ci95Low?: number
  ci95High?: number
}

export interface TwoSampleEvidence {
  /** Welch t (baseline − candidate); null when either arm has n<2 or no spread. */
  t: number | null
  /** Welch–Satterthwaite df; null with t. */
  df: number | null
  /** Two-sided p; null when t/df are null. */
  pValue: number | null
  /** The arms' 95% mean CIs do not overlap (both bounds present). */
  ciDisjoint: boolean
  /** Reject equal means at alpha: disjoint CIs or p < alpha. */
  significant: boolean
}

/** Welch's t and Satterthwaite df for unequal variances; nulls when unestimable. */
export function welch(
  baseline: SampleLike,
  candidate: SampleLike,
): {
  t: number | null
  df: number | null
} {
  const sdA = baseline.stddev
  const sdB = candidate.stddev
  const meanA = baseline.mean
  const meanB = candidate.mean
  if (
    baseline.n < 2 ||
    candidate.n < 2 ||
    sdA === undefined ||
    sdB === undefined ||
    meanA === undefined ||
    meanB === undefined
  ) {
    return { t: null, df: null }
  }
  const va = sdA ** 2 / baseline.n
  const vb = sdB ** 2 / candidate.n
  const denom = Math.sqrt(va + vb)
  if (denom === 0) return { t: null, df: null }
  const t = (meanA - meanB) / denom
  const df = (va + vb) ** 2 / (va ** 2 / (baseline.n - 1) + vb ** 2 / (candidate.n - 1))
  return { t, df }
}

/** Evidence that two independent windows differ; conservative on thin data. */
export function twoSampleEvidence(
  baseline: SampleLike,
  candidate: SampleLike,
  alpha = 0.05,
): TwoSampleEvidence {
  const { t, df } = welch(baseline, candidate)
  const pValue = t !== null && df !== null ? studentTTwoSidedPValue(t, df) : null
  const ciDisjoint =
    baseline.ci95High !== undefined &&
    baseline.ci95Low !== undefined &&
    candidate.ci95High !== undefined &&
    candidate.ci95Low !== undefined &&
    (baseline.ci95Low > candidate.ci95High || candidate.ci95Low > baseline.ci95High)
  return {
    t,
    df,
    pValue,
    ciDisjoint,
    significant: ciDisjoint || (pValue !== null && pValue < alpha),
  }
}
