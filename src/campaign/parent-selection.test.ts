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

  it('rejects a non-integer seed', () => {
    expect(() => crowdedFrontierParent({ seed: 0.5 })).toThrow(/seed must be an integer/)
  })

  it('refuses an empty frontier', () => {
    expect(() => crowdedFrontierParent({ seed: 1 })(context([], 0))).toThrow(/frontier is empty/)
  })

  it('returns the sole member of a one-parent frontier', () => {
    expect(crowdedFrontierParent({ seed: 1 })(context([middle], 0))).toBe(middle)
  })

  it('is deterministic for the same seed, frontier, and generation', () => {
    const frontier = [left, middle, right]
    const a = crowdedFrontierParent({ seed: 11 })
    const b = crowdedFrontierParent({ seed: 11 })
    const drawsA = Array.from({ length: 20 }, (_, g) => a(context(frontier, g)).surfaceHash)
    const drawsB = Array.from({ length: 20 }, (_, g) => b(context(frontier, g)).surfaceHash)
    expect(drawsA).toEqual(drawsB)
  })

  it('prefers boundary parents in every tournament', () => {
    const frontier = [middle, left, right]
    const select = crowdedFrontierParent({ seed: 7 })
    const draws = new Set(
      Array.from({ length: 40 }, (_, g) => select(context(frontier, g)).surfaceHash),
    )
    // Every pair contains a boundary parent, so the interior one never wins.
    expect(draws.has('middle')).toBe(false)
    expect(draws).toEqual(new Set(['left', 'right']))
  })

  it('breaks a distance tie by composite, then by surface hash', () => {
    // Both parents are boundary points (infinite distance) with equal
    // composite, so the smaller surface hash wins every tournament.
    const a = parent('a', { s1: 1, s2: 0 })
    const b = parent('b', { s1: 0, s2: 1 })
    const select = crowdedFrontierParent({ seed: 3 })
    for (let g = 0; g < 10; g++) expect(select(context([b, a], g))).toBe(a)
    // A higher composite beats the hash order.
    const c = parent('c', { s1: 0.9, s2: 0.2 })
    for (let g = 0; g < 10; g++) expect(select(context([a, c], g))).toBe(c)
  })

  it('fails loud on a frontier member with a missing or non-finite objective', () => {
    const select = crowdedFrontierParent({ seed: 1 })
    expect(() => select(context([left, parent('broken', { s1: Number.NaN, s2: 1 })], 0))).toThrow(
      /has no finite objective "s1"/,
    )
    expect(() => select(context([left, parent('partial', { s1: 0.2 })], 0))).toThrow(
      /has no finite objective "s2"/,
    )
  })
})
