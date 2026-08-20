import { describe, expect, it } from 'vitest'
import {
  confidenceInterval,
  partialCredit,
  pearsonR,
  ranks,
  spearmanR,
  summarizeNumberSeries,
  weightedMean,
} from './index'

describe('weightedMean', () => {
  it('computes simple average with no weights', () => {
    expect(weightedMean([{ score: 4 }, { score: 6 }, { score: 8 }])).toBeCloseTo(6)
  })

  it('computes weighted average', () => {
    expect(
      weightedMean([
        { score: 10, weight: 3 },
        { score: 0, weight: 1 },
      ]),
    ).toBeCloseTo(7.5)
  })

  it('returns 0 for empty input', () => {
    expect(weightedMean([])).toBe(0)
  })
})

describe('confidenceInterval', () => {
  it('returns reasonable bounds for uniform data', () => {
    const scores = [5, 5, 5, 5, 5]
    const ci = confidenceInterval(scores)
    expect(ci.mean).toBe(5)
    expect(ci.lower).toBeCloseTo(5, 1)
    expect(ci.upper).toBeCloseTo(5, 1)
  })

  it('returns wider bounds for varied data', () => {
    const scores = [1, 3, 5, 7, 9]
    const ci = confidenceInterval(scores)
    expect(ci.mean).toBe(5)
    expect(ci.lower).toBeLessThan(ci.mean)
    expect(ci.upper).toBeGreaterThan(ci.mean)
    expect(ci.upper - ci.lower).toBeGreaterThan(0)
  })

  it('handles single value', () => {
    const ci = confidenceInterval([7])
    expect(ci.mean).toBe(7)
    expect(ci.lower).toBe(7)
    expect(ci.upper).toBe(7)
  })

  it('handles empty input', () => {
    const ci = confidenceInterval([])
    expect(ci.mean).toBe(0)
  })
})

describe('partialCredit', () => {
  it('returns correct ratios', () => {
    expect(partialCredit(3, 5)).toBeCloseTo(0.6)
    expect(partialCredit(5, 5)).toBeCloseTo(1)
    expect(partialCredit(0, 5)).toBeCloseTo(0)
  })

  it('clamps above target to 1', () => {
    expect(partialCredit(10, 5)).toBe(1)
  })

  it('returns 1 for zero target', () => {
    expect(partialCredit(0, 0)).toBe(1)
  })
})

describe('pearsonR — consolidated correlation helper', () => {
  it('returns +1 for a perfectly increasing linear relationship', () => {
    expect(pearsonR([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10)
  })

  it('returns -1 for a perfectly decreasing linear relationship', () => {
    expect(pearsonR([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10)
  })

  it('matches the known Pearson value on a worked example', () => {
    // r for ([1,2,3,4,5],[2,4,5,4,5]) ≈ 0.7745966692
    expect(pearsonR([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])).toBeCloseTo(0.7745966692, 8)
  })

  it('is symmetric in its arguments', () => {
    const a = [3, 1, 4, 1, 5, 9]
    const b = [2, 7, 1, 8, 2, 8]
    expect(pearsonR(a, b)).toBeCloseTo(pearsonR(b, a), 12)
  })

  // Edge-case contract — the whole point of consolidating the divergent copies.
  it('returns NaN for fewer than two observations (insufficient data, not 0)', () => {
    expect(pearsonR([], [])).toBeNaN()
    expect(pearsonR([1], [2])).toBeNaN()
  })

  it('returns NaN on a length mismatch', () => {
    expect(pearsonR([1, 2, 3], [1, 2])).toBeNaN()
  })

  it('returns 1 when both series are constant (degenerate perfect agreement)', () => {
    expect(pearsonR([5, 5, 5], [3, 3, 3])).toBe(1)
  })

  it('returns 0 when exactly one series is constant (no covariation to detect)', () => {
    expect(pearsonR([5, 5, 5], [1, 2, 3])).toBe(0)
    expect(pearsonR([1, 2, 3], [4, 4, 4])).toBe(0)
  })
})

describe('ranks — average-rank-with-ties', () => {
  it('ranks distinct values 1..n in value order', () => {
    expect(ranks([10, 30, 20])).toEqual([1, 3, 2])
  })

  it('assigns the average rank to ties', () => {
    // values [5,5,9] occupy ranks 1,2,3 → the two 5s share (1+2)/2 = 1.5
    expect(ranks([5, 5, 9])).toEqual([1.5, 1.5, 3])
    // four equal values all share (1+2+3+4)/4 = 2.5
    expect(ranks([7, 7, 7, 7])).toEqual([2.5, 2.5, 2.5, 2.5])
  })
})

describe('spearmanR — rank correlation', () => {
  it('is +1 for any strictly increasing relationship, even non-linear', () => {
    // cubic is monotone but not linear: Pearson < 1, Spearman = 1
    const x = [1, 2, 3, 4, 5]
    const y = x.map((v) => v ** 3)
    expect(spearmanR(x, y)).toBeCloseTo(1, 10)
    expect(pearsonR(x, y)).toBeLessThan(1)
  })

  it('is -1 for a strictly decreasing relationship', () => {
    expect(spearmanR([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10)
  })

  it('handles ties via average ranks', () => {
    expect(spearmanR([1, 2, 2, 4], [1, 2, 2, 4])).toBeCloseTo(1, 10)
  })

  it('inherits the n<2 / length-mismatch NaN contract', () => {
    expect(spearmanR([1], [2])).toBeNaN()
    expect(spearmanR([1, 2, 3], [1, 2])).toBeNaN()
  })
})

describe('summarizeNumberSeries', () => {
  it('folds a known series into exact n/min/p50/p90/max/sum', () => {
    expect(summarizeNumberSeries([10, 1, 5, 3, 8, 2, 7, 4, 9, 6])).toEqual({
      n: 10,
      min: 1,
      p50: 5,
      p90: 9,
      max: 10,
      sum: 55,
    })
  })

  it('uses the nearest-rank quantile, so every quantile is a series value', () => {
    expect(summarizeNumberSeries([1, 2, 3])).toEqual({
      n: 3,
      min: 1,
      p50: 2,
      p90: 3,
      max: 3,
      sum: 6,
    })
  })

  it('reports the single value for every statistic of a one-element series', () => {
    expect(summarizeNumberSeries([7])).toEqual({ n: 1, min: 7, p50: 7, p90: 7, max: 7, sum: 7 })
  })

  it('returns null for an empty series instead of a fabricated all-zero summary', () => {
    expect(summarizeNumberSeries([])).toBeNull()
  })

  it('does not mutate the input series', () => {
    const series = [3, 1, 2]
    summarizeNumberSeries(series)
    expect(series).toEqual([3, 1, 2])
  })
})
