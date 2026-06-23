import { describe, expect, it } from 'vitest'
import { bestOfN, paretoFrontier, runComputeCurve, selfConsistency } from '../src/rl/compute-curves'

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
