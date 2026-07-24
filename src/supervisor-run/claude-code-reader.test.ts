import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeSupervisorRunSources } from './analyze'
import { claudeCodeSupervisorRunReader, readClaudeCodeSupervisorRun } from './claude-code-reader'
import { supervisorRunRolloutLines } from './rollout-nodes'
import { isUnavailable } from './types'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-tree-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const T0 = Date.parse('2026-07-23T00:00:00.000Z')
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString()
const jsonl = (rows: unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`

const assistantTool = (sec: number, id: string, name: string, input: unknown) => ({
  type: 'assistant',
  timestamp: at(sec),
  message: {
    role: 'assistant',
    model: 'claude-x',
    content: [{ type: 'tool_use', id, name, input }],
  },
})

const toolResult = (sec: number, id: string, structured: unknown, text = '') => ({
  type: 'user',
  timestamp: at(sec),
  toolUseResult: structured,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }],
  },
})

const notification = (sec: number, taskId: string, status = 'completed', summary = 'finished') => ({
  type: 'user',
  timestamp: at(sec),
  message: {
    role: 'user',
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
  },
})

const assistantUsage = (sec: number, usage: Record<string, number>, text = 'thinking') => ({
  type: 'assistant',
  timestamp: at(sec),
  message: {
    role: 'assistant',
    id: `msg-${sec}`,
    model: 'claude-x',
    usage,
    content: [{ type: 'text', text }],
  },
})

interface Session {
  sessionId: string
  transcriptPath: string
  subagentsDir: string
}

/** A two-worker session: both spawned, one steered, one cancelled. */
async function writeSession(): Promise<Session> {
  const sessionId = 'sess-1'
  const transcriptPath = join(dir, `${sessionId}.jsonl`)
  const subagentsDir = join(dir, sessionId, 'subagents')
  await mkdir(subagentsDir, { recursive: true })

  await writeFile(
    transcriptPath,
    jsonl([
      { type: 'user', timestamp: at(0), message: { role: 'user', content: 'do the thing' } },
      assistantTool(10, 'tu-a', 'Agent', {
        description: 'build A',
        subagent_type: 'general-purpose',
      }),
      toolResult(11, 'tu-a', {
        agentId: 'ag-a',
        status: 'async_launched',
        resolvedModel: 'claude-x',
      }),
      assistantTool(12, 'tu-b', 'Agent', {
        description: 'build B',
        subagent_type: 'general-purpose',
      }),
      toolResult(13, 'tu-b', {
        agentId: 'ag-b',
        status: 'async_launched',
        resolvedModel: 'claude-x',
      }),
      assistantTool(30, 'tu-s', 'SendMessage', { to: 'ag-a', message: 'change course' }),
      toolResult(31, 'tu-s', { success: true, resumedAgentId: 'ag-a' }),
      notification(60, 'ag-a'),
      assistantTool(70, 'tu-k', 'TaskStop', { agentId: 'ag-b' }),
      toolResult(71, 'tu-k', { success: true }),
      assistantUsage(80, {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 400,
      }),
    ]),
  )

  await writeFile(
    join(subagentsDir, 'agent-ag-a.jsonl'),
    jsonl([
      {
        type: 'user',
        isSidechain: true,
        agentId: 'ag-a',
        timestamp: at(11),
        message: { role: 'user', content: 'build A' },
      },
      {
        type: 'assistant',
        isSidechain: true,
        agentId: 'ag-a',
        timestamp: at(59),
        message: {
          role: 'assistant',
          id: 'm1',
          model: 'claude-x',
          usage: {
            input_tokens: 7,
            output_tokens: 11,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 20,
          },
          content: [{ type: 'text', text: 'A is done: 3 files changed' }],
        },
      },
    ]),
  )
  await writeFile(
    join(subagentsDir, 'agent-ag-a.meta.json'),
    JSON.stringify({
      agentType: 'general-purpose',
      description: 'build A',
      toolUseId: 'tu-a',
      spawnDepth: 1,
    }),
  )
  return { sessionId, transcriptPath, subagentsDir }
}

describe('claudeCodeSupervisorRunReader', () => {
  it('recovers the tree: spawns, settle, steer, cancel, parentage', async () => {
    const s = await writeSession()
    const src = await readClaudeCodeSupervisorRun({
      transcriptPath: s.transcriptPath,
      subagentsDir: s.subagentsDir,
    })
    const report = analyzeSupervisorRunSources(src)

    expect(report.orchestration.workersSpawned).toBe(2)
    expect(report.orchestration.workersSettled).toBe(1)
    expect(report.orchestration.workersCancelled).toBe(1)
    expect(report.orchestration.maxConcurrency).toBe(2)
    expect(report.supervisorId).toBe(s.sessionId)
    expect(report.orchestration.delegationDepth).toBe(1)
  })

  it('reports steers as a REAL count — Claude Code can message a live subagent', async () => {
    const s = await writeSession()
    const report = analyzeSupervisorRunSources(
      await readClaudeCodeSupervisorRun({
        transcriptPath: s.transcriptPath,
        subagentsDir: s.subagentsDir,
      }),
    )
    expect(report.orchestration.steers).toBe(1)
    expect(report.orchestration.steersDelivered).toBe(1)
    expect(report.orchestration.steersByWorker).toEqual([
      { worker: 'build A', queued: 1, delivered: 1 },
      { worker: 'build B', queued: 0, delivered: 0 },
    ])
  })

  it('reports a run with no SendMessage as steers=0, NOT unavailable', async () => {
    const transcriptPath = join(dir, 'quiet.jsonl')
    await writeFile(
      transcriptPath,
      jsonl([
        assistantTool(1, 'tu-a', 'Agent', { description: 'solo' }),
        toolResult(2, 'tu-a', { agentId: 'ag-a', status: 'async_launched' }),
        notification(9, 'ag-a'),
      ]),
    )
    const report = analyzeSupervisorRunSources(
      await readClaudeCodeSupervisorRun({ transcriptPath, subagentsDir: null }),
    )
    expect(report.orchestration.steers).toBe(0)
    expect(isUnavailable(report.orchestration.steers)).toBe(false)
  })

  it('never fabricates $0: an unpriced store reports usd unavailable with the reason', async () => {
    const s = await writeSession()
    const report = analyzeSupervisorRunSources(
      await readClaudeCodeSupervisorRun({
        transcriptPath: s.transcriptPath,
        subagentsDir: s.subagentsDir,
      }),
    )
    for (const v of [
      report.economics.totalUsd,
      report.economics.brain.usd,
      report.economics.workers.usd,
    ]) {
      expect(isUnavailable(v)).toBe(true)
      if (isUnavailable(v)) expect(v.unavailable).toMatch(/never a price/)
    }
    // Tokens ARE in the store, so they stay real numbers.
    expect(report.economics.brain.tokensIn).toBe(100)
    expect(report.economics.brain.cacheRead).toBe(9000)
    expect(report.economics.workers.tokensOut).toBe(11)
    expect(report.economics.workers.cacheRead).toBe(500)
  })

  it('never fabricates "0 accepted": no verify step means the verdict is unavailable', async () => {
    const s = await writeSession()
    const report = analyzeSupervisorRunSources(
      await readClaudeCodeSupervisorRun({
        transcriptPath: s.transcriptPath,
        subagentsDir: s.subagentsDir,
      }),
    )
    for (const v of [
      report.decision.accepted,
      report.decision.rejected,
      report.decision.settledVerdicts,
    ]) {
      expect(isUnavailable(v)).toBe(true)
      if (isUnavailable(v)) expect(v.unavailable).toMatch(/no per-worker verify/)
    }
    // Settle STATUS is recorded, so the status histogram is real.
    expect(report.decision.settledByStatus).toEqual({ completed: 1, cancelled: 1 })
  })

  it('returns the subagent closing message as worker evidence', async () => {
    const s = await writeSession()
    const report = analyzeSupervisorRunSources(
      await readClaudeCodeSupervisorRun({
        transcriptPath: s.transcriptPath,
        subagentsDir: s.subagentsDir,
      }),
    )
    expect(report.decision.workerEvidenceBytes).toBe('A is done: 3 files changed'.length)
  })

  it('names the spawns whose transcripts the harness pruned', async () => {
    const s = await writeSession()
    const src = await readClaudeCodeSupervisorRun({
      transcriptPath: s.transcriptPath,
      subagentsDir: s.subagentsDir,
    })
    // `build B` was spawned but has no retained transcript.
    expect(src.harnessMissingReason).toMatch(/1\/2 spawned agents have no retained transcript/)
    expect(src.harnessWorkerTokens).toMatchObject({ sessions: 1, output: 11 })
  })

  it('recovers a second delegation level from a child that spawns', async () => {
    const sessionId = 'deep'
    const transcriptPath = join(dir, `${sessionId}.jsonl`)
    const subagentsDir = join(dir, sessionId, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(
      transcriptPath,
      jsonl([
        assistantTool(1, 'tu-a', 'Agent', { description: 'lead' }),
        toolResult(2, 'tu-a', { agentId: 'ag-a', status: 'async_launched' }),
        notification(90, 'ag-a'),
      ]),
    )
    await writeFile(
      join(subagentsDir, 'agent-ag-a.jsonl'),
      jsonl([
        {
          type: 'user',
          isSidechain: true,
          agentId: 'ag-a',
          timestamp: at(2),
          message: { role: 'user', content: 'lead' },
        },
        {
          type: 'assistant',
          isSidechain: true,
          agentId: 'ag-a',
          timestamp: at(10),
          message: {
            role: 'assistant',
            id: 'm1',
            model: 'claude-x',
            content: [
              { type: 'tool_use', id: 'tu-c', name: 'Agent', input: { description: 'grandchild' } },
            ],
          },
        },
        {
          type: 'user',
          isSidechain: true,
          agentId: 'ag-a',
          timestamp: at(11),
          toolUseResult: { agentId: 'ag-c', status: 'async_launched' },
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu-c', content: [] }],
          },
        },
      ]),
    )
    const src = await readClaudeCodeSupervisorRun({ transcriptPath, subagentsDir })
    const report = analyzeSupervisorRunSources(src)
    expect(report.orchestration.workersSpawned).toBe(2)
    expect(report.orchestration.delegationDepth).toBe(2)

    const tree = supervisorRunRolloutLines(src)
    const grandchild = tree.nodes.find((n) => n.rollout_id === 'ag-c')
    expect(grandchild?.parent_rollout_id).toBe('ag-a')
  })

  it('mints rollout rows joined by parent_rollout_id, with honest nulls for unpriced cost', async () => {
    const s = await writeSession()
    const src = await readClaudeCodeSupervisorRun({
      transcriptPath: s.transcriptPath,
      subagentsDir: s.subagentsDir,
    })
    const tree = supervisorRunRolloutLines(src, {
      supervisorHarness: 'claude-code',
      workerHarness: 'claude-code',
    })
    expect(tree.rootId).toBe(s.sessionId)
    expect(tree.nodes).toHaveLength(3)
    const root = tree.nodes.find((n) => n.role === 'supervisor')
    const workers = tree.nodes.filter((n) => n.role === 'worker')
    expect(root?.parent_rollout_id).toBeNull()
    expect(workers.every((w) => w.parent_rollout_id === s.sessionId)).toBe(true)
    // Unpriced store: usd must be null, never 0.
    expect(root?.cost.usd).toBeNull()
    expect(workers.every((w) => w.cost.usd === null)).toBe(true)
    // A worker with no retained transcript reports null tokens, not 0.
    const pruned = workers.find((w) => w.artifacts.transcript_ref === null)
    expect(pruned?.cost.tokens_in).toBeNull()
    // The root row points at the real session transcript, not a loops path.
    expect(root?.artifacts.transcript_ref).toBe(s.transcriptPath)
  })

  it('an unreadable transcript reports the reason instead of an empty tree', async () => {
    const src = await readClaudeCodeSupervisorRun({ transcriptPath: join(dir, 'nope.jsonl') })
    expect(src.journal).toBeNull()
    expect(src.workers).toBeNull()
    expect(src.workersMissingReason).toMatch(/unreadable/)
    const report = analyzeSupervisorRunSources(src)
    expect(isUnavailable(report.orchestration.workersSpawned)).toBe(true)
    expect(isUnavailable(report.orchestration.steers)).toBe(true)
  })

  it('exposes the SupervisorRunReader contract loops implements', async () => {
    const s = await writeSession()
    const reader = claudeCodeSupervisorRunReader({
      transcriptPath: s.transcriptPath,
      subagentsDir: s.subagentsDir,
      arm: 'claude-code',
    })
    expect(reader.runRef).toBe(s.transcriptPath)
    const report = analyzeSupervisorRunSources(await reader.read())
    expect(report.arm).toBe('claude-code')
    expect(report.traceCommand).toContain('--harness claude-code')
  })
})
