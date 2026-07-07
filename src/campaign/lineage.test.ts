import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  callbackGovernor,
  fsLineageStore,
  type GovernorContext,
  type GovernorOp,
  heuristicGovernor,
  Lineage,
  lineageNodeId,
  memLineageStore,
  runLineage,
} from './lineage'

describe('lineageNodeId', () => {
  it('is deterministic and order-insensitive on parents', () => {
    const a = lineageNodeId({ parentIds: ['x', 'y'], track: 't', surface: 's', proposer: 'gepa' })
    const b = lineageNodeId({ parentIds: ['y', 'x'], track: 't', surface: 's', proposer: 'gepa' })
    expect(a).toBe(b)
  })

  it('changes when parents or surface change', () => {
    const base = lineageNodeId({ parentIds: ['x'], track: 't', surface: 's', proposer: 'gepa' })
    expect(base).not.toBe(
      lineageNodeId({ parentIds: ['z'], track: 't', surface: 's', proposer: 'gepa' }),
    )
    expect(base).not.toBe(
      lineageNodeId({ parentIds: ['x'], track: 't', surface: 's2', proposer: 'gepa' }),
    )
  })
})

describe('Lineage.addNode', () => {
  it('assigns monotone seq and derives generation from parents', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 'a', surface: 'r', score: 0, proposer: 'seed' })
    const child = l.addNode({
      parentIds: [root.id],
      track: 'a',
      surface: 'c',
      score: 1,
      proposer: 'gepa',
    })
    expect(root.seq).toBe(0)
    expect(child.seq).toBe(1)
    expect(root.generation).toBe(0)
    expect(child.generation).toBe(1)
  })

  it('throws on an unknown parent', () => {
    const l = new Lineage()
    expect(() =>
      l.addNode({ parentIds: ['nope'], track: 'a', surface: 's', score: 0, proposer: 'gepa' }),
    ).toThrow(/unknown parent/)
  })

  it('is idempotent: re-adding an identical node returns the original', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 'a', surface: 'r', score: 0, proposer: 'seed' })
    const again = l.addNode({ parentIds: [], track: 'a', surface: 'r', score: 0, proposer: 'seed' })
    expect(again.id).toBe(root.id)
    expect(again.seq).toBe(root.seq)
    expect(l.all()).toHaveLength(1)
  })

  it('is acyclic by construction: a child cannot point at a not-yet-added node', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 'a', surface: 'r', score: 0, proposer: 'seed' })
    // The id a future child WOULD get — not yet in the graph. Trying to parent a
    // node on it (a back-edge) fails with unknown-parent: this is exactly the
    // structural guarantee that no cycle can form.
    const futureChildId = lineageNodeId({
      parentIds: [root.id],
      track: 'a',
      surface: 'c',
      proposer: 'gepa',
    })
    expect(() =>
      l.addNode({
        parentIds: [futureChildId],
        track: 'a',
        surface: 'x',
        score: 1,
        proposer: 'gepa',
      }),
    ).toThrow(/unknown parent/)
  })

  it('no node has an ancestor that is also a descendant (acyclic invariant)', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 't', surface: 'r', score: 0, proposer: 'seed' })
    const a = l.addNode({ parentIds: [root.id], track: 't', surface: 'a', score: 1, proposer: 'g' })
    const b = l.addNode({ parentIds: [root.id], track: 't', surface: 'b', score: 1, proposer: 'g' })
    const m = l.merge({ parentIds: [a.id, b.id], track: 't', surface: 'm', score: 2 })
    for (const n of [root, a, b, m]) {
      const anc = l.ancestors(n.id)
      const desc = l.descendants(n.id)
      expect([...anc].filter((x) => desc.has(x))).toEqual([])
    }
  })

  it('ancestors/descendants terminate on hand-corrupted cyclic input (visited-set safety)', () => {
    // Deserialization of corrupt data could contain a cycle; traversal must not hang.
    const cyclic = new Lineage([
      {
        id: 'x',
        parentIds: ['y'],
        track: 't',
        surface: 'x',
        score: 0,
        proposer: 'p',
        generation: 0,
        seq: 0,
      },
      {
        id: 'y',
        parentIds: ['x'],
        track: 't',
        surface: 'y',
        score: 0,
        proposer: 'p',
        generation: 0,
        seq: 1,
      },
    ])
    expect(cyclic.ancestors('x')).toEqual(new Set(['y', 'x']))
    expect(cyclic.descendants('x')).toEqual(new Set(['y', 'x']))
  })
})

describe('Lineage.merge + diamond shape', () => {
  it('a merge has all parents; generation = max(parent)+1; ancestors cover all parents', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 't', surface: 'r', score: 0, proposer: 'seed' })
    const a = l.addNode({ parentIds: [root.id], track: 't', surface: 'a', score: 1, proposer: 'g' })
    const b = l.addNode({ parentIds: [root.id], track: 't', surface: 'b', score: 1, proposer: 'g' })
    const m = l.merge({ parentIds: [a.id, b.id], track: 't', surface: 'm', score: 2 })

    expect(m.parentIds.sort()).toEqual([a.id, b.id].sort())
    expect(m.proposer).toBe('merge')
    expect(m.generation).toBe(2)
    expect(l.ancestors(m.id)).toEqual(new Set([root.id, a.id, b.id]))
    expect(l.tips().map((n) => n.id)).toEqual([m.id])
    expect(l.descendants(root.id)).toEqual(new Set([a.id, b.id, m.id]))
  })

  it('throws when a merge has fewer than 2 parents', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 't', surface: 'r', score: 0, proposer: 'seed' })
    expect(() => l.merge({ parentIds: [root.id], track: 't', surface: 'm', score: 1 })).toThrow(
      />= 2 parents/,
    )
  })
})

describe('Lineage.frontier', () => {
  it('scalar-score frontier keeps only the best tip', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 't', surface: 'r', score: 0, proposer: 'seed' })
    l.addNode({ parentIds: [root.id], track: 'a', surface: 'a', score: 0.4, proposer: 'g' })
    l.addNode({ parentIds: [root.id], track: 'b', surface: 'b', score: 0.9, proposer: 'g' })
    const frontier = l.frontier()
    expect(frontier).toHaveLength(1)
    expect(frontier[0]!.surface).toBe('b')
  })

  it('Pareto frontier by scoreVector excludes a dominated tip', () => {
    const l = new Lineage()
    const root = l.addNode({
      parentIds: [],
      track: 't',
      surface: 'r',
      score: 0,
      proposer: 'seed',
      scoreVector: [0, 0],
    })
    // Two non-dominated (trade off across the two scenarios) + one dominated.
    const hi1 = l.addNode({
      parentIds: [root.id],
      track: 'a',
      surface: 'hi1',
      score: 1,
      proposer: 'g',
      scoreVector: [1, 0.2],
    })
    const hi2 = l.addNode({
      parentIds: [root.id],
      track: 'b',
      surface: 'hi2',
      score: 1,
      proposer: 'g',
      scoreVector: [0.2, 1],
    })
    const dominated = l.addNode({
      parentIds: [root.id],
      track: 'c',
      surface: 'dom',
      score: 1,
      proposer: 'g',
      scoreVector: [0.1, 0.1],
    })
    const ids = l
      .frontier()
      .map((n) => n.id)
      .sort()
    expect(ids).toEqual([hi1.id, hi2.id].sort())
    expect(ids).not.toContain(dominated.id)
  })
})

describe('persistence', () => {
  it('toJSONL/fromJSONL round-trips the graph exactly', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 't', surface: 'r', score: 0, proposer: 'seed' })
    const a = l.addNode({ parentIds: [root.id], track: 't', surface: 'a', score: 1, proposer: 'g' })
    const b = l.addNode({ parentIds: [root.id], track: 'u', surface: 'b', score: 1, proposer: 'g' })
    l.merge({ parentIds: [a.id, b.id], track: 't', surface: 'm', score: 2 })
    const restored = Lineage.fromJSONL(l.toJSONL())
    expect(restored.toGraph()).toEqual(l.toGraph())
  })

  it('fsLineageStore appends and reloads in a tmp dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lineage-'))
    const path = join(dir, 'nested', 'lineage.jsonl')
    const store = fsLineageStore(path)
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 't', surface: 'r', score: 0, proposer: 'seed' })
    await store.append(root)
    const child = l.addNode({
      parentIds: [root.id],
      track: 't',
      surface: 'c',
      score: 1,
      proposer: 'g',
    })
    await store.append(child)

    const reloaded = await store.load()
    expect(reloaded.all().map((n) => n.id)).toEqual([root.id, child.id])
    // The file is real JSONL.
    const raw = await readFile(path, 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(2)
  })

  it('memLineageStore round-trips', async () => {
    const store = memLineageStore()
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 't', surface: 'r', score: 0, proposer: 'seed' })
    await store.append(root)
    const reloaded = await store.load()
    expect(reloaded.all()).toHaveLength(1)
  })
})

describe('heuristicGovernor', () => {
  function ctx(
    lineage: Lineage,
    prunedTracks: string[] = [],
    budgetRemaining = 10,
  ): GovernorContext {
    return { lineage, step: 0, budgetRemaining, prunedTracks }
  }

  it('extends a single climbing track', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 'a', surface: 'r', score: 0, proposer: 'g' })
    l.addNode({ parentIds: [root.id], track: 'a', surface: 'c', score: 0.5, proposer: 'g' })
    const gov = heuristicGovernor()
    expect(gov.decide(ctx(l))).toEqual({ op: 'extend', track: 'a' })
  })

  it('proposes a merge when >= 2 distinct-track frontier tips exist', () => {
    const l = new Lineage()
    const root = l.addNode({ parentIds: [], track: 't', surface: 'r', score: 0, proposer: 'seed' })
    l.addNode({
      parentIds: [root.id],
      track: 'a',
      surface: 'a',
      score: 1,
      proposer: 'g',
      scoreVector: [1, 0.2],
    })
    l.addNode({
      parentIds: [root.id],
      track: 'b',
      surface: 'b',
      score: 1,
      proposer: 'g',
      scoreVector: [0.2, 1],
    })
    const op = heuristicGovernor().decide(ctx(l)) as Extract<GovernorOp, { op: 'merge' }>
    expect(op.op).toBe('merge')
    expect(op.parentIds).toHaveLength(2)
  })

  it('prunes a plateaued track when another track remains', () => {
    const l = new Lineage()
    // Track a plateaus (0.5, 0.5, 0.5); track b keeps a live tip so pruning a is safe.
    const ra = l.addNode({ parentIds: [], track: 'a', surface: 'ra', score: 0.5, proposer: 'g' })
    const a1 = l.addNode({
      parentIds: [ra.id],
      track: 'a',
      surface: 'a1',
      score: 0.5,
      proposer: 'g',
    })
    l.addNode({ parentIds: [a1.id], track: 'a', surface: 'a2', score: 0.5, proposer: 'g' })
    l.addNode({ parentIds: [], track: 'b', surface: 'rb', score: 0.9, proposer: 'g' })
    // Frontier has 2 tips (a2, rb) which would trigger merge first; give them equal
    // vectors so only b is on the scalar frontier, isolating the prune path.
    const gov = heuristicGovernor({ mergeFrontierAt: 99 })
    const op = gov.decide(ctx(l))
    expect(op).toEqual({ op: 'prune', track: 'a' })
  })

  it('stops when budget is exhausted', () => {
    const l = new Lineage()
    l.addNode({ parentIds: [], track: 'a', surface: 'r', score: 0, proposer: 'g' })
    expect(heuristicGovernor().decide(ctx(l, [], 0))).toEqual({ op: 'stop' })
  })

  it('is deterministic: identical inputs yield identical ops', () => {
    const build = () => {
      const l = new Lineage()
      const root = l.addNode({
        parentIds: [],
        track: 't',
        surface: 'r',
        score: 0,
        proposer: 'seed',
      })
      l.addNode({
        parentIds: [root.id],
        track: 'a',
        surface: 'a',
        score: 1,
        proposer: 'g',
        scoreVector: [1, 0.2],
      })
      l.addNode({
        parentIds: [root.id],
        track: 'b',
        surface: 'b',
        score: 1,
        proposer: 'g',
        scoreVector: [0.2, 1],
      })
      return l
    }
    const gov = heuristicGovernor()
    expect(gov.decide(ctx(build()))).toEqual(gov.decide(ctx(build())))
  })
})

describe('runLineage end-to-end', () => {
  // A deterministic stub: each extend adds a fixed climb, then plateaus at a ceiling.
  const climbingStep =
    (ceiling = 0.9, climb = 0.2) =>
    async (args: { tip: { score: number } }) => {
      const next = Math.min(ceiling, args.tip.score + climb)
      return { surface: `s@${next.toFixed(3)}`, score: next, scoreVector: [next, next] }
    }
  const mergeStub = async (args: { parents: Array<{ score: number }> }) => {
    const best = Math.max(...args.parents.map((p) => p.score))
    return { surface: `merged@${best.toFixed(3)}`, score: best + 0.01, scoreVector: [best, best] }
  }

  it('runs 3 visioned tracks, produces a merge/diamond, and is deterministic on re-run', async () => {
    const seeds = [
      {
        surface: 's0',
        track: 'solve',
        vision: 'solve',
        proposer: 'gepa',
        score: 0.1,
        scoreVector: [0.1, 0.1],
      },
      {
        surface: 'o0',
        track: 'outside-the-box',
        vision: 'outside-the-box',
        proposer: 'gepa',
        score: 0.1,
        scoreVector: [0.1, 0.1],
      },
      {
        surface: 'c0',
        track: 'contrarian',
        vision: 'contrarian',
        proposer: 'gepa',
        score: 0.1,
        scoreVector: [0.1, 0.1],
      },
    ]
    const run = () =>
      runLineage({
        seeds,
        step: climbingStep(),
        merge: mergeStub,
        governor: heuristicGovernor(),
        budget: { maxSteps: 20 },
      })

    const r1 = await run()
    expect(r1.lineage.tracks().length).toBeGreaterThan(1)
    expect(r1.lineage.all().some((n) => n.parentIds.length >= 2)).toBe(true) // a merge exists
    expect(r1.best!.score).toBe(Math.max(...r1.lineage.all().map((n) => n.score)))
    expect(r1.steps).toBeLessThanOrEqual(20)
    // three distinct visions seeded
    expect(new Set(r1.lineage.roots().map((n) => n.vision))).toEqual(
      new Set(['solve', 'outside-the-box', 'contrarian']),
    )

    const r2 = await run()
    expect(r2.lineage.toGraph()).toEqual(r1.lineage.toGraph()) // end-to-end determinism
  })

  it('honors an explicit prune (a pruned track is never extended again)', async () => {
    let decideCount = 0
    const gov = callbackGovernor(async (_c: GovernorContext): Promise<GovernorOp> => {
      decideCount += 1
      if (decideCount === 1) return { op: 'prune', track: 'a' }
      if (decideCount === 2) return { op: 'extend', track: 'a' } // must be skipped
      return { op: 'stop' }
    })
    const extended: string[] = []
    const result = await runLineage({
      seeds: [
        { surface: 'a0', track: 'a', proposer: 'g', score: 0.1 },
        { surface: 'b0', track: 'b', proposer: 'g', score: 0.1 },
      ],
      step: async (args) => {
        extended.push(args.track)
        return { surface: 'x', score: 0.5 }
      },
      merge: mergeStub,
      governor: gov,
      budget: { maxSteps: 10 },
    })
    expect(extended).not.toContain('a') // pruned track never extended
    expect(result.lineage.trackNodes('a')).toHaveLength(1) // only its seed
  })

  it('honors op stop immediately', async () => {
    const result = await runLineage({
      seeds: [{ surface: 'a0', track: 'a', proposer: 'g', score: 0.1 }],
      step: climbingStep(),
      merge: mergeStub,
      governor: callbackGovernor(async () => ({ op: 'stop' })),
      budget: { maxSteps: 10 },
    })
    expect(result.steps).toBe(0)
    expect(result.lineage.all()).toHaveLength(1) // only the seed
  })

  it('persists every node to a provided store', async () => {
    const store = memLineageStore()
    await runLineage({
      seeds: [{ surface: 'a0', track: 'a', proposer: 'g', score: 0.1 }],
      step: climbingStep(),
      merge: mergeStub,
      governor: heuristicGovernor(),
      budget: { maxSteps: 5 },
      store,
    })
    const reloaded = await store.load()
    expect(reloaded.all().length).toBeGreaterThan(1)
  })
})
