import { regularizedIncompleteBeta } from './special-functions'

/**
 * Student-t CDF via the regularized incomplete beta function.
 */
export function studentTCdf(t: number, degreesOfFreedom: number): number {
  if (degreesOfFreedom <= 0) return 0.5

  const x = degreesOfFreedom / (degreesOfFreedom + t * t)
  const beta = regularizedIncompleteBeta(x, degreesOfFreedom / 2, 0.5)
  return t >= 0 ? 1 - 0.5 * beta : 0.5 * beta
}

/**
 * Inverse Student-t CDF, solved against {@link studentTCdf}.
 *
 * The CDF is monotone, so bracket expansion followed by bisection is stable
 * across fractional degrees of freedom and does not need a separate
 * approximation with a different error profile.
 */
export function studentTQuantile(probability: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError(`studentTQuantile: probability must be in [0,1], got ${probability}`)
  }
  if (!Number.isFinite(degreesOfFreedom) || degreesOfFreedom <= 0) {
    throw new RangeError(
      `studentTQuantile: degreesOfFreedom must be positive and finite, got ${degreesOfFreedom}`,
    )
  }
  if (probability === 0) return Number.NEGATIVE_INFINITY
  if (probability === 1) return Number.POSITIVE_INFINITY
  if (probability === 0.5) return 0
  if (probability < 0.5) return -studentTQuantile(1 - probability, degreesOfFreedom)

  let low = 0
  let high = 1
  while (studentTCdf(high, degreesOfFreedom) < probability) high *= 2
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle = (low + high) / 2
    if (studentTCdf(middle, degreesOfFreedom) < probability) low = middle
    else high = middle
  }
  return (low + high) / 2
}
