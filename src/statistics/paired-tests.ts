/**
 * Paired significance tests on continuous scores: the paired t-test, the
 * promotion-gate paired bootstrap, the exact sign test, and the package-wide
 * paired-delta decision statistic.
 */

import { ValidationError } from '../errors'
import { studentTCdf } from '../math/student-t'
import { assertFiniteSample, binomialHalfUpperTail, makeRng, medianInPlace } from './internal'

export interface PairedTTestResult {
  /** Null when the statistic is undefined — see {@link pairedTTest}. */
  t: number | null
  df: number
  /** Null exactly when `t` is null. */
  p: number | null
}

/**
 * Paired t-test — before/after measurements on the SAME items.
 * Pairing removes inter-item variance, giving tighter significance than
 * an unpaired test when comparing prompt v1 vs prompt v2 on identical
 * scenarios.
 *
 * Returns `t = p = null` where the statistic is undefined: fewer than two
 * pairs, or a non-zero constant delta whose observed variance is zero. A
 * constant shift carries no information about the variance it would have to
 * be compared against, so the honest answer is "undefined", not `p = 0` —
 * three observations cannot buy absolute certainty. This is the same contract
 * {@link pairedCohensDz} states for the same condition. An all-zero delta is
 * different: it is a measured null, and returns `t = 0, p = 1`.
 */
export function pairedTTest(before: number[], after: number[]): PairedTTestResult {
  if (before.length !== after.length) {
    throw new ValidationError(
      `pairedTTest: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  assertFiniteSample('pairedTTest', 'before', before)
  assertFiniteSample('pairedTTest', 'after', after)
  const n = before.length
  if (n < 2) return { t: null, df: 0, p: null }

  const diffs = before.map((b, i) => after[i]! - b)
  const mean = diffs.reduce((a, b) => a + b, 0) / n
  const variance = diffs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / (n - 1)
  const se = Math.sqrt(variance / n)
  if (se === 0) {
    return mean === 0 ? { t: 0, df: n - 1, p: 1 } : { t: null, df: n - 1, p: null }
  }

  const t = mean / se
  const df = n - 1
  const p = 2 * (1 - studentTCdf(Math.abs(t), df))
  return { t, df, p }
}

// ── Paired bootstrap (promotion-gate effect size) ────────────────────

export interface PairedBootstrapResult {
  /** Number of paired observations. */
  n: number
  /** Median of paired deltas (after − before). */
  median: number
  /** Mean of paired deltas. */
  mean: number
  /** Lower bound of the bootstrap CI on the chosen statistic. */
  low: number
  /** Upper bound of the bootstrap CI on the chosen statistic. */
  high: number
  /** Confidence level used (e.g. 0.95). */
  confidence: number
  /** Number of bootstrap resamples used. */
  resamples: number
  /** False below {@link BOOTSTRAP_GATE_MIN_N}. See {@link pairedBootstrap}. */
  gateEligible: boolean
}

/**
 * Pairs below which a percentile bootstrap interval is descriptive spread only.
 *
 * `P(low > 0)` under a true null, against a nominal 2.5 %, measured over 4000
 * seeded trials: 13.53 % at n = 3, 3.52 % at n = 10, 3.10 % at n = 20 on the
 * median; 13.85 %, 4.90 %, 3.80 % on the mean. This is intrinsic to resampling
 * three points, not an implementation error — scipy's BCa gives 16.0 % on the
 * same n = 3 data — so no change to the estimator moves it. Below this floor
 * the decision belongs to the exact sign test or exact signed-rank test.
 */
export const BOOTSTRAP_GATE_MIN_N = 20

export interface PairedBootstrapOptions {
  /** Confidence level. Default 0.95. */
  confidence?: number
  /** Bootstrap resample count. Default 2000. */
  resamples?: number
  /** Statistic to bootstrap. Default 'median'. */
  statistic?: 'median' | 'mean'
  /** Deterministic seed. If omitted, derived from the deltas so the interval
   *  is reproducible regardless. */
  seed?: number
}

/**
 * Paired bootstrap on (after − before) deltas. Returns a CI on the chosen
 * statistic (median by default); pairs are resampled with replacement. Throws
 * on unequal sample sizes.
 *
 * `low > threshold` carries the stated confidence ONLY at `n ≥
 * {@link BOOTSTRAP_GATE_MIN_N}`, which `gateEligible` reports. Below it the
 * check fires under a true null several times more often than nominal, so the
 * interval is descriptive spread and a promotion must not turn on it.
 */
export function pairedBootstrap(
  before: number[],
  after: number[],
  opts: PairedBootstrapOptions = {},
): PairedBootstrapResult {
  if (before.length !== after.length) {
    throw new Error(`pairedBootstrap: unequal sample sizes (${before.length} vs ${after.length})`)
  }
  const confidence = opts.confidence ?? 0.95
  const resamples = opts.resamples ?? 2000
  const statistic = opts.statistic ?? 'median'
  if (confidence <= 0 || confidence >= 1) {
    throw new Error(`pairedBootstrap: confidence must be in (0,1), got ${confidence}`)
  }

  const n = before.length
  const deltas = before.map((b, i) => after[i]! - b)
  const gateEligible = n >= BOOTSTRAP_GATE_MIN_N
  if (n === 0) {
    return { n: 0, median: 0, mean: 0, low: 0, high: 0, confidence, resamples, gateEligible }
  }
  if (n === 1) {
    const d = deltas[0]!
    return { n: 1, median: d, mean: d, low: d, high: d, confidence, resamples, gateEligible }
  }

  const rng = makeRng(opts.seed, deltas)
  const samples = new Array<number>(resamples)
  for (let b = 0; b < resamples; b++) {
    if (statistic === 'mean') {
      let sum = 0
      for (let k = 0; k < n; k++) {
        sum += deltas[Math.floor(rng() * n)]!
      }
      samples[b] = sum / n
    } else {
      const acc = new Array<number>(n)
      for (let k = 0; k < n; k++) {
        acc[k] = deltas[Math.floor(rng() * n)]!
      }
      samples[b] = medianInPlace(acc)
    }
  }
  samples.sort((a, b) => a - b)

  const alpha = 1 - confidence
  const lowIdx = Math.floor((alpha / 2) * resamples)
  const highIdx = Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1)

  return {
    n,
    median: medianInPlace([...deltas]),
    mean: deltas.reduce((s, x) => s + x, 0) / n,
    low: samples[lowIdx]!,
    high: samples[Math.max(highIdx, lowIdx)]!,
    confidence,
    resamples,
    gateEligible,
  }
}

/** Pre-registered direction for a one-sided paired sign test. */
export type SignTestAlternative = 'greater' | 'less'

/** Exact one-sided sign-test result for paired numeric differences. */
export interface PairedSignTestResult {
  /** Total supplied differences, including zero ties. */
  n: number
  /** Strictly positive differences. */
  positive: number
  /** Strictly negative differences. */
  negative: number
  /** Zero differences excluded from the binomial test. */
  ties: number
  /** Non-zero differences used by the binomial test. */
  nNonTies: number
  /** Direction of the pre-registered alternative hypothesis. */
  alternative: SignTestAlternative
  /** Exact one-sided p-value under P(positive) = P(negative) = 0.5. */
  pValue: number
}

/**
 * Exact one-sided sign test over paired differences.
 *
 * Pass `after[i] - before[i]` for each matched item. `alternative = 'greater'`
 * tests whether positive signs are more likely than negative signs and returns
 * `P(Binomial(nNonTies, 0.5) >= positive)`. `alternative = 'less'` treats
 * negative signs as successes instead. With a continuous difference
 * distribution this is the usual directional median test. Exact zero
 * differences are ties and do not enter the binomial denominator. All-tie and
 * empty inputs return p = 1. Every input difference must be finite, and the
 * direction must be chosen explicitly so a caller cannot select it after
 * seeing the signs.
 */
export function pairedSignTest(
  differences: readonly number[],
  alternative: SignTestAlternative,
): PairedSignTestResult {
  if (alternative !== 'greater' && alternative !== 'less') {
    throw new ValidationError(
      `pairedSignTest: alternative must be 'greater' or 'less', got ${alternative}`,
    )
  }

  let positive = 0
  let negative = 0
  let ties = 0
  for (let i = 0; i < differences.length; i++) {
    const difference = differences[i]!
    if (!Number.isFinite(difference)) {
      throw new ValidationError(
        `pairedSignTest: difference at index ${i} must be finite, got ${difference}`,
      )
    }
    if (difference > 0) positive++
    else if (difference < 0) negative++
    else ties++
  }

  const nNonTies = positive + negative
  const successes = alternative === 'greater' ? positive : negative
  return {
    n: differences.length,
    positive,
    negative,
    ties,
    nNonTies,
    alternative,
    pValue: binomialHalfUpperTail(successes, nNonTies),
  }
}

/** Fraction of paired observations whose delta is an exact tie (|after − before|
 *  < 1e-9). Throws on unequal sample sizes; 0 pairs ⇒ 0. */
export function pairedDeltaTieFraction(
  before: ArrayLike<number>,
  after: ArrayLike<number>,
): number {
  if (before.length !== after.length) {
    throw new Error(
      `pairedDeltaTieFraction: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  const n = before.length
  if (n === 0) return 0
  let ties = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(after[i]! - before[i]!) < 1e-9) ties++
  }
  return ties / n
}

/**
 * The paired-delta statistic a DECISION is computed on, package-wide.
 *
 * The mean paired delta is the estimator that answers the question a promotion
 * gate asks — "by how much did the candidate move the score" — in the caller's
 * own units, and it equals the aggregate lift everyone quotes. The MEDIAN
 * answers a different question and loses the answer to this one in every regime
 * eval data actually lands in:
 *   - TWO-POINT (pass/fail) outcomes on any encoding: the delta vector lives in
 *     {−s, 0, +s} dominated by zeros, so the median and its whole bootstrap CI
 *     are pinned at exactly 0 however large the shift. (Decide these on
 *     {@link pairedRiskDifferenceExact} instead — same estimand, exact interval.)
 *   - TIE-DOMINATED outcomes: at half the pairs tied the sample median is 0 by
 *     construction, and `ci.low > threshold` then answers "no" forever at a
 *     non-negative threshold and "yes" forever at a negative one.
 *   - LOW-CARDINALITY outcomes, even well below half ties: judge dimensions on
 *     integer 0-100, and block scores like {⅔, 1} from averaging pass/fail
 *     leaves, put the median on a coarse lattice whose bootstrap percentiles
 *     land on atoms. Measured: 26 blocks of 3 pass/fail leaves carrying a real
 *     +12.8pp lift, only 23% of pairs tied, gives a median CI of [0, 0.333] —
 *     lower bound exactly 0, so a gate at threshold 0 refuses a real lift.
 * That last case is why there is no tie-fraction threshold here: any cutoff on
 * ties leaves the lattice case open on the other side of it.
 *
 * `heldoutSignificance` has defaulted to the mean since #316 for the same
 * reason. The median remains available per call site for callers who
 * specifically want outlier robustness and accept the blindness.
 */
export const DECISION_PAIRED_DELTA_STATISTIC: 'mean' = 'mean'
