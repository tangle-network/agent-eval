import { describe, expect, it } from 'vitest'
import { assertMinted, validateRolloutLine } from '../rollout/schema'
import {
  fixtureAt as at,
  fixtureJournal as journal,
  fixtureSources as sources,
  fixtureState as state,
  fixtureWorker as worker,
} from './fixtures'
import { supervisorRunRolloutLines } from './rollout-nodes'

const src = sources({
  journal: journal({
    workers: [
      ['fix-a', 10, 200],
      ['fix-b', 12, 300, 'cancelled'],
    ],
    metered: [[5, 1000, 100, 0.01]],
  }),
  state: state({ startSec: 0, endSec: 400, usd: 0.25 }),
  workers: [
    worker('fix-a', {
      startSec: 10,
      finishSec: 200,
      passed: true,
      patchBytes: 500,
      steers: ['narrow the fix'],
    }),
    worker('fix-b', { startSec: 12 }),
  ],
  judge: JSON.stringify({ resolved: true, score: 0.8 }),
  judgeSource: '/tmp/cell/judge.json',
  result: JSON.stringify({ verify_pass: true, patchPath: '/tmp/delivered.patch' }),
})

describe('supervisorRunRolloutLines — the tree IS rollout rows', () => {
  const tree = supervisorRunRolloutLines(src, {
    suite: 'swe-bench-verified',
    supervisorModel: 'glm-5.2',
    workerModel: 'glm-4.6',
    workerHarness: 'opencode',
    capturedAt: '2026-07-23T01:00:00.000Z',
  })

  it('emits one node per invocation, rooted at the supervisor', () => {
    expect(tree.rootId).toBe('sup-1-test')
    expect(tree.nodes).toHaveLength(3)
    expect(tree.nodes[0]?.role).toBe('supervisor')
    expect(tree.nodes.filter((n) => n.role === 'worker')).toHaveLength(2)
  })

  it('keys workers to their spawner with parent_rollout_id', () => {
    const workers = tree.nodes.filter((n) => n.role === 'worker')
    for (const w of workers) expect(w.parent_rollout_id).toBe('sup-1-test')
    expect(tree.nodes[0]?.parent_rollout_id).toBeNull()
  })

  it('produces rows that pass tangle.rollout.v1 validation', () => {
    for (const node of tree.nodes) expect(validateRolloutLine(node)).toEqual([])
  })

  it('carries the judge verdict as the supervisor reward and self-verify as the worker reward', () => {
    expect(tree.nodes[0]?.outcome.reward).toBe(0.8)
    expect(tree.nodes[0]?.outcome.reward_source).toBe('/tmp/cell/judge.json')
    const passed = tree.nodes.find((n) => n.outcome.metrics.label === 'fix-a')
    expect(passed?.outcome.reward).toBe(1)
    expect(passed?.outcome.reward_source).toBe('worker-self-verify')
  })

  it('labels an unfinished worker as a reward GAP, never a zero', () => {
    const unfinished = tree.nodes.find((n) => n.outcome.metrics.label === 'fix-b')
    expect(unfinished?.outcome.reward).toBeNull()
    expect(unfinished?.outcome.reward_source).toBeNull()
    expect(unfinished?.outcome.is_truncated).toBe(true)
    expect(tree.gaps.some((g) => g.includes('fix-b'))).toBe(true)
  })

  it('carries per-node cost and the timeline the report is computed from', () => {
    expect(tree.nodes[0]?.cost.usd).toBe(0.25)
    expect(tree.nodes[0]?.cost.tokens_in).toBe(1000)
    expect(tree.nodes[0]?.cost.wall_s).toBe(400)
    const passed = tree.nodes.find((n) => n.outcome.metrics.label === 'fix-a')
    expect(passed?.outcome.metrics.spawned_at).toBe(Date.parse('2026-07-23T00:00:10.000Z'))
    expect(passed?.outcome.metrics.settled_at).toBe(Date.parse('2026-07-23T00:03:20.000Z'))
    expect(passed?.outcome.metrics.steers_queued).toBe(1)
    expect(passed?.cost.wall_s).toBe(190)
  })

  it('states realness_gated on every node — this is the SECOND producer of rewards', () => {
    // The supervision journal is a reward producer that is not
    // `mintRolloutRows`: it writes `outcome.reward` from the official judge
    // verdict. It used to omit `realness_gated` entirely, which made
    // `isLineRealnessGated` structurally false for every supervisor and worker
    // row and let the rows walk into a training export as if screened. The flag
    // is now written by `unscreenedRewardFields`, the same module that owns the
    // gate — `false` is the literal claim "nothing flagged this run", stated
    // rather than implied by silence.
    for (const node of tree.nodes) {
      expect('realness_gated' in node.outcome).toBe(true)
      expect(node.outcome.realness_gated).toBe(false)
    }
  })

  it('declares itself UNSCREENED — no gate has ever run on a journal reward', () => {
    // `realness_gated: false` alone was still an overclaim: it is the gate's
    // VERDICT, and on this path no gate ran at all. The screening claim is now
    // carried separately, and `assertMinted` refuses to promote a positive
    // unscreened reward into the training path.
    for (const node of tree.nodes) {
      expect(node.outcome.realness_screened).toBe(false)
    }
    const positive = tree.nodes.filter((n) => (n.outcome.reward ?? 0) > 0)
    expect(positive.length).toBeGreaterThan(0)
    for (const node of positive) {
      expect(() => assertMinted(node)).toThrow(/realness_screened: false/)
    }
  })

  it('marks every node a transcript gap — messages live in the harness store', () => {
    for (const node of tree.nodes) {
      expect(node.messages).toEqual([])
      expect(node.provenance.capture).toBe('backfill')
      expect(typeof node.provenance.gap).toBe('string')
    }
  })

  it('returns no nodes and says why when the journal is absent', () => {
    const empty = supervisorRunRolloutLines(sources({ supRunDir: null }))
    expect(empty.nodes).toEqual([])
    expect(empty.gaps[0]).toContain('no supervisor run dir')
  })

  it('retains nested supervisor roles and exact structured scores across duplicate labels', () => {
    const recursiveJournal = [
      { kind: 'spawned', id: 'root', label: 'root', role: 'supervisor', at: at(0) },
      {
        kind: 'spawned',
        id: 'manager-a',
        parent: 'root',
        label: 'manager',
        role: 'supervisor',
        at: at(1),
      },
      {
        kind: 'spawned',
        id: 'manager-b',
        parent: 'root',
        label: 'manager',
        role: 'supervisor',
        at: at(2),
      },
      {
        kind: 'spawned',
        id: 'worker-a',
        parent: 'manager-a',
        label: 'same task',
        role: 'worker',
        at: at(3),
      },
      {
        kind: 'spawned',
        id: 'worker-b',
        parent: 'manager-b',
        label: 'same task',
        role: 'worker',
        at: at(4),
      },
      {
        kind: 'settled',
        id: 'worker-a',
        status: 'done',
        verdict: { valid: true, score: 0.37, notes: 'partial but useful' },
        spent: { tokens: { input: 10, output: 1 }, usd: 0.01 },
        at: at(8),
      },
      {
        kind: 'settled',
        id: 'worker-b',
        status: 'done',
        verdict: { valid: true, score: 0.82, notes: 'strong' },
        spent: { tokens: { input: 20, output: 2 }, usd: 0.02 },
        at: at(9),
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')
    const recursive = supervisorRunRolloutLines(
      sources({
        journal: recursiveJournal,
        workers: [
          {
            workerId: 'worker-a',
            label: 'same task',
            events: null,
            inbox: null,
            patchBytes: 10,
          },
          {
            workerId: 'worker-b',
            label: 'same task',
            events: null,
            inbox: null,
            patchBytes: 20,
          },
        ],
      }),
      { supervisorModel: 'manager-model', workerModel: 'worker-model' },
    )

    const manager = recursive.nodes.find((node) => node.rollout_id === 'manager-a')
    const first = recursive.nodes.find((node) => node.rollout_id === 'worker-a')
    const second = recursive.nodes.find((node) => node.rollout_id === 'worker-b')
    expect(manager?.role).toBe('supervisor')
    expect(manager?.policy.model).toBe('manager-model')
    expect(first?.role).toBe('worker')
    expect(first?.parent_rollout_id).toBe('manager-a')
    expect(first?.outcome.reward).toBe(0.37)
    expect(first?.outcome.verdict).toMatchObject({
      verdict: { valid: true, score: 0.37, notes: 'partial but useful' },
      valid: true,
      score: 0.37,
    })
    expect(first?.cost.usd).toBe(0.01)
    expect(second?.parent_rollout_id).toBe('manager-b')
    expect(second?.outcome.reward).toBe(0.82)
    expect(second?.cost.usd).toBe(0.02)
  })
})
