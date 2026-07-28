import { normalCdf } from './normal'
import { regularizedIncompleteBeta } from './special-functions'

/**
 * Student-t CDF via the regularized incomplete beta function.
 *
 * Exact to the incomplete beta's own precision for `df ≤ 100`. Above that the
 * function is deliberately the normal approximation, which sits ~6e-4 from the
 * exact Student-t p at `df = 298, t = 2.44` — an accuracy ceiling by design,
 * not residual error in {@link normalCdf}.
 */
export function studentTCdf(t: number, degreesOfFreedom: number): number {
  if (degreesOfFreedom <= 0) return 0.5
  if (degreesOfFreedom > 100) return normalCdf(t)

  const x = degreesOfFreedom / (degreesOfFreedom + t * t)
  const beta = regularizedIncompleteBeta(x, degreesOfFreedom / 2, 0.5)
  return t >= 0 ? 1 - 0.5 * beta : 0.5 * beta
}
