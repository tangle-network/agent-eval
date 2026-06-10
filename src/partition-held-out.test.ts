import { describe, expect, it } from 'vitest'
import { assignHeldOutTag, hashToUnit, partitionHeldOut } from './partition-held-out'

describe('assignHeldOutTag', () => {
  it('is deterministic for the same (id, seed)', () => {
    const a = assignHeldOutTag('scenario-1')
    const b = assignHeldOutTag('scenario-1')
    expect(a).toBe(b)
  })

  it('a different seed can reshuffle assignment', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `s${i}`)
    const v1 = ids.map((id) => assignHeldOutTag(id, { seed: 'v1' }))
    const v2 = ids.map((id) => assignHeldOutTag(id, { seed: 'v2' }))
    expect(v1).not.toEqual(v2)
  })

  it('holdoutFraction shifts the holdout share monotonically', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `s${i}`)
    const share = (f: number) =>
      ids.filter((id) => assignHeldOutTag(id, { holdoutFraction: f }) === 'holdout').length /
      ids.length
    expect(share(0.2)).toBeLessThan(share(0.8))
    expect(share(0.5)).toBeGreaterThan(0.4)
    expect(share(0.5)).toBeLessThan(0.6)
  })
})

describe('hashToUnit', () => {
  it('stays in [0, 1) and is stable across calls', () => {
    for (const id of ['a', 'bb', 'ccc', 'scenario-42']) {
      const u = hashToUnit(id, 'seed')
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
      expect(hashToUnit(id, 'seed')).toBe(u)
    }
  })
})

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
