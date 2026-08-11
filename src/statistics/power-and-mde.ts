import { normalCdf } from '../math/normal'
import { zQuantile } from './internal'

// ── Power analysis + minimum detectable effect ───────────────────────

/**
 * Required N per arm for a two-sample comparison at target effect size,
 * alpha, and power. Normal-approximation formula:
 *   n = 2 * ( (z_{1-α/2} + z_{1-β}) / d )^2
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
 * Required number of paired observations for a target Cohen's dz.
 * Unlike the independent-groups formula, this has no two-arm factor of two.
 *
 * Normal quantiles with no t correction, so treat the result as a LOWER bound:
 * it returns 32 where the exact t-based answer is 34 at dz = 0.5, and 13 where
 * it is 15 at dz = 0.8 — a 6–13 % shortfall precisely in the range a caller
 * consults to decide whether 3–10 repetitions suffice.
 */
export function requiredPairedSampleSize(opts: {
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
  return Math.ceil(((zAlpha + zBeta) / effect) ** 2)
}

/**
 * Minimum detectable paired effect (standardised units) for a target paired
 * sample size: d_min = (z_{1-α/2} + z_β) / sqrt(n_paired). Multiply by
 * sd(deltas) for score units; treat as a lower bound — Wilcoxon and bootstrap
 * have asymptotic relative efficiency below 1 vs the t-test on heavy tails.
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

/**
 * Number of paired observations needed for a McNemar test to reach a target
 * power — the pre-registration companion to {@link mcnemar}. Parametrised by the
 * expected discordant-cell probabilities `p10` (P[treatment wins on a pair]) and
 * `p01` (P[control wins]); concordant pairs carry no information, so the count
 * is driven entirely by the discordant rate. Lachin's (1992) asymptotic normal
 * approximation: with discordant rate `pDisc = p10 + p01` and marginal effect
 * `δ = p10 − p01`,
 *   n = ( z_{1-α/2}·√pDisc + z_{1-β}·√(pDisc − δ²) )² / δ².
 * Returns Infinity when there is no effect (p10 === p01). Asymptotic — at the
 * tiny discordant counts where the exact {@link mcnemar} differs from the normal
 * approximation, treat the result as a lower bound and prefer the discordant-pair
 * floor.
 */
export function mcnemarRequiredN(opts: {
  p10: number
  p01: number
  alpha?: number
  power?: number
  twoSided?: boolean
}): number {
  const { p10, p01 } = opts
  if (p10 < 0 || p01 < 0 || p10 + p01 > 1) {
    throw new Error(`mcnemarRequiredN: require p10,p01 ≥ 0 and p10+p01 ≤ 1 (got ${p10}, ${p01})`)
  }
  const delta = p10 - p01
  if (delta === 0) return Infinity
  const alpha = opts.alpha ?? 0.05
  const power = opts.power ?? 0.8
  const twoSided = opts.twoSided ?? true
  const pDisc = p10 + p01
  const zAlpha = zQuantile(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const zBeta = zQuantile(power)
  const n =
    (zAlpha * Math.sqrt(pDisc) + zBeta * Math.sqrt(Math.max(0, pDisc - delta * delta))) ** 2 /
    (delta * delta)
  return Math.ceil(n)
}

/**
 * Power of a McNemar test at a given number of paired observations, the inverse
 * of {@link mcnemarRequiredN} (same Lachin asymptotic model, same parameters).
 * Returns a value in [0, 1]; equals `alpha` when there is no effect.
 */
export function mcnemarPower(opts: {
  p10: number
  p01: number
  nPairs: number
  alpha?: number
  twoSided?: boolean
}): number {
  const { p10, p01, nPairs } = opts
  if (p10 < 0 || p01 < 0 || p10 + p01 > 1) {
    throw new Error(`mcnemarPower: require p10,p01 ≥ 0 and p10+p01 ≤ 1 (got ${p10}, ${p01})`)
  }
  const alpha = opts.alpha ?? 0.05
  const twoSided = opts.twoSided ?? true
  const delta = p10 - p01
  if (delta === 0 || nPairs <= 0) return alpha
  const pDisc = p10 + p01
  const zAlpha = zQuantile(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const denom = Math.sqrt(Math.max(1e-12, pDisc - delta * delta))
  const zBeta = (Math.sqrt(nPairs) * Math.abs(delta) - zAlpha * Math.sqrt(pDisc)) / denom
  return Math.min(1, Math.max(0, normalCdf(zBeta)))
}
