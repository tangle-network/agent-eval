/** Finite non-negative values can be added to cost and duration totals. */
export function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
