import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { ROLLOUT_SCHEMA, type RolloutLine } from '../rollout/schema'
import { analyzeSupervisorRunSources } from './analyze'
import { fixtureAt, fixtureJournal, fixtureSources, fixtureState, fixtureWorker } from './fixtures'
import { analyzeSupervisorRunIntegrity } from './integrity'
import { supervisorRunRolloutLines } from './rollout-nodes'
import { isUnavailable, type SupervisorRunSources, type SupervisorRunTree } from './types'

const AT = '2026-07-29T18:00:00.000Z'

function node(
  rolloutId: string,
  over: Partial<RolloutLine> & Pick<RolloutLine, 'parent_rollout_id' | 'role'>,
): RolloutLine {
  const { parent_rollout_id, role, ...rest } = over
  return {
    schema: ROLLOUT_SCHEMA,
    rollout_id: rolloutId,
    parent_rollout_id,
    run_id: 'run-1',
    experiment_id: null,
    candidate_id: null,
    generation: null,
    candidate_index: null,
    role,
    task: {
      suite: 'supervisor-run',
      instance_id: 'instance-1',
      split: 'search',
      seed: 7,
      rep: 0,
    },
    policy: {
      harness: 'test',
      harness_version: '1',
      model: 'test/model@1',
      provider: 'test',
      profile_commit: 'profile-commit',
      agent_profile_cell_id: `profile:${rolloutId}`,
      sampling: {},
    },
    messages: [{ role: 'user', content: `task for ${rolloutId}` }],
    tool_defs: [],
    outcome: {
      reward: null,
      reward_source: null,
      verdict: null,
      metrics: {},
      is_completed: false,
      is_truncated: false,
      error: null,
      realness_gated: false,
    },
    cost: {
      usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_reasoning: null,
      cache_read: null,
      cache_write: null,
      wall_s: null,
    },
    artifacts: { patch_path: null, run_dir: null, transcript_ref: `session:${rolloutId}` },
    provenance: { captured_at: AT, capture: 'settle-time' },
    ...rest,
  }
}

function tree(nodes: RolloutLine[], rootId: string | null = 'root'): SupervisorRunTree {
  return { rootId, nodes, gaps: [] }
}

function codes(input: SupervisorRunSources | SupervisorRunTree): string[] {
  return analyzeSupervisorRunIntegrity(input, { capturedAt: AT }).issues.map((issue) => issue.code)
}

function completedControlSource(inbox: string | null, events: string | null): SupervisorRunSources {
  return fixtureSources({
    journal: fixtureJournal({ workers: [['worker', 1, 4]] }),
    state: fixtureState({ startSec: 0, endSec: 5 }),
    workers: [
      {
        workerId: 'sup-1-test:s0',
        label: 'worker',
        inbox,
        events,
        patchBytes: 10,
      },
    ],
  })
}

describe('supervisor-run integrity', () => {
  it('reports source-only checks unavailable for tree input instead of silently dropping them', () => {
    const worker = fixtureWorker('worker', {
      workerId: 'sup-1-test:s0',
      startSec: 1,
      finishSec: 4,
      steers: ['change direction'],
    })
    const events = (worker.events ?? '').replace('"delivered":true', '"delivered":false')
    const source = completedControlSource(worker.inbox, events)

    expect(codes(source)).toContain('steer-not-delivered')

    const projected = supervisorRunRolloutLines(source, { capturedAt: AT })
    const projectedCodes = codes(projected)
    expect(projectedCodes).toContain('source-checks-unavailable')
    expect(projectedCodes).not.toContain('steer-not-delivered')
  })

  it('allows workers to spawn workers without inventing a supervisor-role violation', () => {
    const root = node('root', { parent_rollout_id: null, role: 'supervisor' })
    const workerParent = node('worker-parent', {
      parent_rollout_id: 'root',
      role: 'worker',
    })
    const child = node('child', { parent_rollout_id: 'worker-parent', role: 'worker' })

    expect(codes(tree([root, workerParent, child]))).toEqual(['source-checks-unavailable'])

    const journal = [
      { kind: 'spawned', id: 'root', parent: null, label: 'root', role: 'supervisor' },
      { kind: 'spawned', id: 'worker-parent', parent: 'root', label: 'parent', role: 'worker' },
      {
        kind: 'spawned',
        id: 'child',
        parent: 'worker-parent',
        label: 'child',
        role: 'worker',
      },
      { kind: 'settled', id: 'worker-parent', status: 'done' },
      { kind: 'settled', id: 'child', status: 'done' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')
    const sourceReport = analyzeSupervisorRunIntegrity(
      fixtureSources({
        journal: `${journal}\n`,
        state: fixtureState({ startSec: 0, endSec: 5 }),
        workers: [
          { workerId: 'worker-parent', label: 'parent', inbox: '', events: '', patchBytes: null },
          { workerId: 'child', label: 'child', inbox: '', events: '', patchBytes: null },
        ],
      }),
      { capturedAt: AT },
    )
    expect(sourceReport.tree.nodes.map((row) => [row.rollout_id, row.role])).toEqual([
      ['root', 'supervisor'],
      ['worker-parent', 'worker'],
      ['child', 'worker'],
    ])
    expect(sourceReport.issues.map((entry) => entry.code)).not.toContain(
      'worker-control-join-unavailable',
    )
  })

  it('preserves an explicitly invalid root role for integrity analysis', () => {
    const journal = `${JSON.stringify({
      kind: 'spawned',
      id: 'root',
      parent: null,
      label: 'root',
      role: 'worker',
    })}\n`

    expect(codes(fixtureSources({ journal, workers: [] }))).toContain('root-role-invalid')
  })

  it('retains malformed-row identity and does not claim its root or parent is absent', () => {
    const validRoot = node('root', { parent_rollout_id: null, role: 'supervisor' })
    const malformedRoot = {
      ...validRoot,
      policy: { ...validRoot.policy, harness: 42 },
    } as unknown as RolloutLine
    const child = node('child', { parent_rollout_id: 'root', role: 'worker' })
    const found = codes(tree([malformedRoot, child]))

    expect(found).toContain('node-schema-invalid')
    expect(found).not.toContain('declared-root-missing')
    expect(found).not.toContain('parent-missing')
  })

  it('joins duplicate display labels by stable workerId', () => {
    const journal = [
      { kind: 'spawned', id: 'root', parent: null, label: 'root', role: 'supervisor' },
      { kind: 'spawned', id: 'worker-a', parent: 'root', label: 'same task', role: 'worker' },
      { kind: 'spawned', id: 'worker-b', parent: 'root', label: 'same task', role: 'worker' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')
    const report = analyzeSupervisorRunIntegrity(
      fixtureSources({
        journal: `${journal}\n`,
        workers: [
          { workerId: 'worker-a', label: 'same task', inbox: '', events: '', patchBytes: null },
          { workerId: 'worker-b', label: 'same task', inbox: '', events: '', patchBytes: null },
        ],
      }),
      { capturedAt: AT },
    )

    expect(report.issues.map((entry) => entry.code)).not.toContain(
      'worker-control-join-unavailable',
    )
  })

  it('marks relationship checks unavailable when a malformed row loses identity', () => {
    const malformed = { policy: { harness: 42 } } as unknown as RolloutLine
    const child = node('child', { parent_rollout_id: 'root', role: 'worker' })
    const found = codes(tree([malformed, child]))

    expect(found).toContain('node-checks-unavailable')
    expect(found).not.toContain('declared-root-missing')
    expect(found).not.toContain('parent-missing')
  })

  it('does not infer a missing parent from malformed journal rows', () => {
    const journal = [
      { kind: 'spawned', id: 'root', parent: null, label: 'root', role: 'supervisor' },
      { kind: 'spawned', id: 'parent', parent: 42, label: 'parent', role: 'worker' },
      { kind: 'spawned', id: 'child', parent: 'parent', label: 'child', role: 'worker' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')
    const report = analyzeSupervisorRunIntegrity(
      fixtureSources({
        journal: `${journal}\n`,
        workers: [{ workerId: 'child', label: 'child', inbox: '', events: '', patchBytes: null }],
      }),
      { capturedAt: AT },
    )
    const found = report.issues.map((entry) => entry.code)

    expect(found).toContain('source-row-malformed')
    expect(found).toContain('node-checks-unavailable')
    expect(found).not.toContain('parent-missing')
    expect(report.tree.nodes.map((row) => row.rollout_id)).toEqual(['root', 'child'])
    const projectedCodes = codes(report.tree)
    expect(projectedCodes).toContain('source-checks-unavailable')
    expect(projectedCodes).not.toContain('parent-missing')
  })

  it('does not infer missing relationships after an unreadable journal line', () => {
    const journal = [
      JSON.stringify({
        kind: 'spawned',
        id: 'root',
        parent: null,
        label: 'root',
        role: 'supervisor',
      }),
      '{"kind":"spawned","id":"lost-parent"',
      JSON.stringify({
        kind: 'spawned',
        id: 'child',
        parent: 'lost-parent',
        label: 'child',
        role: 'worker',
      }),
    ].join('\n')
    const found = codes(
      fixtureSources({
        journal: `${journal}\n`,
        workers: [{ workerId: 'child', label: 'child', inbox: '', events: '', patchBytes: null }],
      }),
    )

    expect(found).toContain('source-row-malformed')
    expect(found).not.toContain('parent-missing')
  })

  it('correlates request ids and detects missing, duplicate, and unknown acknowledgements', () => {
    const inbox = [
      { id: 'A', message: 'first' },
      { id: 'B', message: 'second' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')
    const events = [
      { kind: 'started', at: fixtureAt(1) },
      { kind: 'message', direction: 'down', requestId: 'A', delivered: true },
      { kind: 'message', direction: 'down', requestId: 'A', delivered: true },
      { kind: 'message', direction: 'down', requestId: 'C', delivered: true },
      { kind: 'finished', at: fixtureAt(4), passed: true },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')

    const report = analyzeSupervisorRunIntegrity(
      completedControlSource(`${inbox}\n`, `${events}\n`),
      { capturedAt: AT },
    )
    const found = report.issues.map((entry) => entry.code)
    expect(found).toEqual(
      expect.arrayContaining(['missing-steer-ack', 'duplicate-steer-ack', 'unknown-steer-ack']),
    )
    expect(report.issues.find((entry) => entry.code === 'missing-steer-ack')?.detail).toContain(
      '"B"',
    )
    expect(report.issues.find((entry) => entry.code === 'duplicate-steer-ack')?.detail).toContain(
      '"A"',
    )
    expect(report.issues.find((entry) => entry.code === 'unknown-steer-ack')?.detail).toContain(
      '"C"',
    )
    const summary = analyzeSupervisorRunSources(
      completedControlSource(`${inbox}\n`, `${events}\n`),
      () => 0,
    )
    expect(isUnavailable(summary.orchestration.steers)).toBe(true)
    expect(isUnavailable(summary.orchestration.steersDelivered)).toBe(true)
  })

  it('never counts duplicate acknowledgement rows as multiple deliveries', () => {
    const inbox = `${JSON.stringify({ id: 'A', message: 'first' })}\n`
    const events = [
      { kind: 'message', direction: 'down', requestId: 'A', delivered: true },
      { kind: 'message', direction: 'down', requestId: 'A', delivered: true },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')
    const report = analyzeSupervisorRunSources(
      completedControlSource(inbox, `${events}\n`),
      () => 0,
    )

    expect(report.orchestration.steers).toBe(1)
    expect(isUnavailable(report.orchestration.steersDelivered)).toBe(true)
    expect(report.orchestration.steersByWorker).toEqual({
      unavailable: expect.stringContaining('acknowledgement request id duplicated'),
    })
    expect(report.decision.workerEvidenceBytes).toBe(0)
  })

  it('treats malformed worker rows as unavailable instead of a clean zero', () => {
    const report = analyzeSupervisorRunIntegrity(completedControlSource('{"id":"A"\n', ''), {
      capturedAt: AT,
    })

    expect(report.issues.map((entry) => entry.code)).toContain('worker-controls-unavailable')
    expect(
      isUnavailable(
        analyzeSupervisorRunSources(completedControlSource('{"id":"A"\n', ''), () => 0)
          .orchestration.steers,
      ),
    ).toBe(true)
  })

  it('distinguishes captured-empty control artifacts from missing artifacts', () => {
    const worker = fixtureWorker('worker', {
      workerId: 'sup-1-test:s0',
      startSec: 1,
      finishSec: 4,
    })
    const captured = completedControlSource('', worker.events)
    const missing = completedControlSource(null, worker.events)

    expect(codes(captured)).not.toContain('worker-controls-unavailable')
    expect(analyzeSupervisorRunSources(captured, () => 0).orchestration.steers).toBe(0)
    expect(codes(missing)).toContain('worker-controls-unavailable')
    expect(isUnavailable(analyzeSupervisorRunSources(missing, () => 0).orchestration.steers)).toBe(
      true,
    )
  })

  it('does not turn reward gaps into unavailable control evidence', () => {
    const root = node('root', { parent_rollout_id: null, role: 'supervisor' })
    const input: SupervisorRunTree = {
      ...tree([root]),
      gaps: [
        {
          code: 'root-reward-unavailable',
          message: 'no judge verdict for this run',
          nodeId: 'root',
        },
      ],
    }

    expect(codes(input)).toEqual(['source-checks-unavailable'])
  })

  it('detects duplicate identities, missing parents, cross-run edges, and cycles', () => {
    const root = node('root', { parent_rollout_id: null, role: 'supervisor' })
    const duplicateA = node('same', { parent_rollout_id: 'root', role: 'worker' })
    const duplicateB = node('same', { parent_rollout_id: 'root', role: 'worker' })
    const orphan = node('orphan', {
      parent_rollout_id: 'missing',
      role: 'worker',
      run_id: 'run-2',
    })
    const cycleA = node('cycle-a', { parent_rollout_id: 'cycle-b', role: 'worker' })
    const cycleB = node('cycle-b', { parent_rollout_id: 'cycle-a', role: 'worker' })
    const found = codes(tree([root, duplicateA, duplicateB, orphan, cycleA, cycleB]))

    expect(found).toEqual(
      expect.arrayContaining(['duplicate-rollout-id', 'parent-missing', 'parent-cycle']),
    )
  })

  it('detects orphan and duplicate terminal journal events', () => {
    const journal = [
      fixtureJournal({ workers: [['worker', 1, 4]] }).trim(),
      JSON.stringify({ kind: 'settled', id: 'orphan', status: 'done', at: AT }),
      JSON.stringify({ kind: 'settled', id: 'orphan', status: 'done', at: AT }),
    ].join('\n')
    const worker = fixtureWorker('worker', {
      workerId: 'sup-1-test:s0',
      startSec: 1,
      finishSec: 4,
    })

    expect(
      codes(
        fixtureSources({
          journal,
          state: fixtureState({ startSec: 0, endSec: 5 }),
          workers: [worker],
        }),
      ),
    ).toEqual(expect.arrayContaining(['orphan-terminal', 'duplicate-terminal']))
  })

  it('keeps the 4,000-node source path bounded and near-linear', { timeout: 10_000 }, () => {
    const source = (size: number): SupervisorRunSources => {
      const journal: string[] = [
        JSON.stringify({
          kind: 'spawned',
          id: 'root',
          parent: null,
          label: 'root',
          role: 'supervisor',
          at: fixtureAt(0),
        }),
      ]
      const workers: NonNullable<SupervisorRunSources['workers']>[number][] = []
      for (let index = 1; index < size; index += 1) {
        const id = `node-${index}`
        journal.push(
          JSON.stringify({
            kind: 'spawned',
            id,
            parent: index === 1 ? 'root' : `node-${index - 1}`,
            label: `task-${index}`,
            role: 'worker',
            at: fixtureAt(index),
          }),
        )
        workers.push({
          workerId: id,
          label: `task-${index}`,
          inbox: '',
          events: '',
          patchBytes: null,
        })
      }
      return fixtureSources({
        runRef: `chain-${size}`,
        journal: `${journal.join('\n')}\n`,
        state: fixtureState({ startSec: 0, endSec: size + 1 }),
        workers,
      })
    }
    const measure = (input: SupervisorRunSources): number => {
      const started = performance.now()
      analyzeSupervisorRunIntegrity(input, { capturedAt: AT })
      return performance.now() - started
    }
    const median = (values: number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? Infinity
    const small = source(1_000)
    const large = source(4_000)
    measure(small)
    measure(large)
    const smallMs = median([measure(small), measure(small), measure(small)])
    const largeMs = median([measure(large), measure(large), measure(large)])

    expect(largeMs).toBeLessThan(smallMs * 7 + 100)
    expect(largeMs).toBeLessThan(1_500)
  })
})
