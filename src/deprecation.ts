/**
 * One-shot deprecation warnings. A deprecated surface warns the FIRST time it
 * is used in a process — loud enough to be seen, quiet enough not to flood a
 * matrix run that constructs it per cell.
 */

const warned = new Set<string>()

/** Emit `message` on console.warn once per process per `key`. */
export function warnDeprecatedOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[agent-eval deprecation] ${message}`)
}

/** Test seam: forget prior warnings so once-semantics can be asserted. */
export function resetDeprecationWarnings(): void {
  warned.clear()
}
