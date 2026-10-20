/** Round to a decimal precision, preserving JavaScript Math.round semantics. */
export function roundDecimal(v: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}
