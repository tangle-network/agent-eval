import { describe, expect, it } from 'vitest'
import type { CodeSurface, ProposeContext, SurfaceProposer } from '../types'
import { compositeProposer } from './composite'
import { parameterSweepProposer } from './fapo'

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

function codeSurface(worktreeRef: string): CodeSurface {
  return {
    kind: 'code',
    worktreeRef,
    baseRef: 'main',
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    candidateCommit: '3'.repeat(40),
    candidateTree: '4'.repeat(40),
    patch: {
      format: 'git-diff-binary',
      sha256: `sha256:${'5'.repeat(64)}`,
      byteLength: 1,
    },
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

  it('dedupes content-identical code surfaces across different worktree paths', async () => {
    const proposer = (kind: string, surface: CodeSurface): SurfaceProposer => ({
      kind,
      propose: async () => [{ surface, label: 'v', rationale: 'r' }],
    })
    const first = codeSurface('/tmp/candidate-a')
    const sameBytesElsewhere = codeSurface('/tmp/candidate-b')
    const composite = compositeProposer({
      proposers: [proposer('a', first), proposer('b', sameBytesElsewhere)],
    })

    const pool = await composite.propose(ctxOf(2))

    expect(pool).toHaveLength(1)
    expect((pool[0] as { surface: CodeSurface }).surface.worktreeRef).toBe(first.worktreeRef)
  })

  it('lets stateful members recognize their own prior labels', async () => {
    const composite = compositeProposer({
      proposers: [
        parameterSweepProposer({
          candidates: [
            { label: 'low', rationale: 'try low', patch: { effort: 'low' } },
            { label: 'high', rationale: 'try high', patch: { effort: 'high' } },
          ],
        }),
      ],
    })
    const first = await composite.propose({
      ...ctxOf(1),
      currentSurface: '{"effort":"medium"}',
    })
    const firstCandidate = first[0] as { surface: string; label: string; rationale: string }
    const second = await composite.propose({
      ...ctxOf(2),
      currentSurface: '{"effort":"medium"}',
      history: [
        {
          generationIndex: 0,
          promoted: [],
          candidates: [
            {
              surfaceHash: 'first',
              label: firstCandidate.label,
              rationale: firstCandidate.rationale,
              composite: 0.5,
              ci95: [0.5, 0.5],
              dimensions: {},
              scenarios: [],
            },
          ],
        },
      ],
    })

    expect(firstCandidate.label).toBe('parameter-sweep:low')
    expect(second).toHaveLength(1)
    expect((second[0] as { label: string }).label).toBe('parameter-sweep:high')
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

  it('restores member labels before asking members whether to stop', () => {
    let observedLabel: string | undefined
    const member: SurfaceProposer = {
      kind: 'stateful',
      propose: async () => [],
      decide: ({ history }) => {
        observedLabel = history[0]?.candidates[0]?.label
        return { stop: true }
      },
    }
    const composite = compositeProposer({ proposers: [member] })

    composite.decide?.({
      history: [
        {
          generationIndex: 0,
          promoted: [],
          candidates: [
            {
              surfaceHash: 'first',
              label: 'stateful:attempt-1',
              composite: 0.5,
              ci95: [0.5, 0.5],
              dimensions: {},
              scenarios: [],
            },
          ],
        },
      ],
    })

    expect(observedLabel).toBe('attempt-1')
  })

  it('rejects member kinds that make history ownership ambiguous', () => {
    expect(() =>
      compositeProposer({ proposers: [stub('same', ['a']), stub('same', ['b'])] }),
    ).toThrow(/duplicate member kind 'same'/)
    expect(() => compositeProposer({ proposers: [stub('a:b', ['a'])] })).toThrow(
      /must not contain ':'/,
    )
    expect(() => compositeProposer({ proposers: [stub(' spaced ', ['a'])] })).toThrow(
      /trimmed and non-empty/,
    )
  })

  it('fails loud on empty membership or bad weights', () => {
    expect(() => compositeProposer({ proposers: [] })).toThrow(/at least one/)
    expect(() => compositeProposer({ proposers: [stub('a', ['x'])], weights: [0] })).toThrow(
      /finite and positive/,
    )
    expect(() =>
      compositeProposer({ proposers: [stub('a', ['x'])], weights: [Number.POSITIVE_INFINITY] }),
    ).toThrow(/finite and positive/)
    expect(() =>
      compositeProposer({ proposers: [stub('a', ['x'])], weights: [Number.NaN] }),
    ).toThrow(/finite and positive/)
  })
})
