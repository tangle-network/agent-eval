import { describe, expect, it } from 'vitest'
import { pairedBootstrap, pairedWilcoxon, bhAdjust } from '../src/paired-stats'

describe('pairedBootstrap', () => {
  it('throws on unequal sample sizes — silent truncation hides bugs', () => {
    expect(() => pairedBootstrap([1, 2], [3])).toThrow(/unequal/)
  })

  it('returns the singleton on n=1', () => {
    const r = pairedBootstrap([0.5], [0.7], { seed: 42 })
    expect(r.n).toBe(1)
    expect(r.median).toBeCloseTo(0.2, 6)
    expect(r.low).toBeCloseTo(0.2, 6)
    expect(r.high).toBeCloseTo(0.2, 6)
  })

  it('returns zero on empty input rather than NaN', () => {
    const r = pairedBootstrap([], [])
    expect(r.n).toBe(0)
    expect(r.median).toBe(0)
    expect(r.low).toBe(0)
    expect(r.high).toBe(0)
  })

  it('produces a positive lower bound when after >> before', () => {
    const before = [0.1, 0.2, 0.15, 0.25, 0.18, 0.22, 0.19, 0.21]
    const after = before.map((b) => b + 0.3)
    const r = pairedBootstrap(before, after, { seed: 42, resamples: 1000 })
    expect(r.median).toBeCloseTo(0.3, 4)
    expect(r.low).toBeGreaterThan(0)
    expect(r.high).toBeGreaterThan(r.low)
  })

  it('CI straddles zero when there is no real shift', () => {
    const before = [0.5, 0.4, 0.6, 0.55, 0.45, 0.5, 0.6, 0.4]
    const after = [0.5, 0.4, 0.6, 0.55, 0.45, 0.5, 0.6, 0.4]
    const r = pairedBootstrap(before, after, { seed: 42, resamples: 1000 })
    expect(r.median).toBe(0)
    expect(r.low).toBeLessThanOrEqual(0)
    expect(r.high).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic given a seed', () => {
    const before = [0.3, 0.4, 0.5, 0.6, 0.4, 0.5]
    const after = [0.5, 0.5, 0.6, 0.7, 0.5, 0.55]
    const a = pairedBootstrap(before, after, { seed: 1234, resamples: 500 })
    const b = pairedBootstrap(before, after, { seed: 1234, resamples: 500 })
    expect(a.low).toBe(b.low)
    expect(a.high).toBe(b.high)
  })

  it('rejects out-of-range confidence', () => {
    expect(() => pairedBootstrap([1], [2], { confidence: 0 })).toThrow()
    expect(() => pairedBootstrap([1], [2], { confidence: 1 })).toThrow()
  })

  it('mean statistic agrees with arithmetic mean of deltas in expectation', () => {
    const before = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
    const after = before.map((b) => b + 0.25)
    const r = pairedBootstrap(before, after, { seed: 7, resamples: 2000, statistic: 'mean' })
    expect(r.mean).toBeCloseTo(0.25, 4)
    // Lower bound should still clear 0 even though we're using the mean.
    expect(r.low).toBeGreaterThan(0)
  })
})

describe('pairedWilcoxon', () => {
  it('matches wilcoxonSignedRank exactly (alias)', () => {
    const before = [0.4, 0.5, 0.6, 0.7, 0.4, 0.5, 0.6, 0.7]
    const after = before.map((b) => b + 0.3)
    const r = pairedWilcoxon(before, after)
    expect(r.p).toBeLessThan(0.05)
    expect(r.w).toBeGreaterThan(0)
  })
})

describe('bhAdjust', () => {
  it('returns the same q-values as benjaminiHochberg (alias)', () => {
    const ps = [0.001, 0.01, 0.04, 0.5]
    const r = bhAdjust(ps, 0.05)
    expect(r.qValues).toHaveLength(4)
    expect(r.significant[0]).toBe(true)
    expect(r.significant[3]).toBe(false)
  })

  it('handles empty input', () => {
    const r = bhAdjust([])
    expect(r.qValues).toEqual([])
    expect(r.significant).toEqual([])
  })
})
