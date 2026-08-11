/**
 * Standardized effect sizes: Cohen's d family and Cliff's delta, with the
 * shared degenerate-input contract (null where the effect is undefined).
 */

import { ValidationError } from '../errors'

/**
 * Cohen's d — standardized effect size for two independent groups.
 * Positive d means group b has higher mean than group a.
 * Rule of thumb: |d| < 0.2 negligible, 0.2–0.5 small, 0.5–0.8 medium, > 0.8 large.
 *
 * Returns null where the standardized effect is undefined: fewer than two
 * observations in either group, or a zero pooled standard deviation with
 * unequal means. Null is NOT "no effect" — zero within-group spread across a
 * real mean gap is an unbounded effect, the opposite of negligible. Equal
 * means with zero spread is a genuine 0. Same contract as
 * {@link pairedCohensDz}.
 */
export function cohensD(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null
  const meanA = a.reduce((x, y) => x + y, 0) / a.length
  const meanB = b.reduce((x, y) => x + y, 0) / b.length
  const varA = a.reduce((acc, x) => acc + (x - meanA) ** 2, 0) / (a.length - 1)
  const varB = b.reduce((acc, x) => acc + (x - meanB) ** 2, 0) / (b.length - 1)
  const pooled = Math.sqrt(
    ((a.length - 1) * varA + (b.length - 1) * varB) / (a.length + b.length - 2),
  )
  if (pooled === 0) return meanB === meanA ? 0 : null
  return (meanB - meanA) / pooled
}

/**
 * Cohen's dz for paired observations: mean(after - before) divided by the
 * sample standard deviation of those within-pair deltas.
 *
 * Returns null when fewer than two pairs exist or a non-zero constant delta
 * has zero observed variance. In that case the standardized effect is
 * undefined, not an arbitrarily large finite number.
 */
export function pairedCohensDz(before: number[], after: number[]): number | null {
  if (before.length !== after.length) {
    throw new ValidationError(
      `pairedCohensDz: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  if (before.length < 2) return null
  const deltas = before.map((value, index) => after[index]! - value)
  if (deltas.some((value) => !Number.isFinite(value))) {
    throw new ValidationError('pairedCohensDz: all paired values must be finite')
  }
  const meanDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length
  const variance =
    deltas.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) / (deltas.length - 1)
  const standardDeviation = Math.sqrt(variance)
  const scale = Math.max(1, Math.abs(meanDelta), ...deltas.map(Math.abs))
  if (standardDeviation <= Number.EPSILON * scale) return meanDelta === 0 ? 0 : null
  return meanDelta / standardDeviation
}

export type CliffsMagnitude = 'negligible' | 'small' | 'medium' | 'large'

/**
 * Cliff's delta — a non-parametric effect size for two independent samples.
 * `δ = (#(after > before) − #(after < before)) / (n_before · n_after)`,
 * ranging [-1, 1]. Positive ⇒ `after` tends to exceed `before` (improvement).
 *
 * Distribution-free counterpart to Cohen's d: no normality assumption, robust
 * to the bounded/skewed score distributions judges produce. Pairs with
 * `pairedBootstrap` / `wilcoxonSignedRank` for the non-parametric reporting
 * path. Returns 0 when either sample is empty.
 */
export function cliffsDelta(before: number[], after: number[]): number {
  const n = before.length * after.length
  if (n === 0) return 0
  let dominance = 0
  for (const a of after) {
    for (const b of before) {
      if (a > b) dominance += 1
      else if (a < b) dominance -= 1
    }
  }
  return dominance / n
}

/**
 * Map a Cliff's delta to a qualitative magnitude using the standard
 * Romano et al. thresholds (|δ|): <0.147 negligible, <0.33 small,
 * <0.474 medium, else large.
 */
export function interpretCliffs(delta: number): CliffsMagnitude {
  const d = Math.abs(delta)
  if (d < 0.147) return 'negligible'
  if (d < 0.33) return 'small'
  if (d < 0.474) return 'medium'
  return 'large'
}
