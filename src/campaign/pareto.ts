/**
 * @experimental
 *
 * Pareto-frontier primitive for GEPA-style optimization. The GEPA paper
 * (Agrawal et al., arXiv:2507.19457) does NOT keep only the composite-best
 * candidate each generation — it retains the set of **non-dominated**
 * candidates across the per-instance (here: per-scenario) objective vectors,
 * and combines complementary lessons across them. A candidate that is worse on
 * the composite but uniquely best on one hard scenario carries a lesson the
 * composite-best would discard; the frontier preserves it.
 *
 * Pure functions, no I/O — the driver and the loop both consume them.
 */

/** A candidate's objective vector keyed by objective id (e.g. scenarioId).
 *  Higher is better on every objective. A missing key is treated as the worst
 *  possible value (−∞) so a candidate cannot dominate on an objective it was
 *  never scored on. */
export type ObjectiveVector = Record<string, number>

function valueAt(v: ObjectiveVector, key: string): number {
  const x = v[key]
  return typeof x === 'number' && Number.isFinite(x) ? x : Number.NEGATIVE_INFINITY
}

/**
 * Does `a` Pareto-dominate `b` over `keys`? True iff `a >= b` on EVERY key AND
 * `a > b` on AT LEAST ONE. Two identical vectors do not dominate each other.
 */
export function dominates(
  a: ObjectiveVector,
  b: ObjectiveVector,
  keys: readonly string[],
): boolean {
  let strictlyBetterSomewhere = false
  for (const k of keys) {
    const av = valueAt(a, k)
    const bv = valueAt(b, k)
    if (av < bv) return false
    if (av > bv) strictlyBetterSomewhere = true
  }
  return strictlyBetterSomewhere
}

/** Union of all objective keys across the items' vectors, in first-seen order. */
export function objectiveKeys(vectors: ReadonlyArray<ObjectiveVector>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of vectors) {
    for (const k of Object.keys(v)) {
      if (!seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  return out
}

/**
 * The non-dominated (Pareto) frontier: every item NOT dominated by any other
 * item. Input order is preserved. An item with a strictly-higher value on any
 * single objective survives even if its composite is lower — that is the whole
 * point versus a composite-only `sort().slice(topK)`.
 *
 * Ties (identical vectors) all survive — none dominates the other.
 */
export function paretoFrontier<T>(
  items: readonly T[],
  vectorOf: (item: T) => ObjectiveVector,
): T[] {
  if (items.length <= 1) return [...items]
  const vectors = items.map(vectorOf)
  const keys = objectiveKeys(vectors)
  const frontier: T[] = []
  for (let i = 0; i < items.length; i++) {
    let isDominated = false
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue
      if (dominates(vectors[j]!, vectors[i]!, keys)) {
        isDominated = true
        break
      }
    }
    if (!isDominated) frontier.push(items[i]!)
  }
  return frontier
}
