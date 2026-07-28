/**
 * Standard normal cumulative distribution using Abramowitz and Stegun 7.1.26.
 *
 * The approximation is evaluated as erf(x / sqrt(2)). Computing the negative
 * tail from the complementary term avoids cancellation when x is far below 0.
 * The maximum absolute CDF error is approximately 7.5e-8.
 */
export function normalCdf(x: number): number {
  if (x === 0) return 0.5

  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const scaled = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + p * scaled)
  const complement = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-scaled * scaled)

  return x < 0 ? complement / 2 : 1 - complement / 2
}
