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
