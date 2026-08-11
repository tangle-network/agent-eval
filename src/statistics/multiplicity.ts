/**
 * Multiple-comparison corrections: family-wise error (Bonferroni, Holm) and
 * false discovery rate (Benjamini-Hochberg), with inclusive rejection
 * boundaries throughout.
 */

import { ValidationError } from '../errors'

/**
 * Bonferroni adjustment: multiply every p-value by the test count, clamp at 1.
 *
 * Rejects at `p_adjusted ≤ alpha` — the boundary is inclusive, matching
 * {@link holm}, which uniformly dominates this correction and must therefore
 * never reject less. Validates its inputs on the same terms.
 */
export function bonferroni(
  pValues: readonly number[],
  alpha = 0.05,
): { adjusted: number[]; significant: boolean[] } {
  assertAlpha('bonferroni', 'alpha', alpha)
  assertPValues('bonferroni', pValues)
  const k = pValues.length
  const adjusted = pValues.map((p) => Math.min(1, p * k))
  return { adjusted, significant: adjusted.map((p) => p <= alpha) }
}

/**
 * Holm step-down family-wise error adjustment.
 *
 * P-values are sorted from smallest to largest, multiplied by their remaining
 * hypothesis count, and made monotonically non-decreasing before being mapped
 * back to input order. This uniformly dominates plain Bonferroni while keeping
 * strong family-wise error control under arbitrary dependence.
 */
export function holm(
  pValues: readonly number[],
  alpha = 0.05,
): { adjusted: number[]; significant: boolean[] } {
  assertAlpha('holm', 'alpha', alpha)
  assertPValues('holm', pValues)
  const count = pValues.length
  if (count === 0) return { adjusted: [], significant: [] }

  const ordered = pValues
    .map((pValue, index) => ({ pValue, index }))
    .sort((a, b) => a.pValue - b.pValue || a.index - b.index)
  const adjusted = new Array<number>(count)
  let previous = 0
  for (let rank = 0; rank < count; rank++) {
    const entry = ordered[rank]!
    const stepAdjusted = Math.min(1, entry.pValue * (count - rank))
    previous = Math.max(previous, stepAdjusted)
    adjusted[entry.index] = previous
  }
  // Holm's rejection rule is inclusive at the adjusted alpha boundary.
  return { adjusted, significant: adjusted.map((pValue) => pValue <= alpha) }
}

/**
 * Benjamini–Hochberg false discovery rate. Returns adjusted q-values and
 * significance at the target FDR; handles ties and preserves q monotonicity.
 *
 * Rejects at `q ≤ fdr` — the BH rule is inclusive at the boundary, so an
 * exactly-`fdr` q-value is a discovery.
 */
export function benjaminiHochberg(
  pValues: readonly number[],
  fdr = 0.05,
): { qValues: number[]; significant: boolean[] } {
  assertAlpha('benjaminiHochberg', 'fdr', fdr)
  assertPValues('benjaminiHochberg', pValues)
  const n = pValues.length
  if (n === 0) return { qValues: [], significant: [] }
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const q = new Array<number>(n)
  let minRight = 1
  for (let k = n - 1; k >= 0; k--) {
    const rank = k + 1
    const entry = indexed[k]!
    // (n/rank)·p, not (p·n)/rank: the latter lands one ULP above `fdr` at an
    // exact boundary (p = 0.05, n = 3, rank = 3 gives 0.05000000000000001),
    // which silently turns a discovery into a non-discovery. This is R's
    // `p.adjust(method = "BH")` formulation.
    const raw = (n / rank) * entry.p
    const bounded = Math.min(minRight, raw)
    minRight = bounded
    q[entry.i] = Math.min(1, bounded)
  }
  return { qValues: q, significant: q.map((v) => v <= fdr) }
}

function assertAlpha(fn: string, label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ValidationError(`${fn}: ${label} must be in (0,1), got ${value}`)
  }
}

function assertPValues(fn: string, pValues: readonly number[]): void {
  for (const [index, pValue] of pValues.entries()) {
    if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
      throw new ValidationError(`${fn}: pValues[${index}] must be in [0,1], got ${pValue}`)
    }
  }
}
