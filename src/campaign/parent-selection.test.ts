import { describe, expect, it } from 'vitest'
import { crowdedFrontierParent, type ParentSelectionContext } from './parent-selection'
import type { ParetoParent, ScoredSurfaceOutcome } from './types'

function parent(hash: string, objectives: Record<string, number>, generation = 0): ParetoParent {
  const values = Object.values(objectives)
  return {
    surface: hash,
    surfaceHash: hash,
    objectives,
    composite: values.reduce((sum, value) => sum + value, 0) / values.length,
    generation,
  }
}

const incumbent: ScoredSurfaceOutcome = {
  split: 'search',
  generation: -1,
  surfaceHash: 'baseline',
  composite: 0.5,
  dimensions: {},
  scenarios: [],
  coverage: { expectedCells: 2, scorableCells: 2 },
}

function context(frontier: ParetoParent[], generation: number): ParentSelectionContext {
  return { frontier, incumbent, history: [], generation }
}

describe('crowdedFrontierParent', () => {
  // Two boundary parents (one per objective extreme, infinite crowding
  // distance) and one interior parent on a two-scenario frontier.
  const left = parent('left', { s1: 1, s2: 0 })
  const right = parent('right', { s1: 0, s2: 1 })
  const middle = parent('middle', { s1: 0.5, s2: 0.5 })

  it('prefers the isolated frontier parents the crowded tournament exists to keep', () => {
    const frontier = [middle, left, right]
    const select = crowdedFrontierParent({ seed: 7 })
    const draws = new Set(
      Array.from({ length: 40 }, (_, g) => select(context(frontier, g)).surfaceHash),
    )
    // Every pair contains a boundary parent, so the interior one never wins
    // and the population cannot collapse onto the frontier's middle.
    expect(draws).toEqual(new Set(['left', 'right']))
  })
})
