/** Freeze a detached canonical-JSON graph. Canonicalization has already ruled out cycles.
 *
 * Lives outside canonical.ts so the analyst-benchmark implementation digest,
 * which covers canonical.ts, stays bound to the published benchmark evidence. */
export function deepFreezeCanonicalJson<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreezeCanonicalJson(nested)
  }
  return value
}
