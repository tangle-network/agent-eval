import { describe, expect, it } from 'vitest'
import {
  chiSquared,
  chiSquaredPValue,
  fisherExactTwoSided,
  linearRegressionSlope,
  normalTwoSidedPValue,
  studentTTwoSidedPValue,
  twoByTwoPValue,
} from './index'

// scipy.stats 1.18.1: 2*t.sf(abs(t),df), fisher_exact(two-sided), linregress.
describe('tail probabilities', () => {
  it.each([
    [0.01, 1, 0.993634014470186],
    [2, 3, 0.13932596855884305],
    [8, 20, 1.165662827148851e-7],
    [20, 100.5, 8.150420229011446e-37],
  ])('matches independent t reference t=%s df=%s', (t, df, p) => {
    expect(studentTTwoSidedPValue(t, df) / p).toBeCloseTo(1, 11)
    expect(studentTTwoSidedPValue(-t, df)).toBe(studentTTwoSidedPValue(t, df))
  })
  it('matches the analytic Cauchy tail and retains extreme normal tails', () => {
    expect(studentTTwoSidedPValue(1, 1)).toBeCloseTo(0.5, 13)
    expect(normalTwoSidedPValue(0)).toBe(1)
    expect(normalTwoSidedPValue(10)).toBeGreaterThan(0)
    expect(normalTwoSidedPValue(Infinity)).toBe(0)
    expect(studentTTwoSidedPValue(Infinity, 3)).toBe(0)
  })
  it('refuses unavailable inputs', () => {
    expect(() => normalTwoSidedPValue(NaN)).toThrow()
    expect(() => studentTTwoSidedPValue(NaN, 2)).toThrow()
    for (const df of [0, -1, NaN, Infinity]) expect(() => studentTTwoSidedPValue(1, df)).toThrow()
    expect(() => chiSquaredPValue(-1)).toThrow()
  })
})

describe('contingency tables', () => {
  it.each([
    [1, 9, 11, 3, 0.0027594561852200836],
    [8, 2, 1, 5, 0.034965034965034975],
    [0, 5, 4, 1, 0.04761904761904762],
  ])('matches independent Fisher reference %s,%s,%s,%s', (a, b, c, d, p) => {
    expect(fisherExactTwoSided(a, b, c, d)).toBeCloseTo(p, 13)
    expect(fisherExactTwoSided(d, c, b, a)).toBeCloseTo(p, 13)
  })
  it('selects exact inference for sparse counts and Pearson for adequate counts', () => {
    expect(twoByTwoPValue(8, 2, 1, 5)).toBeCloseTo(0.034965034965034975, 13)
    // Expected cells are all 10: four squared deviations of 25/10 = 10.
    expect(chiSquared(15, 5, 5, 15)).toBe(10)
    expect(twoByTwoPValue(15, 5, 5, 15)).toBe(chiSquaredPValue(10))
    expect(twoByTwoPValue(0, 0, 0, 0)).toBe(1)
    expect(fisherExactTwoSided(0, 0, 2, 3)).toBe(1)
  })
  it('refuses negative, fractional and nonfinite observations', () => {
    for (const count of [-1, 1.5, NaN, Infinity])
      expect(() => twoByTwoPValue(count, 1, 2, 3)).toThrow()
  })
})

describe('linearRegressionSlope', () => {
  it('matches independent slope, squared correlation and tail', () => {
    const result = linearRegressionSlope([2, 4, 5, 4, 5].map((y, i) => ({ x: i + 1, y })))
    expect(result.slope).toBeCloseTo(0.6, 13)
    expect(result.rSquared).toBeCloseTo(0.6, 13)
    expect(result.slopePValue).toBeCloseTo(0.12402706265755467, 13)
  })
  it('preserves slopes under large offset and separates unavailable evidence', () => {
    expect(
      linearRegressionSlope([
        { x: 1e12, y: 1 },
        { x: 1e12 + 1, y: 3 },
        { x: 1e12 + 2, y: 5 },
      ]),
    ).toEqual({ slope: 2, rSquared: 1, slopePValue: 0 })
    expect(linearRegressionSlope([]).slopePValue).toBeNull()
    expect(
      linearRegressionSlope([
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ]).slopePValue,
    ).toBeNull()
    expect(
      linearRegressionSlope([
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 1, y: 3 },
      ]).slopePValue,
    ).toBeNull()
    expect(() => linearRegressionSlope([{ x: NaN, y: 1 }])).toThrow()
  })
})
