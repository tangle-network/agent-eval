import { normalCdf } from './normal'
import { regularizedIncompleteBeta } from './special-functions'

/** Student-t CDF via the regularized incomplete beta function. */
export function studentTCdf(t: number, degreesOfFreedom: number): number {
  if (degreesOfFreedom <= 0) return 0.5
  if (degreesOfFreedom > 100) return normalCdf(t)

  const x = degreesOfFreedom / (degreesOfFreedom + t * t)
  const beta = regularizedIncompleteBeta(x, degreesOfFreedom / 2, 0.5)
  return t >= 0 ? 1 - 0.5 * beta : 0.5 * beta
}
