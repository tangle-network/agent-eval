export function assertMatchedMethodLimits(
  selectedMethods: Iterable<string>,
  limits: Readonly<Record<string, number>>,
  label: string,
): void {
  const selected = [...new Set(selectedMethods)]
  const entries = selected.map((name) => {
    const limit = limits[name]
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(`${label} is missing a positive safe integer for ${name}`)
    }
    return [name, limit] as const
  })
  if (new Set(entries.map(([, limit]) => limit)).size <= 1) return
  throw new Error(
    `${label} must match when comparing methods; received ${entries
      .map(([name, limit]) => `${name}=${limit}`)
      .join(', ')}`,
  )
}
