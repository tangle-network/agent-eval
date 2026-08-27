import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSupervisorRunSources } from './analyze'
import { analyzeSupervisorRun, findSupervisorRunDirs } from './loops-reader'
import { renderSupervisorRunMarkdown } from './render'
import { supervisorRunRolloutLines } from './rollout-nodes'
import { type RuntimeTraceSessionBinding, readRuntimeSupervisorRun } from './runtime-reader'
import { isUnavailable, type SupervisorRunSessionLineage } from './types'

const T0 = Date.parse('2026-07-30T00:00:00.000Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1_000).toISOString()
const ROOT_PROFILE = `sha256:${'a'.repeat(64)}`
const CHILD_PROFILE = `sha256:${'b'.repeat(64)}`
const LEAF_PROFILE = `sha256:${'c'.repeat(64)}`

function providerSession(
  externalId: string,
  nativeSessionId: string,
  backend = 'pi',
  cwd = `/workspaces/${encodeURIComponent(externalId)}`,
  provider = 'cli-bridge',
): RuntimeTraceSessionBinding {
  return {
    provider,
    backend,
    externalId,
    nativeSessionId,
    cwd,
    nativePromptCount: 1,
    controllerTurns: [],
  }
}

function measuredProviderSession(row: SupervisorRunSessionLineage): RuntimeTraceSessionBinding {
  if (row.providerSession === undefined) {
    throw new Error(`expected provider session for ${row.nodeId}`)
  }
  return row.providerSession
}

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

async function recursiveSteeringRuntimeRun(
  providerSessions: 'none' | 'all' | 'child-only' = 'none',
): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'runtime-steering-run-'))
  const runDir = join(parent, 'runtime')
  const root = 'recursive-steering-smoke'
  const child = `${root}:s0`
  await writeJournal(runDir, [
    begin(root, 0),
    event(root, {
      kind: 'spawned',
      id: root,
      label: ROOT_PROFILE,
      profileDigest: ROOT_PROFILE,
      budget: { maxIterations: 6, maxTokens: 250_000 },
      seq: 0,
      at: at(0),
    }),
    event(root, {
      kind: 'metered',
      id: root,
      spend: {
        iterations: 1,
        tokens: { input: 6_508, output: 612 },
        usd: 0,
        ms: 0,
      },
      seq: 0,
      at: at(1),
    }),
    event(root, {
      kind: 'spawned',
      id: child,
      parent: root,
      label: 'steering-child',
      profileDigest: CHILD_PROFILE,
      runtime: 'driver',
      budget: { maxIterations: 3, maxTokens: 100_000 },
      seq: 0,
      at: at(2),
    }),
    begin(child, 2),
    event(child, {
      kind: 'spawned',
      id: child,
      label: 'steering-child',
      profileDigest: CHILD_PROFILE,
      budget: { maxIterations: 3, maxTokens: 100_000 },
      seq: 0,
      at: at(2),
    }),
    event(child, {
      kind: 'metered',
      id: child,
      spend: {
        iterations: 2,
        tokens: { input: 82_466, output: 727 },
        usd: 0,
        usdKnown: false,
        ms: 0,
      },
      seq: 0,
      at: at(3),
    }),
    event(root, {
      kind: 'settled',
      id: child,
      status: 'done',
      spent: {
        iterations: 2,
        tokens: { input: 82_466, output: 727 },
        usd: 0,
        usdKnown: false,
        ms: 0,
      },
      ...(providerSessions === 'all' || providerSessions === 'child-only'
        ? {
            providerSession:
              providerSessions === 'child-only'
                ? providerSession(
                    child,
                    'provider-neutral-native-id',
                    'custom-harness',
                    '/provider-neutral/workspace',
                    'custom-provider',
                  )
                : providerSession(child, 'same-native-id', 'codex'),
          }
        : {}),
      seq: 0,
      at: at(4),
    }),
    event(root, {
      kind: 'settled',
      id: root,
      status: 'done',
      spent: {
        iterations: 1,
        tokens: { input: 137_484, output: 9_503 },
        usd: 0,
        usdKnown: false,
        ms: 0,
      },
      ...(providerSessions === 'all'
        ? {
            providerSession: {
              ...providerSession(root, 'same-native-id'),
              controllerTurns: [
                {
                  ordinal: 1,
                  runId: `${root}:turn:1`,
                  bridgeRequestDigest: `sha256:${'d'.repeat(64)}`,
                  promptSha256: `sha256:${'e'.repeat(64)}`,
                  startedAt: T0,
                  endedAt: T0 + 1_000,
                },
              ],
            },
          }
        : {}),
      seq: 1,
      at: at(5),
    }),
  ])
  return runDir
}

describe('Runtime FileRunContext supervisor reader', () => {
  it('joins the sanitized successful steering tree to exact provider sessions', async () => {
    const runDir = await recursiveSteeringRuntimeRun()
    const root = 'recursive-steering-smoke'
    const child = `${root}:s0`
    const rootSession = '00000000-0000-4000-8000-000000000001'
    const childSession = '00000000-0000-4000-8000-000000000002'
    const bindings = Object.freeze([
      Object.freeze(
        providerSession(root, rootSession, 'pi', '/workspaces/recursive-steering-smoke'),
      ),
      Object.freeze(
        providerSession(child, childSession, 'pi', '/workspaces/recursive-steering-smoke%3As0'),
      ),
    ] satisfies RuntimeTraceSessionBinding[])

    const source = await readRuntimeSupervisorRun(runDir, { sessionBindings: bindings })
    const report = await analyzeSupervisorRun(runDir, {
      runtime: { sessionBindings: bindings },
    })

    expect(source.sessionLineage).toEqual([
      {
        nodeId: root,
        parentNodeId: null,
        depth: 0,
        childNodeIds: [child],
        providerSession: bindings[0],
      },
      {
        nodeId: child,
        parentNodeId: root,
        depth: 1,
        childNodeIds: [],
        providerSession: bindings[1],
      },
    ])
    expect(report.sessionLineage).toEqual(source.sessionLineage)
    expect(report.orchestration.delegationDepth).toBe(1)
    const markdown = renderSupervisorRunMarkdown(report)
    expect(markdown).toContain(
      `| <code>${root}</code> | — | 0 | 1 | <code>cli-bridge</code> | <code>pi</code> | <code>${rootSession}</code> | 0/1 | 1 |`,
    )
    expect(markdown).toContain(
      `| <code>${child}</code> | <code>${root}</code> | 1 | 0 | <code>cli-bridge</code> | <code>pi</code> | <code>${childSession}</code> | 0/1 | 1 |`,
    )
    const escaped = renderSupervisorRunMarkdown({
      ...report,
      sessionLineage: source.sessionLineage?.map((row, index) => {
        if (index !== 0) return row
        return {
          ...row,
          providerSession: {
            ...measuredProviderSession(row),
            backend: 'pi|<script>',
            cwd: '/line/one\nline/two',
          },
        }
      }),
    })
    expect(escaped).toContain('<code>pi&#124;&lt;script&gt;</code>')
    expect(escaped).toContain('<code>/line/one line/two</code>')
    expect(escaped).not.toContain('<script>')
  })

  it('uses journal-native provider sessions without a map and prefers them over old-run fallback', async () => {
    const runDir = await recursiveSteeringRuntimeRun('all')
    const root = 'recursive-steering-smoke'
    const child = `${root}:s0`
    const source = await readRuntimeSupervisorRun(runDir, {
      sessionBindings: [providerSession(root, 'stale-root'), providerSession(child, 'stale-child')],
    })
    const automatic = await readRuntimeSupervisorRun(runDir)

    expect(source.sessionLineage).toEqual(automatic.sessionLineage)
    expect(
      source.sessionLineage?.map((row) => ({
        nodeId: row.nodeId,
        backend: measuredProviderSession(row).backend,
        nativeSessionId: measuredProviderSession(row).nativeSessionId,
        nativePromptCount: measuredProviderSession(row).nativePromptCount,
        controllerOrdinals: measuredProviderSession(row).controllerTurns.map(
          (turn) => turn.ordinal,
        ),
      })),
    ).toEqual([
      {
        nodeId: root,
        backend: 'pi',
        nativeSessionId: 'same-native-id',
        nativePromptCount: 1,
        controllerOrdinals: [1],
      },
      {
        nodeId: child,
        backend: 'codex',
        nativeSessionId: 'same-native-id',
        nativePromptCount: 1,
        controllerOrdinals: [],
      },
    ])
  })

  it('keeps the provider-neutral Runtime tree when only one node has measured identity', async () => {
    const runDir = await recursiveSteeringRuntimeRun('child-only')
    const root = 'recursive-steering-smoke'
    const child = `${root}:s0`
    const source = await readRuntimeSupervisorRun(runDir)
    const report = analyzeSupervisorRunSources(source)

    expect(source.sessionLineage).toEqual([
      {
        nodeId: root,
        parentNodeId: null,
        depth: 0,
        childNodeIds: [child],
      },
      {
        nodeId: child,
        parentNodeId: root,
        depth: 1,
        childNodeIds: [],
        providerSession: expect.objectContaining({
          provider: 'custom-provider',
          backend: 'custom-harness',
          nativeSessionId: 'provider-neutral-native-id',
        }),
      },
    ])
    expect(source.sessionLineageMissingReason).toBe(
      `1/2 Runtime node(s) lack providerSession identity: ${JSON.stringify(root)}`,
    )
    expect(report.sessionLineage).toEqual(source.sessionLineage)
    expect(report.gaps).toContain(
      `sessionLineage: 1/2 Runtime node(s) lack providerSession identity: ${JSON.stringify(root)}`,
    )
    expect(report.gaps).toContain(
      `sessionLineage node ${JSON.stringify(child)} controller prompts: 0/1 exact; missing native prompt ordinal(s): 1`,
    )
    const markdown = renderSupervisorRunMarkdown(report)
    expect(markdown).toContain(
      `| <code>${root}</code> | — | 0 | 1 | unavailable | unavailable | unavailable | 0/? | unknown | unavailable |`,
    )
    expect(markdown).toContain(
      '| <code>custom-provider</code> | <code>custom-harness</code> | <code>provider-neutral-native-id</code> | 0/1 | 1 |',
    )
  })

  it('preserves missing identity while refusing ambiguous or reused provider session bindings', async () => {
    const runDir = await recursiveSteeringRuntimeRun()
    const root = 'recursive-steering-smoke'
    const child = `${root}:s0`
    const rootBinding = providerSession(root, 'session-root')

    const partial = await readRuntimeSupervisorRun(runDir, { sessionBindings: [rootBinding] })
    expect(partial.sessionLineage).toEqual([
      expect.objectContaining({ nodeId: root, providerSession: rootBinding }),
      expect.objectContaining({ nodeId: child }),
    ])
    expect(partial.sessionLineage?.[1]).not.toHaveProperty('providerSession')
    expect(partial.sessionLineageMissingReason).toMatch(
      /1\/2 Runtime node.*recursive-steering-smoke:s0/,
    )
    await expect(
      readRuntimeSupervisorRun(runDir, {
        sessionBindings: [
          rootBinding,
          { ...rootBinding, nativeSessionId: 'other-root-session' },
          providerSession(child, 'session-child'),
        ],
      }),
    ).rejects.toThrow(/recursive-steering-smoke".*2 provider session receipts/)
    await expect(
      readRuntimeSupervisorRun(runDir, {
        sessionBindings: [rootBinding, providerSession(child, 'session-root')],
      }),
    ).rejects.toThrow(/map to the same "pi" native session/)
  })

  it('snapshots each provider binding field before file I/O', async () => {
    const runDir = await recursiveSteeringRuntimeRun()
    const root = 'recursive-steering-smoke'
    const child = `${root}:s0`
    const reads = new Map<string, number>()
    const binding = (nodeId: string, nativeSessionId: string): RuntimeTraceSessionBinding => {
      const once = (field: string, value: string): string => {
        const key = `${nodeId}:${field}`
        const count = (reads.get(key) ?? 0) + 1
        reads.set(key, count)
        if (count > 1) throw new Error(`${key} was read more than once`)
        return value
      }
      return {
        get provider() {
          return once('provider', 'cli-bridge')
        },
        get backend() {
          return once('backend', 'pi')
        },
        get externalId() {
          return once('externalId', nodeId)
        },
        get nativeSessionId() {
          return once('nativeSessionId', nativeSessionId)
        },
        get cwd() {
          return once('cwd', `/workspaces/${encodeURIComponent(nodeId)}`)
        },
        get nativePromptCount() {
          once('nativePromptCount', 'read')
          return 1
        },
        get controllerTurns() {
          once('controllerTurns', 'read')
          return []
        },
      }
    }
    const mutable = [binding(root, 'native-root'), binding(child, 'native-child')]
    const reading = readRuntimeSupervisorRun(runDir, { sessionBindings: mutable })
    mutable.splice(0, mutable.length)
    const source = await reading

    expect(
      source.sessionLineage?.map((row) => measuredProviderSession(row).nativeSessionId),
    ).toEqual(['native-root', 'native-child'])
    expect([...reads.values()]).toEqual(Array(14).fill(1))
  })

  it('snapshots, validates, and deeply freezes lineage once at analysis intake', async () => {
    const runDir = await recursiveSteeringRuntimeRun()
    const source = await readRuntimeSupervisorRun(runDir, {
      sessionBindings: [
        {
          ...providerSession('recursive-steering-smoke', 'native-root'),
        },
        {
          ...providerSession('recursive-steering-smoke:s0', 'native-child', 'codex'),
        },
      ],
    })
    const mutable = source.sessionLineage?.map((row) => {
      const measured = measuredProviderSession(row)
      return {
        ...row,
        childNodeIds: [...row.childNodeIds],
        providerSession: {
          ...measured,
          controllerTurns: [...measured.controllerTurns],
        },
      }
    })
    if (mutable === undefined) throw new Error('expected joined lineage')
    const fieldReads = new Map<string, number>()
    const tracked = mutable.map(
      (row) =>
        new Proxy(row, {
          get(target, property, receiver) {
            if (typeof property === 'string' && property in target) {
              const key = `${target.nodeId}:${property}`
              const count = (fieldReads.get(key) ?? 0) + 1
              fieldReads.set(key, count)
              if (count > 1) throw new Error(`${key} was read more than once`)
            }
            return Reflect.get(target, property, receiver)
          },
        }),
    )
    let lineageReads = 0
    const report = analyzeSupervisorRunSources({
      ...source,
      get sessionLineage() {
        lineageReads += 1
        if (lineageReads > 1) throw new Error('sessionLineage was read more than once')
        return tracked
      },
    })

    mutable[0]!.nodeId = 'mutated-root'
    mutable[0]!.childNodeIds.push('mutated-child')
    mutable[0]!.providerSession.nativeSessionId = 'mutated-native-session'
    mutable[0]!.providerSession.controllerTurns.push({
      ordinal: 1,
      runId: 'mutated-run',
      bridgeRequestDigest: `sha256:${'f'.repeat(64)}`,
      promptSha256: `sha256:${'f'.repeat(64)}`,
      startedAt: 0,
      endedAt: 1,
    })
    expect(lineageReads).toBe(1)
    expect([...fieldReads.values()]).toEqual(Array(10).fill(1))
    expect(report.sessionLineage).toEqual(source.sessionLineage)
    expect(Object.isFrozen(report.sessionLineage)).toBe(true)
    if (isUnavailable(report.sessionLineage) || report.sessionLineage === undefined) {
      throw new Error('expected measured session lineage')
    }
    expect(Object.isFrozen(report.sessionLineage[0])).toBe(true)
    expect(Object.isFrozen(report.sessionLineage[0]?.childNodeIds)).toBe(true)
    expect(Object.isFrozen(report.sessionLineage[0]?.providerSession)).toBe(true)
    expect(Object.isFrozen(report.sessionLineage[0]?.providerSession?.controllerTurns)).toBe(true)
  })

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
