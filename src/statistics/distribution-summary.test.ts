import { describe, expect, it } from 'vitest'
import { studentTCritical } from './descriptive'
import { percentileNearestRank, summarizeDistribution } from './distribution-summary'

describe('summarizeDistribution', () => {
  it('matches the retired nearest-rank percentiles and t-CI', () => {
    const s = summarizeDistribution([10, 20, 30, 40, 50])
    expect(s.n).toBe(5)
    expect(s.p50).toBe(30)
    expect(s.p90).toBe(50)
    expect(s.p99).toBe(50)
    expect(s.mean).toBe(30)
    // df=4 exact t (the retired table rounded it to 2.776)
    const margin = (studentTCritical(4, 0.95) * s.stddev!) / Math.sqrt(5)
    expect(s.ci95Low!).toBeCloseTo(30 - margin, 10)
    expect(s.ci95High!).toBeCloseTo(30 + margin, 10)
  })

  it('filters to the lower bound, answers empty with an all-NaN row, refuses non-finite', () => {
    const s = summarizeDistribution([-5, 0, 5, 100], { lowerBound: 0 })
    expect(s.min).toBe(0)
    const empty = summarizeDistribution([], { lowerBound: 1 })
    expect(empty.n).toBe(0)
    expect(empty.p50).toBeNaN()
    expect(() => summarizeDistribution([1, Number.NaN])).toThrow()
  })

  it('omits the CI for a single sample', () => {
    const s = summarizeDistribution([42])
    expect(s.stddev).toBeUndefined()
    expect(s.ci95Low).toBeUndefined()
  })
})

describe('percentileNearestRank', () => {
  it('returns NaN on empty and the top rank at p100', () => {
    expect(percentileNearestRank([], 50)).toBeNaN()
    expect(percentileNearestRank([1, 2, 3], 100)).toBe(3)
  })
})
