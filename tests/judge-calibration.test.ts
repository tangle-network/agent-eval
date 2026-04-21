import { describe, expect, it } from 'vitest'
import {
  calibrateJudge,
  positionalBias,
  selfPreference,
  verbosityBias,
} from '../src/judge-calibration'

describe('calibrateJudge', () => {
  it('returns high pearson + κ when judge perfectly matches human', () => {
    const golden = Array.from({ length: 10 }, (_, i) => ({ itemId: `i-${i}`, humanScore: i }))
    const cand = golden.map((g) => ({ itemId: g.itemId, score: g.humanScore }))
    const r = calibrateJudge(golden, cand)
    expect(r.pearson).toBeCloseTo(1)
    expect(r.mae).toBe(0)
  })

  it('flags miscalibration with worst-5 items', () => {
    const golden = [
      { itemId: 'a', humanScore: 5 },
      { itemId: 'b', humanScore: 5 },
      { itemId: 'c', humanScore: 5 },
    ]
    const cand = [
      { itemId: 'a', score: 5 },
      { itemId: 'b', score: 8 },
      { itemId: 'c', score: 1 },
    ]
    const r = calibrateJudge(golden, cand)
    expect(r.worstItems[0].itemId).toBe('c')
    expect(r.mae).toBeGreaterThan(0)
  })

  it('skips items without a judge score — regression: NaN would contaminate pearson', () => {
    const golden = [{ itemId: 'a', humanScore: 5 }, { itemId: 'b', humanScore: 6 }]
    const cand = [{ itemId: 'a', score: 5 }]
    const r = calibrateJudge(golden, cand)
    expect(r.n).toBe(1)
    expect(Number.isNaN(r.pearson)).toBe(true) // n<2
  })
})

describe('positionalBias', () => {
  it('returns zero when A/B positions don\'t move the score', () => {
    const r = positionalBias([
      { itemId: 'x', score: 7, positionOfAInput: 'first' },
      { itemId: 'x', score: 7, positionOfAInput: 'second' },
      { itemId: 'y', score: 4, positionOfAInput: 'first' },
      { itemId: 'y', score: 4, positionOfAInput: 'second' },
    ])
    expect(r.avgDelta).toBe(0)
    expect(r.n).toBe(2)
  })

  it('surfaces non-zero positional drift — regression: positional bias that stays hidden breaks rankings', () => {
    const r = positionalBias([
      { itemId: 'x', score: 8, positionOfAInput: 'first' },
      { itemId: 'x', score: 5, positionOfAInput: 'second' },
    ])
    expect(r.avgDelta).toBe(3)
  })
})

describe('verbosityBias', () => {
  it('detects positive correlation between length and score', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ outputLen: i * 100, score: i }))
    const r = verbosityBias(samples)
    expect(r.pearson).toBeGreaterThan(0.9)
  })
})

describe('selfPreference', () => {
  it('computes delta between in-family and out-of-family means', () => {
    const r = selfPreference([
      { score: 9, inFamily: true },
      { score: 8.5, inFamily: true },
      { score: 7, inFamily: false },
      { score: 6.5, inFamily: false },
    ])
    expect(r.deltaMean).toBeCloseTo(2)
    expect(r.n).toBe(4)
  })
})
