import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSupervisorRun, findSupervisorRunDirs } from './loops-reader'
import { supervisorRunRolloutLines } from './rollout-nodes'
import { readRuntimeSupervisorRun } from './runtime-reader'
import { isUnavailable } from './types'

const T0 = Date.parse('2026-07-30T00:00:00.000Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1_000).toISOString()
const ROOT_PROFILE = `sha256:${'a'.repeat(64)}`
const CHILD_PROFILE = `sha256:${'b'.repeat(64)}`
const LEAF_PROFILE = `sha256:${'c'.repeat(64)}`

function begin(root: string, seconds: number): Record<string, unknown> {
  return { kind: 'begin', root, at: at(seconds) }
}

function event(root: string, value: Record<string, unknown>): Record<string, unknown> {
  return { kind: 'event', root, event: value }
}

async function writeJournal(
  runDir: string,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, 'spawn-journal.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  )
}

async function nestedRuntimeRun(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
  const runDir = join(parent, 'run-nested')
  await writeJournal(runDir, [
    begin('run-root', 0),
    event('run-root', {
      kind: 'spawned',
      id: 'run-root',
      label: 'research-leader',
      profileDigest: ROOT_PROFILE,
      budget: { maxIterations: 3, maxTokens: 1_000 },
      seq: 0,
      at: at(0),
    }),
    event('run-root', {
      kind: 'metered',
      id: 'run-root',
      spend: {
        iterations: 1,
        tokens: { input: 10, output: 2 },
        usd: 0.01,
        ms: 500,
      },
      seq: 0,
      at: at(0.5),
    }),
    event('run-root', {
      kind: 'spawned',
      id: 'run-root:s0',
      parent: 'run-root',
      label: 'nested-researcher',
      profileDigest: CHILD_PROFILE,
      runtime: 'driver',
      budget: { maxIterations: 2, maxTokens: 500 },
      seq: 0,
      at: at(1),
    }),
    begin('run-root:s0', 1),
    event('run-root:s0', {
      kind: 'spawned',
      id: 'run-root:s0',
      label: 'nested-researcher',
      profileDigest: CHILD_PROFILE,
      budget: { maxIterations: 2, maxTokens: 500 },
      seq: 0,
      at: at(1),
    }),
    event('run-root:s0', {
      kind: 'metered',
      id: 'run-root:s0',
      spend: {
        iterations: 1,
        tokens: { input: 20, output: 4 },
        usd: 0.02,
        ms: 1_000,
      },
      seq: 0,
      at: at(1.5),
    }),
    event('run-root:s0', {
      kind: 'spawned',
      id: 'run-root:s0:s0',
      parent: 'run-root:s0',
      label: 'leaf',
      profileDigest: LEAF_PROFILE,
      runtime: 'cli',
      budget: { maxIterations: 1, maxTokens: 100 },
      seq: 0,
      at: at(2),
    }),
    event('run-root:s0', {
      kind: 'settled',
      id: 'run-root:s0:s0',
      status: 'done',
      verdict: { valid: true, score: 0.9 },
      spent: {
        iterations: 1,
        tokens: { input: 5, output: 1 },
        usd: 0.005,
        ms: 1_000,
      },
      seq: 0,
      at: at(3),
    }),
    event('run-root', {
      kind: 'settled',
      id: 'run-root:s0',
      status: 'down',
      reason: 'nested budget exhausted',
      infra: false,
      spent: {
        iterations: 2,
        tokens: { input: 25, output: 5 },
        usd: 0.025,
        ms: 3_000,
      },
      seq: 0,
      at: at(4),
    }),
  ])
  await writeFile(
    join(runDir, 'result.json'),
    JSON.stringify({
      kind: 'completed',
      artifact: { summary: 'synthetic' },
      artifactRef: `sha256:${'d'.repeat(64)}`,
      tree: { root: 'run-root', nodes: [] },
      spentTotal: {
        iterations: 3,
        tokens: { input: 35, output: 7 },
        usd: 0.035,
        ms: 3_500,
      },
    }),
  )
  await writeFile(
    join(runDir, 'trajectory.json'),
    JSON.stringify({
      root: 'run-root',
      nodes: [
        {
          id: 'run-root',
          children: ['run-root:s0'],
          label: 'research-leader',
          status: 'pending',
          ownSpend: {},
          rolledUpSpend: {},
        },
      ],
      total: {},
      statusCounts: { done: 0, failed: 0, cancelled: 0, pending: 1, waiting: 0 },
    }),
  )
  return runDir
}

describe('Runtime FileRunContext supervisor reader', () => {
  it('flattens nested tree envelopes and reuses the existing analyzer without double-counting', async () => {
    const runDir = await nestedRuntimeRun()
    const source = await readRuntimeSupervisorRun(runDir)
    const report = await analyzeSupervisorRun(runDir)

    expect(source.journal).not.toContain('"kind":"event"')
    expect(report.instanceId).toBe('run-root')
    expect(report.supervisorId).toBe('run-root')
    expect(report.supervisorProfileDigest).toBe(ROOT_PROFILE)
    expect(report.orchestration.workersSpawned).toBe(2)
    expect(report.orchestration.workersSettled).toBe(2)
    expect(report.orchestration.delegationDepth).toBe(2)
    expect(report.economics.brain.tokensIn).toBe(10)
    expect(report.economics.brain.tokensOut).toBe(2)
    expect(report.economics.workers.tokensIn).toBe(25)
    expect(report.economics.workers.tokensOut).toBe(5)
    expect(report.economics.totalUsd).toBe(0.035)
    expect(report.outcome.supStatus).toBe('completed')
    expect(isUnavailable(report.orchestration.supervisorWallMs)).toBe(true)

    if (isUnavailable(report.economics.perWorker)) {
      throw new Error(report.economics.perWorker.unavailable)
    }
    expect(report.economics.perWorker).toEqual([
      expect.objectContaining({
        workerId: 'run-root:s0',
        role: null,
        runtime: 'driver',
        profileDigest: CHILD_PROFILE,
        status: 'down',
        failure: 'nested budget exhausted',
        infra: false,
        wallMs: 3_000,
        tokensIn: 25,
        tokensOut: 5,
      }),
      expect.objectContaining({
        workerId: 'run-root:s0:s0',
        role: null,
        runtime: 'cli',
        profileDigest: LEAF_PROFILE,
        status: 'done',
        wallMs: 1_000,
        tokensIn: 5,
        tokensOut: 1,
        passed: true,
        score: 0.9,
      }),
    ])

    const tree = supervisorRunRolloutLines(source, { capturedAt: at(10) })
    expect(tree.nodes).toHaveLength(1)
    expect(tree.nodes[0]?.policy.agent_profile_cell_id).toBe(ROOT_PROFILE)
    expect(tree.gaps.filter((gap) => gap.code === 'node-role-unavailable')).toHaveLength(2)
  })

  it('leaves root outcome and terminal wall time unavailable without terminal evidence', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(parent, 'unfinished')
    await writeJournal(runDir, [
      begin('unfinished-root', 0),
      event('unfinished-root', {
        kind: 'spawned',
        id: 'unfinished-root',
        label: 'root',
        profileDigest: ROOT_PROFILE,
        budget: { maxIterations: 1, maxTokens: 100 },
        seq: 0,
        at: at(0),
      }),
      event('unfinished-root', {
        kind: 'metered',
        id: 'unfinished-root',
        spend: {
          iterations: 1,
          tokens: { input: 8, output: 1 },
          usd: 0.004,
          ms: 400,
        },
        seq: 0,
        at: at(1),
      }),
    ])

    const report = await analyzeSupervisorRun(runDir)
    expect(isUnavailable(report.outcome.supStatus)).toBe(true)
    expect(isUnavailable(report.orchestration.supervisorWallMs)).toBe(true)
    expect(report.economics.brain.tokensIn).toBe(8)
    expect(report.economics.totalUsd).toBe(0.004)
    expect(report.orchestration.workersSpawned).toBe(0)
    expect(await findSupervisorRunDirs(runDir)).toEqual([])
  })

  it('records Runtime interruption as execution status and reason, never as quality success', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(parent, 'interrupted')
    await writeJournal(runDir, [
      begin('interrupted-root', 0),
      event('interrupted-root', {
        kind: 'spawned',
        id: 'interrupted-root',
        label: 'root',
        profileDigest: ROOT_PROFILE,
        budget: { maxIterations: 1, maxTokens: 100 },
        seq: 0,
        at: at(0),
      }),
    ])
    await writeFile(
      join(runDir, 'result.json'),
      JSON.stringify({
        kind: 'interrupted',
        reason: 'budget-exhausted',
        tree: { root: 'interrupted-root', nodes: [] },
        downCount: 0,
        spentTotal: {
          iterations: 0,
          tokens: { input: 0, output: 0 },
          usd: 0,
          ms: 0,
        },
      }),
    )

    const source = await readRuntimeSupervisorRun(runDir)
    const report = await analyzeSupervisorRun(runDir)
    const tree = supervisorRunRolloutLines(source, { capturedAt: at(10) })
    expect(report.outcome.supStatus).toBe('interrupted')
    expect(isUnavailable(report.outcome.supVerdict)).toBe(true)
    expect(isUnavailable(report.outcome.verifyPass)).toBe(true)
    expect(isUnavailable(report.economics.brain.tokensIn)).toBe(true)
    expect(isUnavailable(report.economics.brain.usd)).toBe(true)
    expect(isUnavailable(report.economics.totalUsd)).toBe(true)
    expect(tree.nodes[0]?.outcome.is_completed).toBe(false)
    expect(tree.nodes[0]?.outcome.error).toBe('budget-exhausted')
  })

  it('keeps explicitly unknown Runtime prices unavailable while retaining measured tokens', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(parent, 'unknown-usd')
    await writeJournal(runDir, [
      begin('unknown-usd-root', 0),
      event('unknown-usd-root', {
        kind: 'spawned',
        id: 'unknown-usd-root',
        label: 'root',
        profileDigest: ROOT_PROFILE,
        budget: { maxIterations: 1, maxTokens: 100 },
        seq: 0,
        at: at(0),
      }),
      event('unknown-usd-root', {
        kind: 'metered',
        id: 'unknown-usd-root',
        spend: {
          iterations: 1,
          tokens: { input: 8, output: 1 },
          usd: 0,
          usdKnown: false,
          ms: 400,
        },
        seq: 0,
        at: at(1),
      }),
    ])

    const report = await analyzeSupervisorRun(runDir)
    expect(report.economics.brain.tokensIn).toBe(8)
    expect(report.economics.brain.tokensOut).toBe(1)
    expect(isUnavailable(report.economics.brain.usd)).toBe(true)
    expect(isUnavailable(report.economics.totalUsd)).toBe(true)
  })

  it('does not turn an unsettled child into zero worker usage or zero total spend', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(parent, 'unsettled-child')
    await writeJournal(runDir, [
      begin('unsettled-root', 0),
      event('unsettled-root', {
        kind: 'spawned',
        id: 'unsettled-root',
        label: 'root',
        profileDigest: ROOT_PROFILE,
        budget: { maxIterations: 1, maxTokens: 100 },
        seq: 0,
        at: at(0),
      }),
      event('unsettled-root', {
        kind: 'metered',
        id: 'unsettled-root',
        spend: {
          iterations: 1,
          tokens: { input: 8, output: 1 },
          usd: 0.004,
          ms: 400,
        },
        seq: 0,
        at: at(1),
      }),
      event('unsettled-root', {
        kind: 'spawned',
        id: 'unsettled-child',
        parent: 'unsettled-root',
        label: 'child',
        profileDigest: CHILD_PROFILE,
        runtime: 'cli',
        budget: { maxIterations: 1, maxTokens: 100 },
        seq: 0,
        at: at(2),
      }),
    ])

    const report = await analyzeSupervisorRun(runDir)
    expect(isUnavailable(report.economics.workers.tokensIn)).toBe(true)
    expect(isUnavailable(report.economics.workers.tokensOut)).toBe(true)
    expect(isUnavailable(report.economics.totalUsd)).toBe(true)
    if (isUnavailable(report.economics.perWorker)) {
      throw new Error(report.economics.perWorker.unavailable)
    }
    expect(report.economics.perWorker[0]?.tokensIn).toBeNull()
    expect(report.economics.perWorker[0]?.tokensOut).toBeNull()
    expect(report.economics.perWorker[0]?.usd).toBeNull()
  })

  it('finds multiple direct Runtime run directories below a parent without finding their blobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-supervisor-parent-'))
    for (const id of ['run-a', 'run-b']) {
      await writeJournal(join(root, id), [
        begin(id, 0),
        event(id, {
          kind: 'spawned',
          id,
          label: id,
          profileDigest: ROOT_PROFILE,
          budget: { maxIterations: 1, maxTokens: 1 },
          seq: 0,
          at: at(0),
        }),
      ])
      await mkdir(join(root, id, 'blobs'), { recursive: true })
      await writeFile(join(root, id, 'blobs', 'artifact.json'), '{}')
    }

    expect(await findSupervisorRunDirs(root)).toEqual([join(root, 'run-a'), join(root, 'run-b')])
  })

  it('composes 4,000 nested Runtime trees without scanning the journal once per tree', {
    timeout: 10_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(root, 'large-nested')
    const rows: Record<string, unknown>[] = [
      begin('node-0', 0),
      event('node-0', {
        kind: 'spawned',
        id: 'node-0',
        label: 'node-0',
        profileDigest: ROOT_PROFILE,
        budget: {},
        seq: 0,
        at: at(0),
      }),
      event('node-0', {
        kind: 'metered',
        id: 'node-0',
        spend: {
          iterations: 1,
          tokens: { input: 1, output: 1 },
          usd: 0,
          ms: 1,
        },
        seq: 0,
        at: at(0),
      }),
    ]
    for (let index = 1; index < 4_000; index += 1) {
      const parent = `node-${index - 1}`
      const id = `node-${index}`
      rows.push(
        event(parent, {
          kind: 'spawned',
          id,
          parent,
          label: id,
          profileDigest: CHILD_PROFILE,
          runtime: 'driver',
          budget: {},
          seq: 0,
          at: at(index),
        }),
        begin(id, index),
        event(id, {
          kind: 'spawned',
          id,
          label: id,
          profileDigest: CHILD_PROFILE,
          budget: {},
          seq: 0,
          at: at(index),
        }),
      )
    }
    await writeJournal(runDir, rows)

    const source = await readRuntimeSupervisorRun(runDir)
    expect(source.workers).toHaveLength(3_999)
    expect(source.journal?.split('\n').filter(Boolean)).toHaveLength(4_001)
  })

  it('refuses a nested tree whose exact profile identity disagrees with its parent spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(root, 'mismatch')
    await writeJournal(runDir, [
      begin('root', 0),
      event('root', {
        kind: 'spawned',
        id: 'root',
        label: 'root',
        profileDigest: ROOT_PROFILE,
        budget: {},
        seq: 0,
        at: at(0),
      }),
      event('root', {
        kind: 'spawned',
        id: 'child',
        parent: 'root',
        label: 'child',
        profileDigest: CHILD_PROFILE,
        runtime: 'driver',
        budget: {},
        seq: 0,
        at: at(1),
      }),
      begin('child', 1),
      event('child', {
        kind: 'spawned',
        id: 'child',
        label: 'child',
        profileDigest: LEAF_PROFILE,
        budget: {},
        seq: 0,
        at: at(1),
      }),
    ])

    await expect(readRuntimeSupervisorRun(runDir)).rejects.toThrow(
      /disagrees with its parent profile digest/,
    )
  })

  it('refuses a Runtime result attached to a different journal root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(root, 'result-mismatch')
    await writeJournal(runDir, [
      begin('journal-root', 0),
      event('journal-root', {
        kind: 'spawned',
        id: 'journal-root',
        label: 'root',
        profileDigest: ROOT_PROFILE,
        budget: {},
        seq: 0,
        at: at(0),
      }),
    ])
    await writeFile(
      join(runDir, 'result.json'),
      JSON.stringify({
        kind: 'completed',
        tree: { root: 'other-root', nodes: [] },
        spentTotal: {
          iterations: 0,
          tokens: { input: 0, output: 0 },
          usd: 0,
          ms: 0,
        },
      }),
    )

    await expect(readRuntimeSupervisorRun(runDir)).rejects.toThrow(/does not match journal root/)
  })

  it('refuses one journal file containing two independent top-level runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(root, 'two-roots')
    await writeJournal(runDir, [
      begin('root-a', 0),
      event('root-a', {
        kind: 'spawned',
        id: 'root-a',
        label: 'root-a',
        profileDigest: ROOT_PROFILE,
        budget: {},
        seq: 0,
        at: at(0),
      }),
      begin('root-b', 1),
      event('root-b', {
        kind: 'spawned',
        id: 'root-b',
        label: 'root-b',
        profileDigest: CHILD_PROFILE,
        budget: {},
        seq: 0,
        at: at(1),
      }),
    ])

    await expect(readRuntimeSupervisorRun(runDir)).rejects.toThrow(
      /expected one top-level tree, found 2/,
    )
  })
})
