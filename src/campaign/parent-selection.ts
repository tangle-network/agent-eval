/**
 * Parent selection for `runOptimization`.
 *
 * Each generation mutates one parent surface. The default parent is the
 * global incumbent, so the search is a hill-climb and the lineage recorded in
 * `GenerationCandidate.parentSurfaceHash` is a chain. A `ParentSelector` draws
 * the parent from the Pareto frontier instead, so the recorded lineage becomes
 * a tree. Promotion is unchanged: a candidate still has to beat the incumbent.
 */

import { type Objective, paretoFrontierWithCrowding } from '../pareto'
import { mulberry32 } from '../statistics/random'
import type { GenerationRecord, ParetoParent, ScoredSurfaceOutcome } from './types'

/** Search state supplied to one parent-selection call. */
export interface ParentSelectionContext {
  /** Non-dominated scored surfaces across the whole run so far, including the
   *  baseline (`generation: -1`). Never empty. */
  readonly frontier: ReadonlyArray<ParetoParent>
  /** Measured result of the global incumbent, the promotion bar. Under the
   *  default `selectionRankKey` the incumbent is always on `frontier`. */
  readonly incumbent: ScoredSurfaceOutcome
  /** Every completed generation so far. */
  readonly history: ReadonlyArray<GenerationRecord>
  /** Index of the generation about to propose. */
  readonly generation: number
}

/** Chooses the surface the next generation mutates. Returns one frontier
 *  parent; `runOptimization` refuses a parent it has not measured to
 *  completion or whose surface does not match its `surfaceHash`. */
export type ParentSelector = (ctx: ParentSelectionContext) => ParetoParent

export interface CrowdedFrontierParentOptions {
  /** Integer seed for the per-generation draw. The same seed, frontier, and
   *  generation index select the same parent. */
  seed: number
}

/**
 * NSGA-II crowded tournament selection over the frontier. Each generation
 * draws two distinct frontier members with a PRNG seeded from `seed` and the
 * generation index, and keeps the one with the larger crowding distance (more
 * isolated on the frontier). Boundary parents carry infinite distance, so a
 * boundary parent always beats an interior one. A tie on distance falls back
 * to the higher mean composite, then to the smaller surface hash. A frontier
 * of one member returns that member.
 */
export function crowdedFrontierParent(options: CrowdedFrontierParentOptions): ParentSelector {
  const { seed } = options
  if (!Number.isInteger(seed)) {
    throw new TypeError(`crowdedFrontierParent: seed must be an integer, got ${String(seed)}`)
  }
  return ({ frontier, generation }) => {
    if (frontier.length === 0) {
      throw new Error('crowdedFrontierParent: frontier is empty')
    }
    if (frontier.length === 1) return frontier[0]!
    const distances = new Map<ParetoParent, number>()
    for (const { candidate, distance } of paretoFrontierWithCrowding(
      [...frontier],
      frontierObjectives(frontier),
    )) {
      distances.set(candidate, distance)
    }
    const rng = mulberry32(tournamentSeed(seed, generation))
    const first = Math.floor(rng() * frontier.length)
    const offset = Math.floor(rng() * (frontier.length - 1))
    const second = offset >= first ? offset + 1 : offset
    const a = frontier[first]!
    const b = frontier[second]!
    return compareCrowded(a, distanceOf(distances, a), b, distanceOf(distances, b)) <= 0 ? a : b
  }
}

function distanceOf(distances: ReadonlyMap<ParetoParent, number>, parent: ParetoParent): number {
  const distance = distances.get(parent)
  if (distance === undefined) {
    throw new Error(
      `crowdedFrontierParent: frontier member "${parent.surfaceHash}" is dominated or has a non-finite objective`,
    )
  }
  return distance
}

/** Negative when `a` wins the tournament, positive when `b` wins. */
function compareCrowded(a: ParetoParent, da: number, b: ParetoParent, db: number): number {
  if (da !== db) return da > db ? -1 : 1
  if (a.composite !== b.composite) return a.composite > b.composite ? -1 : 1
  if (a.surfaceHash === b.surfaceHash) return 0
  return a.surfaceHash < b.surfaceHash ? -1 : 1
}

/** One `maximize` objective per scenario id present on the frontier. */
function frontierObjectives(frontier: ReadonlyArray<ParetoParent>): Objective<ParetoParent>[] {
  const ids = new Set<string>()
  for (const parent of frontier) for (const id of Object.keys(parent.objectives)) ids.add(id)
  if (ids.size === 0) {
    throw new Error('crowdedFrontierParent: frontier parents carry no objectives')
  }
  return [...ids].sort().map((id) => ({
    name: id,
    direction: 'maximize',
    value: (parent) => {
      const value = parent.objectives[id]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `crowdedFrontierParent: frontier member "${parent.surfaceHash}" has no finite objective "${id}"`,
        )
      }
      return value
    },
  }))
}

function tournamentSeed(seed: number, generation: number): number {
  return (seed ^ Math.imul(generation + 1, 0x9e3779b1)) | 0
}
