/** Arithmetic mean. An empty input has no mean and returns NaN. */
export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Arithmetic mean, or null for an empty input. */
export function meanOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : mean(values)
}

/** Arithmetic mean, or 0 for an empty input. */
export function meanOrZero(values: readonly number[]): number {
  return values.length === 0 ? 0 : mean(values)
}
