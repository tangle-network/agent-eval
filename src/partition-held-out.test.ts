import { describe, expect, it } from 'vitest'
import {
  assignHeldOutTag,
  hashToUnit,
  partitionHeldOut,
  partitionTrainSelectionTest,
} from './partition-held-out'

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

describe('partitionTrainSelectionTest', () => {
  const runs = (tasks: number, perTask: number) =>
    Array.from({ length: tasks * perTask }, (_, i) => ({
      id: `task-${Math.floor(i / perTask)}.run-${i % perTask}`,
      task: `task-${Math.floor(i / perTask)}`,
    }))

  it('returns three pairwise disjoint partitions that cover every item', () => {
    const items = runs(60, 1)
    const { train, selection, test } = partitionTrainSelectionTest(items)
    const ids = [...train, ...selection, ...test].map((item) => item.id)
    expect(new Set(ids).size).toBe(items.length)
    expect(ids.length).toBe(items.length)
    expect(train.length).toBeGreaterThan(0)
    expect(selection.length).toBeGreaterThan(0)
    expect(test.length).toBeGreaterThan(0)
  })

  it('keeps every item of one unit in one partition', () => {
    const items = runs(40, 3)
    const partition = partitionTrainSelectionTest(items, { unitOf: (item) => item.task })
    const owner = new Map<string, string>()
    for (const name of ['train', 'selection', 'test'] as const) {
      for (const item of partition[name]) {
        expect(owner.get(item.task) ?? name).toBe(name)
        owner.set(item.task, name)
      }
    }
  })

  it('assigns a unit by its own hash, so adding units never moves an existing one', () => {
    const before = partitionTrainSelectionTest(runs(30, 1), { seed: 'fixed' })
    const after = partitionTrainSelectionTest(runs(90, 1), { seed: 'fixed' })
    const name = (p: typeof before, id: string) =>
      p.train.some((i) => i.id === id)
        ? 'train'
        : p.selection.some((i) => i.id === id)
          ? 'selection'
          : 'test'
    for (const item of runs(30, 1)) expect(name(after, item.id)).toBe(name(before, item.id))
  })

  it('is deterministic, keeps input order, and a new seed reshuffles', () => {
    const items = runs(80, 1)
    const a = partitionTrainSelectionTest(items, { seed: 'v1' })
    const b = partitionTrainSelectionTest(items, { seed: 'v1' })
    expect(a).toEqual(b)
    expect(a.train.map((item) => items.indexOf(item))).toEqual(
      [...a.train.map((item) => items.indexOf(item))].sort((x, y) => x - y),
    )
    expect(partitionTrainSelectionTest(items, { seed: 'v2' }).test).not.toEqual(a.test)
  })

  it('routes shares close to the requested fractions', () => {
    const { train, selection, test } = partitionTrainSelectionTest(runs(2000, 1), {
      selectionFraction: 0.2,
      testFraction: 0.3,
    })
    expect(test.length / 2000).toBeGreaterThan(0.25)
    expect(test.length / 2000).toBeLessThan(0.35)
    expect(selection.length / 2000).toBeGreaterThan(0.15)
    expect(selection.length / 2000).toBeLessThan(0.25)
    expect(train.length / 2000).toBeGreaterThan(0.45)
  })

  it('fails loud on inputs that cannot support three disjoint partitions', () => {
    expect(() => partitionTrainSelectionTest([])).toThrow(/no items/)
    expect(() => partitionTrainSelectionTest([{ id: 'a' }, { id: 'a' }])).toThrow(/duplicate/)
    expect(() => partitionTrainSelectionTest([{ id: '' }])).toThrow(/non-empty/)
    expect(() => partitionTrainSelectionTest([{ id: 'a' }], { unitOf: () => '' })).toThrow(
      /no unit/,
    )
    expect(() => partitionTrainSelectionTest(runs(10, 1), { testFraction: 0 })).toThrow(
      /testFraction/,
    )
    expect(() => partitionTrainSelectionTest(runs(10, 1), { selectionFraction: 1 })).toThrow(
      /selectionFraction/,
    )
    expect(() =>
      partitionTrainSelectionTest(runs(10, 1), { selectionFraction: 0.5, testFraction: 0.5 }),
    ).toThrow(/below 1/)
    expect(() =>
      partitionTrainSelectionTest(runs(3, 4), { unitOf: (item) => item.task, minTest: 5 }),
    ).toThrow(/floor/)
  })

  it('refuses one unit spread across partitions by construction: a single unit fills one partition only', () => {
    expect(() => partitionTrainSelectionTest(runs(1, 6), { unitOf: (item) => item.task })).toThrow(
      /floor/,
    )
  })
})
