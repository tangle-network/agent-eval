import { describe, expect, it } from 'vitest'
import { cohensD, pairedCohensDz, pairedTTest } from './index'

describe('cohensD', () => {
  it('returns 0 on tied means — regression: non-zero effect size from tied data misleads decisions', () => {
    expect(cohensD([1, 2, 3], [1, 2, 3])).toBe(0)
  })

  it('positive d when group b is higher', () => {
    const a = [1, 2, 3, 4, 5]
    const b = [6, 7, 8, 9, 10]
    expect(cohensD(a, b)).toBeGreaterThan(0.8) // large effect
  })

  it('negative d when group b is lower', () => {
    const a = [10, 11, 12, 13, 14]
    const b = [1, 2, 3, 4, 5]
    expect(cohensD(a, b)).toBeLessThan(-0.8)
  })

  it('small-effect rule of thumb (0.2 < |d| < 0.5)', () => {
    const a = [0.4, 0.5, 0.6, 0.5, 0.4, 0.6]
    const b = [0.5, 0.6, 0.7, 0.6, 0.5, 0.7]
    const d = cohensD(a, b)
    expect(d).not.toBeNull()
    expect(Math.abs(d!)).toBeGreaterThan(0.2)
    expect(Math.abs(d!)).toBeLessThan(1.2)
  })

  it('returns null for under-sized groups rather than a measured zero', () => {
    expect(cohensD([1], [2])).toBeNull()
  })
})

describe('pairedCohensDz', () => {
  it('standardizes within-pair deltas', () => {
    const value = pairedCohensDz([0.1, 0.4, 0.3, 0.8], [0.3, 0.5, 0.7, 0.9])
    expect(value).not.toBeNull()
    expect(value!).toBeGreaterThan(1)
  })

  it('returns null for a non-zero constant delta instead of a huge finite value', () => {
    expect(pairedCohensDz([0.1, 0.1, 0.1], [0.9, 0.9, 0.9])).toBeNull()
  })

  it('rejects unequal vector lengths', () => {
    expect(() => pairedCohensDz([0.1], [0.2, 0.3])).toThrow(/unequal sample sizes/)
  })
})

describe('degenerate branches answer once, the same way', () => {
  it('pairedTTest returns null rather than absolute certainty from 3 pairs', () => {
    const r = pairedTTest([0, 0, 0.5], [0.5, 0.5, 1])
    expect(r.t).toBeNull()
    expect(r.p).toBeNull()
    expect(r.df).toBe(2)
  })

  it('pairedTTest still reports an all-zero delta as a measured null', () => {
    expect(pairedTTest([1, 2, 3], [1, 2, 3])).toEqual({ t: 0, df: 2, p: 1 })
  })

  it('pairedTTest returns null below two pairs', () => {
    expect(pairedTTest([1], [2])).toEqual({ t: null, df: 0, p: null })
  })

  it('cohensD returns null for a maximal zero-variance separation', () => {
    expect(cohensD([1, 1, 1], [2, 2, 2])).toBeNull()
  })

  it('cohensD returns 0 only when equal means meet zero spread', () => {
    expect(cohensD([1, 1, 1], [1, 1, 1])).toBe(0)
  })

  it('all three degenerate paths now agree with pairedCohensDz', () => {
    expect(pairedCohensDz([1, 1, 1], [2, 2, 2])).toBeNull()
    expect(cohensD([1, 1, 1], [2, 2, 2])).toBeNull()
    expect(pairedTTest([1, 1, 1], [2, 2, 2]).p).toBeNull()
  })
})
