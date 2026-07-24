/** Combine active cancellation sources without wrapping a single source. */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = [
    ...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined)),
  ]
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}
