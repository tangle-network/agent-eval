import { describe, expect, it } from 'vitest'
import { welchsTTest } from '../baseline'
import { sampleMedian, summarizeSample } from './index'

// Independent references generated with scipy.stats 1.18.1, equal_var=False.
// The sign here is B minus A; SciPy's ttest_ind reports A minus B.
const references = [
  { a: [0, 2], b: [-1, 1, 3], t: 0, df: 2.8823529411764697, p: 1 },
  { a: [1, 2, 3, 4, 5], b: [2, 3, 4, 5, 6], t: 1, df: 8, p: 0.34659350708733416 },
  { a: [2, 2, 2], b: [1, 2, 4, 8], t: 1.1306019943221477, df: 3, p: 0.34044169358612675 },
  {
    a: [0, 1, 2],
    b: [5, 5, 6, 7, 9],
    t: 5.713299488454646,
    df: 5.957531519575316,
    p: 0.0012758630082228743,
  },
]

describe('welchsTTest', () => {
  it.each(references)('matches independent Welch reference $t', ({ a, b, t, df, p }) => {
    const result = welchsTTest(a, b)
    expect(result.status).toBe('ok')
    expect(result.t).toBeCloseTo(t, 12)
    expect(result.df).toBeCloseTo(df, 12)
    expect(result.p).toBeCloseTo(p, 12)
    const reverse = welchsTTest(b, a)
    expect(reverse.t).toBeCloseTo(-t, 12)
    expect(reverse.p).toBeCloseTo(p, 12)
  })
  it('retains a real mean gap when zero variance makes inference unavailable', () => {
    const result = welchsTTest([1, 1, 1], [2, 2, 2])
    expect(result).toMatchObject({ status: 'zero-variance', delta: 1, ci95: null, cohensD: null })
    expect(result.p).toBeNaN()
    expect(result.df).toBeNaN()
    expect(result.t).toBe(Infinity)
    expect(welchsTTest([1, 1], [1, 1]).status).toBe('zero-variance')
  })
  it('separates empty and singleton observations from measured inference', () => {
    const empty = welchsTTest([], [1, 2])
    expect(empty.status).toBe('insufficient-sample')
    expect(empty.delta).toBeNaN()
    expect(empty.p).toBeNaN()
    expect(welchsTTest([1], [3])).toMatchObject({
      status: 'insufficient-sample',
      delta: 2,
      ci95: null,
    })
  })
  it('preserves extreme tails and avoids squaring already-large variances', () => {
    const ordinary = welchsTTest([1, 2, 3, 4, 5], [2, 3, 4, 5, 6])
    const large = welchsTTest(
      [1, 2, 3, 4, 5].map((v) => v * 1e100),
      [2, 3, 4, 5, 6].map((v) => v * 1e100),
    )
    expect(large.df).toBeCloseTo(ordinary.df, 12)
    expect(large.p).toBeCloseTo(ordinary.p, 12)
    expect(welchsTTest([0, 1, 2], [1e5, 1e5 + 1, 1e5 + 2]).p).toBeGreaterThan(0)
  })
  it('refuses nonfinite inputs and arithmetic overflow', () => {
    expect(() => welchsTTest([NaN, 1], [1, 2])).toThrow(/finite/)
    expect(() => welchsTTest([1, 2], [Infinity, 2])).toThrow(/finite/)
    expect(() => welchsTTest([-1e308, 1e308], [1, 2])).toThrow(/finite range/)
  })
})

describe('summarizeSample', () => {
  it('keeps empty measurements absent', () => {
    expect(summarizeSample([])).toBeNull()
    expect(sampleMedian([])).toBeNull()
  })
  it('matches elementary sample facts and unbiased SciPy moments', () => {
    const summary = summarizeSample([1, 2, 3, 4, 5])!
    expect(summary).toMatchObject({
      n: 5,
      median: 3,
      mean: 3,
      q1: 2,
      q3: 4,
      iqr: 2,
      min: 1,
      max: 5,
      range: 4,
      mad: 1,
      outliers: [],
    })
    expect(summary.stddev).toBeCloseTo(Math.sqrt(2.5), 13)
    expect(summary.skewness).toBeCloseTo(0, 12)
    expect(summary.kurtosis).toBeCloseTo(-1.2, 12)
  })
  it('does not fabricate relative dispersion or moments', () => {
    expect(summarizeSample([0, 0])).toMatchObject({
      cv: null,
      skewness: null,
      kurtosis: null,
      medianInterval: null,
    })
    expect(summarizeSample([42])).toMatchObject({
      median: 42,
      stddev: 0,
      medianInterval: null,
    })
    expect(sampleMedian([4, 1, 3, 2])).toBe(2.5)
  })
  it('uses explicit seeded resampling without mutating the population', () => {
    const input = [1, 4, 9, 16, 25, 36, 49]
    const original = [...input]
    const first = summarizeSample(input, { seed: 0, resamples: 1000 })!
    expect(first).toEqual(summarizeSample(input, { seed: 0, resamples: 1000 }))
    expect(input).toEqual(original)
    const narrow = summarizeSample(input, { seed: 0, resamples: 1000, confidence: 0.5 })!
    expect(narrow.medianInterval!.low).toBeGreaterThanOrEqual(first.medianInterval!.low)
    expect(narrow.medianInterval!.high).toBeLessThanOrEqual(first.medianInterval!.high)
    expect(summarizeSample(input)).toEqual(summarizeSample(input))
  })
  it('keeps finite medians and bootstrap bounds when summing middle values would overflow', () => {
    expect(sampleMedian([1e308, 1e308])).toBe(1e308)
    const summary = summarizeSample([1e308, 1e308, 1e308, 1e308], { resamples: 10 })!
    expect(summary.medianInterval).toMatchObject({ low: 1e308, high: 1e308 })
  })
  it('retains outlier observations rather than deleting them', () => {
    expect(summarizeSample([1, 2, 3, 4, 5, 100])!.outliers).toEqual([100])
  })
  it('validates confidence, sample values, seed and resample count', () => {
    for (const confidence of [0, 1, NaN])
      expect(() => summarizeSample([], { confidence })).toThrow()
    for (const resamples of [0, -1, 1.5, Infinity])
      expect(() => summarizeSample([], { resamples })).toThrow()
    expect(() => summarizeSample([1, NaN])).toThrow(/finite/)
    expect(() => sampleMedian([Infinity])).toThrow(/finite/)
    expect(() => summarizeSample([1], { seed: NaN })).toThrow(/finite/)
  })
})
