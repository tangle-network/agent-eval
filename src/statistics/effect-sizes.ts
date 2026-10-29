/** Standardized effect sizes; undefined effects remain null. */

import { ValidationError } from '../errors'

/** Independent Cohen's d, oriented b − a; null below two samples or for an unbounded effect. */
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

/** Paired Cohen's dz; constant nonzero deltas have no finite standardized effect. */
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

/** Cliff's delta, oriented after − before; empty samples return zero. */
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

/** Romano magnitude thresholds for the absolute Cliff's delta. */
export function interpretCliffs(delta: number): CliffsMagnitude {
  const d = Math.abs(delta)
  if (d < 0.147) return 'negligible'
  if (d < 0.33) return 'small'
  if (d < 0.474) return 'medium'
  return 'large'
}
