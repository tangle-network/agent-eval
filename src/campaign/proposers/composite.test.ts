import { describe, expect, it } from 'vitest'
import type { ProposeContext, SurfaceProposer } from '../types'
import { compositeProposer } from './composite'

function ctxOf(populationSize: number): ProposeContext {
  return {
    currentSurface: 'base',
    history: [],
    findings: [],
    populationSize,
    generation: 1,
    signal: new AbortController().signal,
  }
}

function stub(
  kind: string,
  surfaces: string[],
  opts?: { fail?: boolean; stop?: boolean },
): SurfaceProposer {
  return {
    kind,
    async propose(ctx) {
      if (opts?.fail) throw new Error(`${kind} exploded`)
      return surfaces
        .slice(0, ctx.populationSize)
        .map((s) => ({ surface: s, label: 'v', rationale: 'r' }))
    },
    ...(opts?.stop !== undefined
      ? { decide: () => ({ stop: opts.stop as boolean, reason: `${kind} vote` }) }
      : {}),
  }
}

describe('compositeProposer (N proposers, one generation pool)', () => {
  it('splits the population budget and merges candidates with member provenance', async () => {
    const composite = compositeProposer({
      proposers: [stub('gepa', ['g1', 'g2', 'g3']), stub('skill-opt', ['s1', 's2', 's3'])],
    })
    const pool = await composite.propose(ctxOf(4))
    expect(pool).toHaveLength(4)
    const labels = pool.map((c) => (c as { label: string }).label)
    expect(labels.filter((l) => l.startsWith('gepa:'))).toHaveLength(2)
    expect(labels.filter((l) => l.startsWith('skill-opt:'))).toHaveLength(2)
    expect(composite.kind).toBe('composite(gepa+skill-opt)')
  })

  it('weights shift the split (largest remainder, exact total)', async () => {
    const composite = compositeProposer({
      proposers: [stub('a', ['a1', 'a2', 'a3', 'a4', 'a5']), stub('b', ['b1', 'b2', 'b3'])],
      weights: [3, 1],
    })
    const pool = await composite.propose(ctxOf(4))
    const labels = pool.map((c) => (c as { label: string }).label)
    expect(labels.filter((l) => l.startsWith('a:'))).toHaveLength(3)
    expect(labels.filter((l) => l.startsWith('b:'))).toHaveLength(1)
  })

  it('dedupes identical surfaces across members (first member wins)', async () => {
    const composite = compositeProposer({
      proposers: [stub('a', ['same', 'a2']), stub('b', ['same', 'b2'])],
    })
    const pool = await composite.propose(ctxOf(4))
    const surfaces = pool.map((c) => (c as { surface: string }).surface)
    expect(surfaces.filter((s) => s === 'same')).toHaveLength(1)
    const sameLabel = (
      pool.find((c) => (c as { surface: string }).surface === 'same') as { label: string }
    ).label
    expect(sameLabel.startsWith('a:')).toBe(true)
  })

  it('isolates a failing member; throws only when ALL members fail', async () => {
    const oneDown = compositeProposer({
      proposers: [stub('boom', [], { fail: true }), stub('ok', ['x1', 'x2'])],
    })
    const pool = await oneDown.propose(ctxOf(2))
    expect(pool.length).toBeGreaterThanOrEqual(1)

    const allDown = compositeProposer({
      proposers: [stub('boom1', [], { fail: true }), stub('boom2', [], { fail: true })],
    })
    await expect(allDown.propose(ctxOf(2))).rejects.toThrow(/every member failed/)
  })

  it('stops only when every deciding member votes stop', () => {
    const mixed = compositeProposer({
      proposers: [
        stub('a', ['a1'], { stop: true }),
        stub('b', ['b1'], { stop: false }),
        stub('c', ['c1']),
      ],
    })
    expect(mixed.decide?.({ history: [] })).toEqual({ stop: false })

    const unanimous = compositeProposer({
      proposers: [stub('a', ['a1'], { stop: true }), stub('b', ['b1'], { stop: true })],
    })
    expect(unanimous.decide?.({ history: [] })?.stop).toBe(true)
  })

  it('fails loud on empty membership or bad weights', () => {
    expect(() => compositeProposer({ proposers: [] })).toThrow(/at least one/)
    expect(() => compositeProposer({ proposers: [stub('a', ['x'])], weights: [0] })).toThrow(
      /positive/,
    )
  })
})
