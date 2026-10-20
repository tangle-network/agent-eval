/** Normalize IEEE negative zero before numerical evidence reaches canonical JSON. */
export function normalizeSignedZero(value: number): number {
  return value === 0 ? 0 : value
}
