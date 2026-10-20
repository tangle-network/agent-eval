/** Arithmetic mean. An empty input has no mean and returns NaN. */
export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
