import { describe, expect, it } from 'vitest'
import { Dataset, HoldoutLockedError, hashScenarios } from '../src/dataset'

function baseProvenance() {
  return { version: '1.0.0', createdAt: '2026-04-20T00:00:00Z' }
}

describe('Dataset', () => {
  it('slice filters by split + difficulty', () => {
    const d = new Dataset({
      name: 'test',
      provenance: baseProvenance(),
      scenarios: [
        { id: 'a', payload: {}, split: 'train', difficulty: 'easy' },
        { id: 'b', payload: {}, split: 'test', difficulty: 'hard' },
        { id: 'c', payload: {}, split: 'test', difficulty: 'easy' },
      ],
    })
    expect(d.slice({ split: 'test' })).toHaveLength(2)
    expect(d.slice({ split: 'test', difficulty: 'easy' })).toHaveLength(1)
  })

  it('holdouts are excluded by default — regression: leaking holdout into dev is the whole bug class', () => {
    const d = new Dataset({
      name: 'x',
      provenance: baseProvenance(),
      scenarios: [
        { id: 'a', payload: {}, split: 'train' },
        { id: 'b', payload: {}, split: 'holdout' },
      ],
    })
    expect(d.slice()).toHaveLength(1)
    expect(d.slice({ includeHoldout: true })).toHaveLength(2)
  })

  it('seeded slice is deterministic across runs', () => {
    const d = new Dataset({
      name: 'x',
      provenance: baseProvenance(),
      scenarios: Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, payload: i })),
    })
    const a = d.slice({ limit: 5, seed: 42 }).map((s) => s.id)
    const b = d.slice({ limit: 5, seed: 42 }).map((s) => s.id)
    const c = d.slice({ limit: 5, seed: 99 }).map((s) => s.id)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('limit without seed throws — regression: silent non-determinism breaks reproducibility', () => {
    const d = new Dataset({
      name: 'x',
      provenance: baseProvenance(),
      scenarios: Array.from({ length: 5 }, (_, i) => ({ id: `id-${i}`, payload: i })),
    })
    expect(() => d.slice({ limit: 2 })).toThrow(/seed is required/)
  })

  it('lock prevents mutation', () => {
    const d = new Dataset({ name: 'x', provenance: baseProvenance(), scenarios: [] })
    d.lock()
    expect(() => d.add({ id: 'new', payload: {} })).toThrow(HoldoutLockedError)
  })

  it('manifest content hash is stable for same scenarios', async () => {
    const sc = [
      { id: 'b', payload: { q: 1 } },
      { id: 'a', payload: { q: 2 } },
    ]
    const a = await hashScenarios(sc)
    const b = await hashScenarios(sc.slice().reverse())
    expect(a).toBe(b) // order-independent via sort
  })

  it('jsonl round-trip preserves ordering', () => {
    const d = new Dataset({
      name: 'x',
      provenance: baseProvenance(),
      scenarios: [
        { id: 'b', payload: 1 },
        { id: 'a', payload: 2 },
      ],
    })
    const jsonl = d.toJsonl()
    const d2 = Dataset.fromJsonl(jsonl, { name: 'x', provenance: baseProvenance() })
    expect(d2.all().map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('rejects duplicate id on add', () => {
    const d = new Dataset({
      name: 'x',
      provenance: baseProvenance(),
      scenarios: [{ id: 'a', payload: {} }],
    })
    expect(() => d.add({ id: 'a', payload: {} })).toThrow(/duplicate/)
  })
})
