import { describe, expect, it } from 'vitest'
import { adversarialScenarioSearch } from '../src/rl/adversarial'
import { bestOfN, paretoFrontier, runComputeCurve, selfConsistency } from '../src/rl/compute-curves'

interface Scen {
  id: string
  difficulty: number
}

describe('adversarialScenarioSearch', () => {
  it('discovers failures by mutating seeds', async () => {
    const seeds: Scen[] = [
      { id: 's-easy-0', difficulty: 0.2 },
      { id: 's-easy-1', difficulty: 0.3 },
    ]
    const out = await adversarialScenarioSearch<Scen>({
      seeds,
      mutateScenarioId: (s) => s.id,
      mutations: [
        {
          id: 'increase-difficulty',
          mutate: (parent, rng) => [
            {
              id: `${parent.id}-mut-${rng().toFixed(3)}`,
              difficulty: Math.min(1, parent.difficulty + 0.5),
            },
          ],
        },
      ],
      scoreFn: async (s) => 1 - s.difficulty,
      failureThreshold: 0.5,
      rounds: 2,
      childrenPerParent: 2,
      seed: 7,
    })
    expect(out.failures.length).toBeGreaterThan(0)
    expect(out.failures.every((s) => s.score! < 0.5)).toBe(true)
    // Generation 1+ has lower-than-seed scores on average.
    const gen0 = out.byGeneration.find((g) => g.generation === 0)!
    const gen1 = out.byGeneration.find((g) => g.generation === 1)
    if (gen1) expect(gen1.meanScore).toBeLessThan(gen0.meanScore)
  })

  it('respects budget and stops when exhausted', async () => {
    const out = await adversarialScenarioSearch<Scen>({
      seeds: [{ id: 's', difficulty: 0.1 }],
      mutateScenarioId: (s) => s.id,
      mutations: [
        {
          id: 'm',
          mutate: (p, rng) => [{ id: `${p.id}/${rng().toFixed(3)}`, difficulty: 0.6 }],
        },
      ],
      scoreFn: async (s) => 1 - s.difficulty,
      rounds: 10,
      childrenPerParent: 5,
      budget: 4,
    })
    expect(out.scoreCalls).toBeLessThanOrEqual(4)
  })

  it('deduplicates by mutateScenarioId so the same id only scores once', async () => {
    let calls = 0
    await adversarialScenarioSearch<Scen>({
      seeds: [{ id: 's', difficulty: 0.5 }],
      mutateScenarioId: (s) => s.id,
      mutations: [
        {
          id: 'collide',
          // Always returns the same id — should be deduplicated after the first call.
          mutate: () => [{ id: 's', difficulty: 0.5 }],
        },
      ],
      scoreFn: async () => {
        calls++
        return 0.5
      },
      rounds: 5,
      childrenPerParent: 5,
    })
    expect(calls).toBe(1)
  })
})

describe('bestOfN', () => {
  it('picks the highest-scoring sample', async () => {
    const out = await bestOfN({
      n: 5,
      sample: async (i) => ({ idx: i }),
      scoreFn: ({ idx }) => idx * 0.1,
    })
    expect(out.bestIndex).toBe(4)
    expect(out.bestScore).toBeCloseTo(0.4, 5)
    expect(out.scores).toHaveLength(5)
  })

  it('throws on n <= 0', async () => {
    await expect(bestOfN({ n: 0, sample: async () => 0, scoreFn: () => 0 })).rejects.toThrow()
  })
})

describe('selfConsistency', () => {
  it('returns the modal answer with agreement fraction', async () => {
    const out = await selfConsistency({
      n: 5,
      sample: async (i) => ({ ans: i < 3 ? 'A' : 'B' }),
      answerKey: ({ ans }) => ans,
    })
    expect(out.answer).toBe('A')
    expect(out.agreement).toBe(0.6)
    expect(out.histogram).toEqual({ A: 3, B: 2 })
  })
})

describe('runComputeCurve + paretoFrontier', () => {
  it('produces a sorted curve and a positive log-slope under "more compute helps"', async () => {
    const curve = await runComputeCurve({
      candidateId: 'cand',
      budgets: [
        { id: '1x', cost: 1 },
        { id: '4x', cost: 4 },
        { id: '16x', cost: 16 },
      ],
      runAtBudget: async (b) => ({
        score: 0.5 + 0.1 * Math.log2(b.cost),
        samples: b.cost,
      }),
    })
    expect(curve.points.map((p) => p.cost)).toEqual([1, 4, 16])
    expect(curve.logSlope).toBeGreaterThan(0)
    expect(curve.best.budgetId).toBe('16x')
  })

  it('paretoFrontier removes dominated points', () => {
    const front = paretoFrontier([
      { candidateId: 'cheap_bad', budgetId: '1x', cost: 1, score: 0.4 },
      { candidateId: 'cheap_good', budgetId: '1x', cost: 1, score: 0.7 },
      { candidateId: 'pricey_great', budgetId: '4x', cost: 4, score: 0.85 },
      { candidateId: 'pricey_meh', budgetId: '4x', cost: 4, score: 0.5 },
    ])
    const ids = front.map((p) => p.candidateId).sort()
    expect(ids).toEqual(['cheap_good', 'pricey_great'])
  })
})
