/**
 * `agent-eval supervisor-run rollouts` end to end: a run directory laid out
 * as Runtime writes it, real harness-session fixtures
 * (Claude Code, OpenCode, a Kimi HOME), and beelink-gate receipts, into one
 * ledger read back through the public journal reader.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertMintedLines } from '../rollout'
import { toHarborTrajectories } from '../rollout/interchange/harbor'
import { readRolloutJournal } from '../rollout/ledger'
import { runSupervisorRunCommand } from './report-command'
import { type RunVerdict, runtimeRunRolloutLines } from './runtime-rollouts'

const FIXTURES = join(import.meta.dirname, '../../tests/fixtures/harness-sessions')
const RUN = 'spec-build-20261025a'
const ROOT = RUN
const WORKER = `${RUN}:s0`
const TASK = `sha256:${'a'.repeat(64)}`
const ANSWER = `sha256:${'b'.repeat(64)}`
const STEER = `sha256:${'c'.repeat(64)}`
const STEERED = `sha256:${'d'.repeat(64)}`
const RETURNED = `sha256:${'e'.repeat(64)}`

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rollouts-command-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

async function runtimeRun(end?: { unansweredAt: string }): Promise<string> {
  const runDir = join(dir, 'runs', RUN)
  await mkdir(join(runDir, 'blobs'), { recursive: true })
  const at = (m: number) => `2026-10-25T0${m}:00:00.000Z`
  await writeFile(
    join(runDir, 'spawn-journal.jsonl'),
    jsonl([
      { kind: 'begin', root: ROOT, at: at(1) },
      {
        kind: 'events',
        root: ROOT,
        events: [{ kind: 'spawned', id: ROOT, label: 'root', runtime: 'cli', seq: 0, at: at(1) }],
      },
      {
        kind: 'event',
        root: ROOT,
        event: {
          kind: 'root-segment',
          id: ROOT,
          to: { provider: 'zai-coding-plan', model: 'glm-5.3', harness: 'opencode' },
          seq: 0,
          at: at(1),
        },
      },
      {
        kind: 'events',
        root: ROOT,
        events: [
          {
            kind: 'spawned',
            id: WORKER,
            parent: ROOT,
            label: 'builder',
            runtime: 'driver',
            identity: { taskDigest: TASK },
            seq: 1,
            at: at(2),
          },
        ],
      },
      {
        kind: 'event',
        root: ROOT,
        event: {
          kind: 'materialized',
          id: WORKER,
          receipt: {
            status: 'known',
            model: { status: 'known', id: 'opencode/deepseek/deepseek-v4' },
          },
          seq: 0,
          at: at(2),
        },
      },
      {
        kind: 'event',
        root: ROOT,
        event: {
          kind: 'settled',
          id: WORKER,
          status: 'done',
          outRef: RETURNED,
          verdict: { valid: true, score: 1 },
          seq: 5,
          at: at(3),
        },
      },
      ...[
        { kind: 'execution-input', taskRef: TASK },
        { kind: 'execution-result', outRef: ANSWER },
        { kind: 'execution-input', taskRef: STEER },
        { kind: 'execution-result', outRef: STEERED },
      ].map((event, seq) => ({
        kind: 'event',
        root: ROOT,
        event: { ...event, id: WORKER, seq: seq + 1, at: at(2) },
      })),
      ...(end === undefined
        ? []
        : [
            {
              kind: 'event',
              root: ROOT,
              event: { kind: 'execution-input', id: ROOT, taskRef: STEER, seq: 9, at: end.unansweredAt },
            },
          ]),
    ]),
  )
  await writeFile(
    join(runDir, 'blobs', `${TASK.replace(':', '-')}.json`),
    JSON.stringify('Build csvstat to the spec.'),
  )
  await writeFile(
    join(runDir, 'blobs', `${ANSWER.replace(':', '-')}.json`),
    JSON.stringify({
      content: 'csvstat builds; 6 of 6 cases pass.',
      events: [
        { type: 'message.part.updated', data: { part: { id: 'p1', messageID: 'm1', type: 'text', text: 'Running the cases.' } } },
        { type: 'message.part.updated', data: { part: { id: 'p2', messageID: 'm1', type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'running', input: { command: 'pnpm test' } } } } },
        { type: 'message.part.updated', data: { part: { id: 'p2', messageID: 'm1', type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: { command: 'pnpm test' }, output: '6 passed' } } } },
        { type: 'message.part.updated', data: { part: { id: 'p3', messageID: 'm2', type: 'text', text: 'csvstat builds; 6 of 6 cases pass.' } } },
      ],
    }),
  )
  const blob = (ref: string, value: unknown) =>
    writeFile(join(runDir, 'blobs', `${ref.replace(':', '-')}.json`), JSON.stringify(value))
  await blob(STEER, 'Recheck the last case.')
  await blob(STEERED, { content: 'Still 6 of 6.', events: [] })
  await blob(RETURNED, { cases: 6, passed: 6 })
  return runDir
}

async function kimiHome(): Promise<string> {
  const home = join(dir, 'home')
  const session = join(home, '.kimi', 'sessions', 'f'.repeat(32), 'kimi-session-1')
  await mkdir(session, { recursive: true })
  await copyFile(join(FIXTURES, 'kimi', 'parent', 'wire.jsonl'), join(session, 'wire.jsonl'))
  return home
}

async function gateReceipts(): Promise<string> {
  const path = join(dir, 'receipts.jsonl')
  const receipt = (exit: number, sha: string, command = 'pnpm test') => ({
    at: '2026-10-25T23:53:59Z',
    repo: 'github.com/tangle-network/agent-eval',
    sha,
    command,
    exit,
    gate_id: `beelink1-${sha.slice(0, 8)}`,
    timed_out: false,
    watchdog: false,
    ran_s: 53,
  })
  await writeFile(
    path,
    jsonl([
      receipt(0, '1'.repeat(40)),
      receipt(1, '2'.repeat(40)),
      receipt(75, '3'.repeat(40)),
      receipt(
        0,
        '4'.repeat(40),
        `export KEY=${['sk-', 'ant-oat01-', 'ZyXwVu9876543210abcd'].join('')}`,
      ),
    ]),
  )
  return path
}

describe('supervisor-run rollouts', () => {
  const verdict = (fields: Partial<RunVerdict> = {}): RunVerdict => ({ reward: 1, screened: false, source: 'suite/check', ...fields })

  it('trains on a screened reward, gates a contradicted one, and refuses an unscreened one', async () => {
    const run = await runtimeRun()
    const root = async (fields: Partial<RunVerdict>) => {
      const { lines } = await runtimeRunRolloutLines(run, { verdict: verdict(fields) })
      return lines.find((line) => line.rollout_id === ROOT)!
    }
    const screened = await root({ screened: true })
    expect(screened.outcome).toMatchObject({ reward: 1, realness_gated: false, realness_screened: true, reward_source: 'suite/check' })
    expect(() => assertMintedLines([screened])).not.toThrow()
    const gated = await root({ screened: true, gated: true })
    expect(gated.outcome).toMatchObject({ reward: 0, realness_gated: true, realness_screened: true })
    const unscreened = await root({})
    expect(unscreened.outcome.realness_screened).toBe(false)
    expect(() => assertMintedLines([unscreened])).toThrow(/realness_screened/)
  })

  it('completes a run stopped on its success, not one cut before it', async () => {
    const outcomeWhen = async (stoppedAt: string, unansweredAt: string) => {
      const run = await runtimeRun({ unansweredAt })
      const { lines } = await runtimeRunRolloutLines(run, { verdict: verdict({ screened: true, stoppedAt }) })
      await rm(run, { recursive: true })
      return lines.find((line) => line.rollout_id === ROOT)!.outcome
    }
    const earlier = '2026-10-25T04:00:00.000Z'
    const later = '2026-10-25T05:00:00.000Z'
    expect(await outcomeWhen(earlier, later)).toMatchObject({ is_completed: true, error: null })
    expect(await outcomeWhen(later, earlier)).toMatchObject({ is_completed: false })
  })

  it('exports a real episode as a Harbor trajectory with its tool calls', async () => {
    const { lines } = await runtimeRunRolloutLines(await runtimeRun())
    const steps = toHarborTrajectories(lines).flatMap((t) => [t, ...(t.subagent_trajectories ?? [])]).flatMap((t) => t.steps)
    expect(steps.flatMap((s) => s.tool_calls ?? []).map((c) => c.function_name)).toEqual(['bash'])
  })

  it('imports a Runtime run, harness sessions and gate receipts into one screened ledger', async () => {
    const out = join(dir, 'ledger.jsonl')
    const otlp = join(dir, 'spans.otlp.jsonl')
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runSupervisorRunCommand(
      [
        'rollouts',
        await runtimeRun(),
        '--sessions',
        `claude-code:${join(FIXTURES, 'claude-code.jsonl')}`,
        '--sessions',
        join(FIXTURES, 'opencode.db'),
        '--sessions',
        `kimi-code:${await kimiHome()}`,
        '--gate-receipts',
        await gateReceipts(),
        '--otlp',
        otlp,
        '--out',
        out,
      ],
      { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
    )
    expect(stderr.join('')).toBe('')
    expect(code).toBe(0)
    const summary = JSON.parse(stdout.join(''))
    expect(summary.dropped['api-key']).toBe(1)
    expect(summary.sources[0]).toMatchObject({ kind: 'run-dir', read: 2, written: 2 })

    const lines = await readRolloutJournal(out)
    expect(summary.written).toBe(lines.length)
    const byId = new Map(lines.map((line) => [line.rollout_id, line]))

    const root = byId.get(ROOT)!
    expect(root.task.suite).toBe(`runtime/${RUN}`)
    expect(root.policy).toMatchObject({
      harness: 'opencode',
      provider: 'zai-coding-plan',
      model: 'glm-5.3',
      license_class: 'open-weight-api',
    })

    const worker = byId.get(WORKER)!
    expect(worker.role).toBe('worker')
    expect(worker.parent_rollout_id).toBe(ROOT)
    expect(worker.policy).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4',
      license_class: 'open-weight-api',
    })
    expect(worker.messages).toMatchObject([
      { role: 'user', content: 'Build csvstat to the spec.' },
      { role: 'assistant', content: 'Running the cases.', tool_calls: [{ function: { name: 'bash' } }] },
      { role: 'tool', name: 'bash', content: '6 passed' },
      { role: 'assistant', content: 'csvstat builds; 6 of 6 cases pass.' },
      { role: 'user', content: 'Recheck the last case.' },
      { role: 'assistant', content: 'Still 6 of 6.' },
    ])
    expect(worker.provenance.lossy_projection).toBeUndefined()
    const spans = (await readFile(otlp, 'utf8')).trim().split('\n')
    expect(spans.some((span) => JSON.parse(span).name.includes('bash'))).toBe(true)
    expect(worker.outcome.reward).toBe(1)

    const sessions = lines.filter((line) => line.task.suite.startsWith('harness/'))
    const harnesses = new Set(sessions.map((line) => line.policy.harness))
    expect(harnesses).toEqual(new Set(['claude-code', 'opencode', 'kimi-code']))
    for (const line of sessions) {
      expect(line.messages.length).toBeGreaterThan(0)
      expect(line.outcome.reward).toBeNull()
    }
    expect(sessions.find((l) => l.policy.harness === 'claude-code')!.policy.license_class).toBe(
      'restricted',
    )
    expect(sessions.find((l) => l.policy.harness === 'kimi-code')!.policy.license_class).toBe(
      'open-weight-api',
    )

    const gates = lines.filter((line) => line.policy.harness === 'beelink-gate')
    expect(gates.map((line) => [line.task.instance_id, line.outcome.reward])).toEqual([
      ['1'.repeat(40), 1],
      ['2'.repeat(40), 0],
    ])
    expect(await readFile(out, 'utf8')).not.toContain('sk-ant')
  })
})
