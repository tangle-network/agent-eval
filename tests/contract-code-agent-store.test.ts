import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { observeCodeAgentStore } from '../src/contract'

/**
 * The measured defect this suite holds shut (discovery#80, defect 4).
 *
 * `q-zk-coral-alloc-superlinear` captured ZERO rollouts of its own and reported 903 subagent
 * actions. The 903 came from a time-window scan over `~/.codex/sessions`, which is every run's
 * store at once — including the operator's own interactive sessions. A count from that scan is not
 * evidence about a run, so the fixture store below deliberately holds foreign files and the tests
 * assert they are never counted.
 */
describe('observeCodeAgentStore', () => {
  let root = ''
  let sessionsDir = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'code-agent-store-'))
    sessionsDir = join(root, '2026', '09', '01')
    await mkdir(sessionsDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const RUN_WORKSPACE = '/work/pursuit/q-run'
  const RUN_STARTED_MS = Date.parse('2026-09-01T20:00:00.000Z')

  const line = (row: unknown) => `${JSON.stringify(row)}\n`

  const meta = (id: string, cwd: string, timestamp: string) =>
    line({
      timestamp,
      type: 'session_meta',
      payload: { id, timestamp, cwd, cli_version: '0.152.0', originator: 'codex-exec' },
    })

  /** One `spawn_agent` call, in the shape a rollout writes it. */
  const collabCall = (id: string, tool: string, timestamp: string) =>
    line({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { id, type: 'CollabAgentToolCall', tool, status: 'completed' },
      },
    })

  const shellCall = (id: string, timestamp: string) =>
    line({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { id, type: 'CommandExecution', command: 'ls', status: 'completed' },
      },
    })

  /** The run's own rollout: two native spawns and one shell call. */
  const ownRollout = () =>
    [
      meta('01a05e99-3b2e-7023-91e4-0b43ce7d5477', RUN_WORKSPACE, '2026-09-01T20:11:00.000Z'),
      collabCall('c1', 'spawn_agent', '2026-09-01T20:12:00.000Z'),
      collabCall('c2', 'wait_agent', '2026-09-01T20:13:00.000Z'),
      shellCall('s1', '2026-09-01T20:14:00.000Z'),
    ].join('')

  /** The operator's own interactive session, in the SAME store, with 903 subagent actions. */
  const foreignRollout = (count: number) =>
    [
      meta(
        '01a04724-5f1f-7061-a13b-276fbe7c69a7',
        '/home/operator/code/other',
        '2026-09-01T20:11:30.000Z',
      ),
      ...Array.from({ length: count }, (_, index) =>
        collabCall(`f${index}`, 'spawn_agent', '2026-09-01T20:12:00.000Z'),
      ),
    ].join('')

  /** A run that finished BEFORE this one started, still sitting in a shared store. */
  const staleRollout = () =>
    [
      meta('019ffee5-2ea9-7373-b75b-34b1de28fb18', RUN_WORKSPACE, '2026-08-14T06:11:00.000Z'),
      collabCall('old1', 'spawn_agent', '2026-08-14T06:12:00.000Z'),
    ].join('')

  it('counts only the run own sessions when the store also holds foreign ones', async () => {
    await writeFile(join(sessionsDir, 'rollout-own.jsonl'), ownRollout())
    await writeFile(join(sessionsDir, 'rollout-foreign.jsonl'), foreignRollout(903))

    const observed = await observeCodeAgentStore({
      root,
      source: 'codex',
      workspaceRoot: RUN_WORKSPACE,
      window: { startedAtMs: RUN_STARTED_MS },
    })

    expect(observed.status).toBe('observed')
    if (observed.status !== 'observed') return
    expect(observed.filesScanned).toBe(2)
    expect(observed.sessions).toHaveLength(1)
    // The 903 the ambient scan reported is never reachable from here.
    expect(observed.subagentActions).toBe(2)
    expect(observed.sessionsWithSubagentActions).toBe(1)
    expect(observed.actions).toBe(3)
    expect(observed.bySurface).toMatchObject({ subagent: 2 })
    expect(observed.rejections.byReason).toEqual({ 'outside-workspace': 1 })
  })

  it('rejects a session that ran in the same workspace before this run started', async () => {
    await writeFile(join(sessionsDir, 'rollout-own.jsonl'), ownRollout())
    await writeFile(join(sessionsDir, 'rollout-stale.jsonl'), staleRollout())

    const observed = await observeCodeAgentStore({
      root,
      source: 'codex',
      workspaceRoot: RUN_WORKSPACE,
      window: { startedAtMs: RUN_STARTED_MS },
    })

    expect(observed.status).toBe('observed')
    if (observed.status !== 'observed') return
    expect(observed.subagentActions).toBe(2)
    expect(observed.rejections.byReason).toEqual({ 'before-run': 1 })
  })

  it('rejects a session that started after the run finished', async () => {
    await writeFile(join(sessionsDir, 'rollout-own.jsonl'), ownRollout())
    await writeFile(
      join(sessionsDir, 'rollout-later.jsonl'),
      [
        meta('01a06000-0000-7000-8000-000000000001', RUN_WORKSPACE, '2026-09-02T04:00:00.000Z'),
        collabCall('later1', 'spawn_agent', '2026-09-02T04:01:00.000Z'),
      ].join(''),
    )

    const observed = await observeCodeAgentStore({
      root,
      source: 'codex',
      workspaceRoot: RUN_WORKSPACE,
      window: {
        startedAtMs: RUN_STARTED_MS,
        finishedAtMs: Date.parse('2026-09-01T23:00:00.000Z'),
      },
    })

    expect(observed.status).toBe('observed')
    if (observed.status !== 'observed') return
    expect(observed.subagentActions).toBe(2)
    expect(observed.rejections.byReason).toEqual({ 'after-run': 1 })
  })

  it('returns unavailable, and NO count, for a run that captured nothing of its own', async () => {
    await writeFile(join(sessionsDir, 'rollout-foreign.jsonl'), foreignRollout(903))

    const observed = await observeCodeAgentStore({
      root,
      source: 'codex',
      workspaceRoot: RUN_WORKSPACE,
      window: { startedAtMs: RUN_STARTED_MS },
    })

    expect(observed.status).toBe('unavailable')
    if (observed.status !== 'unavailable') return
    // This is the exact run that reported 903. The union makes that number unreachable, and a `0`
    // unreachable too: "captured nothing" is not "used no subagents".
    expect(observed).not.toHaveProperty('subagentActions')
    expect(observed.filesScanned).toBe(1)
    expect(observed.reason).toContain('no session in this store belongs to the run')
    expect(observed.rejections.sample).toEqual([
      { path: join(sessionsDir, 'rollout-foreign.jsonl'), reason: 'outside-workspace' },
    ])
  })

  it('returns unavailable for a store the harness never wrote', async () => {
    const observed = await observeCodeAgentStore({ root: join(root, 'absent'), source: 'codex' })

    expect(observed.status).toBe('unavailable')
    if (observed.status !== 'unavailable') return
    expect(observed.filesScanned).toBe(0)
    expect(observed.reason).toBe('the run captured no session files in this store')
  })

  it('fails closed on a session that records no workspace while a workspace filter is set', async () => {
    await writeFile(
      join(sessionsDir, 'rollout-anonymous.jsonl'),
      [
        line({
          timestamp: '2026-09-01T20:11:00.000Z',
          type: 'session_meta',
          payload: { id: 'anonymous-0001', timestamp: '2026-09-01T20:11:00.000Z' },
        }),
        collabCall('a1', 'spawn_agent', '2026-09-01T20:12:00.000Z'),
      ].join(''),
    )

    const observed = await observeCodeAgentStore({
      root,
      source: 'codex',
      workspaceRoot: RUN_WORKSPACE,
    })

    expect(observed.status).toBe('unavailable')
    if (observed.status !== 'unavailable') return
    expect(observed.rejections.byReason).toEqual({ 'no-workspace-recorded': 1 })
  })

  it('counts every session under an isolated store when no filter is given', async () => {
    await writeFile(join(sessionsDir, 'rollout-own.jsonl'), ownRollout())
    await writeFile(join(sessionsDir, 'rollout-child.jsonl'), ownRollout())

    const observed = await observeCodeAgentStore({ root, source: 'codex' })

    expect(observed.status).toBe('observed')
    if (observed.status !== 'observed') return
    expect(observed.sessions).toHaveLength(2)
    expect(observed.subagentActions).toBe(4)
    expect(observed.rejections.total).toBe(0)
  })

  it('names an unreadable or empty file instead of dropping it silently', async () => {
    await writeFile(join(sessionsDir, 'rollout-own.jsonl'), ownRollout())
    await writeFile(join(sessionsDir, 'rollout-empty.jsonl'), '')

    const observed = await observeCodeAgentStore({ root, source: 'codex' })

    expect(observed.status).toBe('observed')
    if (observed.status !== 'observed') return
    expect(observed.filesScanned).toBe(2)
    expect(observed.rejections.byReason).toEqual({ 'no-entries': 1 })
  })

  it('accepts a single session file as its own scope', async () => {
    const path = join(sessionsDir, 'rollout-own.jsonl')
    await writeFile(path, ownRollout())

    const observed = await observeCodeAgentStore({ root: path, source: 'codex' })

    expect(observed.status).toBe('observed')
    if (observed.status !== 'observed') return
    expect(observed.sessions.map((session) => session.path)).toEqual([path])
  })

  it('refuses a relative root, which is how a scan reaches the wrong store', async () => {
    await expect(
      observeCodeAgentStore({ root: '.codex/sessions', source: 'codex' }),
    ).rejects.toThrow(/must be an absolute path to this run's own store/)
  })
})
