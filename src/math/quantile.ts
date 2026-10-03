/** Linear interpolation over an ascending sample; empty input has no quantile. */
export function interpolatedQuantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return Number.NaN
  const position = q * (sorted.length - 1)
  const lo = Math.floor(position)
  const hi = Math.ceil(position)
  if (lo === hi) return sorted[lo]!
  const fraction = position - lo
  return sorted[lo]! * (1 - fraction) + sorted[hi]! * fraction
}
