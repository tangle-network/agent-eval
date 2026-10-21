import { describe, expect, it } from 'vitest'
import { partitionHeldOut } from './partition-held-out'



describe('partitionHeldOut', () => {
  it('produces disjoint, exhaustive search/holdout sets', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `s${i}`)
    const { search, holdout } = partitionHeldOut(ids)
    expect(search.length + holdout.length).toBe(ids.length)
    expect(new Set([...search, ...holdout]).size).toBe(ids.length)
    expect(search.some((s) => holdout.includes(s))).toBe(false)
  })

  it('is reproducible — same ids+seed give the same partition', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `s${i}`)
    const a = partitionHeldOut(ids, { seed: 'fix' })
    const b = partitionHeldOut([...ids].reverse(), { seed: 'fix' })
    expect(new Set(a.holdout)).toEqual(new Set(b.holdout))
  })

  it('fails loud on duplicate ids', () => {
    expect(() => partitionHeldOut(['a', 'b', 'a'])).toThrow(/duplicate/)
  })

  it('fails loud on empty input', () => {
    expect(() => partitionHeldOut([])).toThrow(/no ids/)
  })

  it('fails loud when the holdout set is below the significance floor', () => {
    // tiny corpus + a high floor → cannot satisfy minHoldout
    expect(() => partitionHeldOut(['a', 'b'], { minHoldout: 5 })).toThrow(/holdout set/)
  })

  it('rejects an out-of-range holdoutFraction', () => {
    expect(() => partitionHeldOut(['a'], { holdoutFraction: 0 })).toThrow(/holdoutFraction/)
    expect(() => partitionHeldOut(['a'], { holdoutFraction: 1 })).toThrow(/holdoutFraction/)
  })
})


