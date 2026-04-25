/**
 * Pareto frontier — multi-objective optimization over candidate runs.
 *
 * Lifted from ADC pareto.ts and blueprint-agent frontier.ts. When you're
 * trading off (cost, latency, quality) or (passRate, tokenBudget,
 * ttfb), you rarely have a single "winner" — you have a set of
 * non-dominated candidates. This module exposes:
 *
 *   - `paretoFrontier`: filter a set of candidates to the non-dominated ones
 *   - `dominates`: does A dominate B across all objectives?
 *
 * Each objective is declared with a direction: 'maximize' (higher=better)
 * or 'minimize' (lower=better). Candidates are any object; pass an
 * `objective(candidate)` accessor.
 */

export type Direction = 'maximize' | 'minimize'

export interface Objective<T> {
  /** Stable label used in reports. */
  name: string
  direction: Direction
  value: (candidate: T) => number
}

export interface ParetoResult<T> {
  frontier: T[]
  dominated: T[]
  /** Index map: frontier[i] dominates each of dominatedBy[i]. */
  dominanceMap: Array<{ dominator: T; dominated: T[] }>
}

/** Does candidate A weakly dominate B — strictly better on at least one objective and no worse on any? */
export function dominates<T>(a: T, b: T, objectives: Objective<T>[]): boolean {
  let strictlyBetter = false
  for (const obj of objectives) {
    const av = obj.value(a)
    const bv = obj.value(b)
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return false
    const aIsBetter = obj.direction === 'maximize' ? av > bv : av < bv
    const aIsWorse = obj.direction === 'maximize' ? av < bv : av > bv
    if (aIsWorse) return false
    if (aIsBetter) strictlyBetter = true
  }
  return strictlyBetter
}

/**
 * Compute the non-dominated frontier. Candidates with NaN/Infinity on any
 * objective are excluded (can't rank them). A candidate enters the frontier
 * iff no other candidate dominates it.
 */
export function paretoFrontier<T>(candidates: T[], objectives: Objective<T>[]): ParetoResult<T> {
  if (objectives.length === 0) {
    throw new Error('paretoFrontier: at least 1 objective required')
  }
  const valid = candidates.filter((c) =>
    objectives.every((o) => Number.isFinite(o.value(c))),
  )
  const frontier: T[] = []
  const dominated: T[] = []
  for (const c of valid) {
    const isDominated = valid.some((other) => other !== c && dominates(other, c, objectives))
    if (isDominated) dominated.push(c)
    else frontier.push(c)
  }
  const dominanceMap = frontier.map((d) => ({
    dominator: d,
    dominated: dominated.filter((x) => dominates(d, x, objectives)),
  }))
  return { frontier, dominated, dominanceMap }
}

/**
 * Weighted-sum scalarisation. Use as a tie-break / single-winner selector
 * when callers don't want to consume a frontier. Each objective contributes
 * its normalised value (0..1 via min-max across the candidate pool) times
 * its weight; missing weights default to 1/N.
 *
 * Direction is honoured automatically — `minimize` axes have their values
 * inverted before scaling so "higher scalar = better" always holds.
 */
export function scalarScore<T>(
  candidates: T[],
  objectives: Objective<T>[],
  options: { weights?: Partial<Record<string, number>> } = {},
): Array<{ candidate: T; score: number }> {
  if (candidates.length === 0) return []
  const weights = options.weights ?? {}
  const totalWeight = objectives.reduce((s, o) => s + (weights[o.name] ?? 1), 0)

  // Pre-compute min/max per objective for normalisation.
  const ranges = objectives.map((obj) => {
    const values = candidates.map((c) => obj.value(c)).filter((v) => Number.isFinite(v))
    if (values.length === 0) return { min: 0, max: 1 }
    const min = Math.min(...values)
    const max = Math.max(...values)
    return { min, max: max === min ? min + 1 : max }
  })

  return candidates.map((c) => {
    let score = 0
    objectives.forEach((obj, i) => {
      const v = obj.value(c)
      if (!Number.isFinite(v)) return
      const { min, max } = ranges[i]!
      const normalised = (v - min) / (max - min)
      const directional = obj.direction === 'maximize' ? normalised : 1 - normalised
      const weight = (weights[obj.name] ?? 1) / totalWeight
      score += directional * weight
    })
    return { candidate: c, score }
  })
}

/**
 * NSGA-II crowding distance — secondary sort for ties on the frontier.
 *
 * When the Pareto front collapses to a single point (or many candidates tie
 * on dominance), naive selection picks arbitrarily and the population
 * degenerates over generations. NSGA-II preserves diversity by preferring
 * candidates with more empty space around them on the frontier.
 *
 * Returns an array of `{ candidate, distance }` in the SAME order as the
 * input. Higher distance = more isolated = should be preferred when
 * preserving diversity.
 */
export function crowdingDistance<T>(
  candidates: T[],
  objectives: Objective<T>[],
): Array<{ candidate: T; distance: number }> {
  const distances = new Map<T, number>(candidates.map((c) => [c, 0]))

  for (const obj of objectives) {
    const sorted = [...candidates].sort((a, b) => obj.value(a) - obj.value(b))
    const min = obj.value(sorted[0]!)
    const max = obj.value(sorted[sorted.length - 1]!)
    const range = max - min || 1

    // Boundary points get infinity (always preferred for diversity).
    distances.set(sorted[0]!, Infinity)
    distances.set(sorted[sorted.length - 1]!, Infinity)
    for (let i = 1; i < sorted.length - 1; i++) {
      const prev = obj.value(sorted[i - 1]!)
      const next = obj.value(sorted[i + 1]!)
      const current = distances.get(sorted[i]!)!
      if (current === Infinity) continue
      distances.set(sorted[i]!, current + (next - prev) / range)
    }
  }

  return candidates.map((c) => ({ candidate: c, distance: distances.get(c) ?? 0 }))
}

/**
 * Pareto frontier with tie-break by crowding distance — the canonical
 * NSGA-II selection step. Returns the frontier sorted by descending crowding
 * distance so callers can `.slice(0, k)` to pick K diverse winners.
 */
export function paretoFrontierWithCrowding<T>(
  candidates: T[],
  objectives: Objective<T>[],
): Array<{ candidate: T; distance: number }> {
  const { frontier } = paretoFrontier(candidates, objectives)
  if (frontier.length === 0) return []
  const distances = crowdingDistance(frontier, objectives)
  return distances.sort((a, b) => b.distance - a.distance)
}
