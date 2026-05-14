/**
 * Power analysis + multiple-comparison correction.
 *
 * Two jobs:
 *   1. Before running: `requiredSampleSize({ effect, alpha, power })`
 *      returns the N per arm needed to detect a given effect size.
 *   2. After running: `benjaminiHochberg(pValues, fdr)` and
 *      `bonferroni(pValues, alpha)` correct for multiple pairwise tests
 *      so pairwise variant comparisons stay statistically honest.
 *
 * Fixes the correctness bug in 0.2's pairwise optimizer which applied
 * alpha directly across n*(n-1)/2 pairwise tests without correction —
 * dramatically inflating false-positive rate when variants ≥ 3.
 */

/**
 * Required N per arm for a two-sample comparison at target effect size,
 * alpha, and power. Uses the normal-approximation formula:
 *
 *   n = 2 * ( (z_{1-α/2} + z_{1-β}) / d )^2
 *
 * where d is Cohen's d. Returns Infinity for effect ≤ 0.
 */
export function requiredSampleSize(opts: {
  effect: number
  alpha?: number
  power?: number
  twoSided?: boolean
}): number {
  const effect = opts.effect
  if (!Number.isFinite(effect) || effect <= 0) return Infinity
  const alpha = opts.alpha ?? 0.05
  const power = opts.power ?? 0.8
  const twoSided = opts.twoSided ?? true
  const zAlpha = zQuantile(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const zBeta = zQuantile(power)
  const n = 2 * ((zAlpha + zBeta) / effect) ** 2
  return Math.ceil(n)
}

/**
 * Minimum detectable paired effect (in standardised units) given a target
 * paired sample size. Closed-form inverse of the paired-t / sign-rank power
 * formula under the normal approximation:
 *
 *   d_min = (z_{1-α/2} + z_β) / sqrt(n_paired)
 *
 * Multiply by `sd(deltas)` to convert to score units. Treat as a lower bound:
 * the Wilcoxon signed-rank test and bootstrap CIs have asymptotic relative
 * efficiency below 1 against the t-test on heavy-tailed distributions, so the
 * true achievable MDE in those regimes is somewhat larger.
 */
export function pairedMde(opts: {
  nPaired: number
  alpha?: number
  power?: number
  twoSided?: boolean
}): number {
  if (!Number.isFinite(opts.nPaired) || opts.nPaired <= 0) return Infinity
  const alpha = opts.alpha ?? 0.05
  const power = opts.power ?? 0.8
  const twoSided = opts.twoSided ?? true
  const zAlpha = zQuantile(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const zBeta = zQuantile(power)
  return (zAlpha + zBeta) / Math.sqrt(opts.nPaired)
}

/** Bonferroni adjustment: multiply every p-value by the number of tests, clamp at 1. */
export function bonferroni(
  pValues: number[],
  alpha = 0.05,
): { adjusted: number[]; significant: boolean[] } {
  const k = pValues.length
  const adjusted = pValues.map((p) => Math.min(1, p * k))
  const significant = adjusted.map((p) => p < alpha)
  return { adjusted, significant }
}

/**
 * Benjamini–Hochberg false discovery rate. Returns adjusted q-values and
 * significance at the target FDR. Properly handles ties and preserves
 * monotonicity of q-values.
 */
export function benjaminiHochberg(
  pValues: number[],
  fdr = 0.05,
): { qValues: number[]; significant: boolean[] } {
  const n = pValues.length
  if (n === 0) return { qValues: [], significant: [] }
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const q = new Array<number>(n)
  // Ranks are 1-based; q_i = p_i * n / rank_i
  let minRight = 1
  for (let k = n - 1; k >= 0; k--) {
    const rank = k + 1
    const entry = indexed[k]!
    const raw = (entry.p * n) / rank
    const bounded = Math.min(minRight, raw)
    minRight = bounded
    q[entry.i] = Math.min(1, bounded)
  }
  const significant = q.map((v) => v < fdr)
  return { qValues: q, significant }
}

/** Standard-normal inverse CDF (Acklam approximation). */
function zQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    if (p === 0) return -Infinity
    if (p === 1) return Infinity
    return NaN
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  let q: number
  let r: number
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    )
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  )
}
