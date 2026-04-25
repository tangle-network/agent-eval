import { describe, it, expect } from 'vitest'
import {
  paretoFrontier,
  scalarScore,
  crowdingDistance,
  paretoFrontierWithCrowding,
} from '../src/pareto'
import type { Objective } from '../src/pareto'

interface Candidate {
  id: string
  recall: number
  cost: number
}

const objs: Objective<Candidate>[] = [
  { name: 'recall', direction: 'maximize', value: (c) => c.recall },
  { name: 'cost', direction: 'minimize', value: (c) => c.cost },
]

describe('scalarScore', () => {
  it('honours direction (minimize axes get inverted)', () => {
    const candidates: Candidate[] = [
      { id: 'a', recall: 1.0, cost: 1000 },
      { id: 'b', recall: 0.5, cost: 100 },
    ]
    const scored = scalarScore(candidates, objs)
    // a wins on recall, b wins on cost — equal weights → roughly tied
    const aScore = scored.find((s) => s.candidate.id === 'a')!.score
    const bScore = scored.find((s) => s.candidate.id === 'b')!.score
    // Both should be ~0.5 with min-max norm
    expect(aScore).toBeCloseTo(0.5, 1)
    expect(bScore).toBeCloseTo(0.5, 1)
  })

  it('weights bias the result', () => {
    const candidates: Candidate[] = [
      { id: 'a', recall: 1.0, cost: 1000 },
      { id: 'b', recall: 0.5, cost: 100 },
    ]
    const scored = scalarScore(candidates, objs, { weights: { recall: 9, cost: 1 } })
    const aScore = scored.find((s) => s.candidate.id === 'a')!.score
    const bScore = scored.find((s) => s.candidate.id === 'b')!.score
    expect(aScore).toBeGreaterThan(bScore)
  })

  it('returns [] for empty candidates', () => {
    expect(scalarScore([], objs)).toEqual([])
  })

  it('handles single-candidate (no normalisation crash)', () => {
    const scored = scalarScore([{ id: 'only', recall: 0.7, cost: 500 }], objs)
    expect(scored).toHaveLength(1)
    expect(Number.isFinite(scored[0]!.score)).toBe(true)
  })
})

describe('crowdingDistance', () => {
  it('boundary points get infinity', () => {
    const candidates: Candidate[] = [
      { id: 'a', recall: 0.1, cost: 100 },
      { id: 'b', recall: 0.5, cost: 500 },
      { id: 'c', recall: 0.9, cost: 900 },
    ]
    const d = crowdingDistance(candidates, objs)
    expect(d.find((x) => x.candidate.id === 'a')!.distance).toBe(Infinity)
    expect(d.find((x) => x.candidate.id === 'c')!.distance).toBe(Infinity)
    expect(d.find((x) => x.candidate.id === 'b')!.distance).toBeLessThan(Infinity)
  })

  it('sums normalised gaps for interior candidates', () => {
    const candidates: Candidate[] = [
      { id: 'a', recall: 0, cost: 0 },
      { id: 'b', recall: 0.5, cost: 0.5 },
      { id: 'c', recall: 1, cost: 1 },
    ]
    const d = crowdingDistance(candidates, objs)
    const b = d.find((x) => x.candidate.id === 'b')!.distance
    expect(b).toBeCloseTo(2, 5)
  })
})

describe('paretoFrontierWithCrowding', () => {
  it('returns the frontier sorted by descending crowding distance', () => {
    const candidates: Candidate[] = [
      { id: 'a', recall: 1.0, cost: 1000 },
      { id: 'b', recall: 0.6, cost: 200 },
      { id: 'c', recall: 0.5, cost: 100 },
      { id: 'dom', recall: 0.4, cost: 200 }, // dominated by c
    ]
    const result = paretoFrontierWithCrowding(candidates, objs)
    const ids = result.map((r) => r.candidate.id)
    expect(ids).not.toContain('dom')
    // boundaries (highest recall, lowest cost) should sort first by Infinity distance
    expect(ids[0] === 'a' || ids[0] === 'c').toBe(true)
  })

  it('returns empty when no candidates', () => {
    expect(paretoFrontierWithCrowding([], objs)).toEqual([])
  })

  it('paretoFrontier still works as before (regression)', () => {
    const candidates: Candidate[] = [
      { id: 'a', recall: 1.0, cost: 1000 },
      { id: 'b', recall: 0.5, cost: 100 },
      { id: 'dom', recall: 0.4, cost: 200 },
    ]
    const r = paretoFrontier(candidates, objs)
    expect(r.frontier.map((c) => c.id).sort()).toEqual(['a', 'b'])
    expect(r.dominated.map((c) => c.id)).toEqual(['dom'])
  })
})
