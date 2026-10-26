/**
 * `agent-eval supervisor-run rollouts` end to end: a Discovery run directory
 * laid out as Runtime and Discovery write it, real harness-session fixtures
 * (Claude Code, OpenCode, a Kimi HOME), and beelink-gate receipts, into one
 * ledger read back through the public journal reader.
 */
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRolloutJournal } from '../rollout/ledger'
import { runSupervisorRunCommand } from './report-command'

const FIXTURES = join(import.meta.dirname, '../../tests/fixtures/harness-sessions')
const RUN = 'spec-build-20261025a'
const ROOT = RUN
const WORKER = `${RUN}:s0`
const TASK = `sha256:${'a'.repeat(64)}`
const ANSWER = `sha256:${'b'.repeat(64)}`

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rollouts-command-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

async function discoveryRun(): Promise<string> {
  const runDir = join(dir, 'discovery-runs', RUN)
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
          outRef: ANSWER,
          verdict: { valid: true, score: 1 },
          seq: 2,
          at: at(3),
        },
      },
    ]),
  )
  await writeFile(
    join(runDir, 'blobs', `${TASK.replace(':', '-')}.json`),
    JSON.stringify('Build csvstat to the spec.'),
  )
  await writeFile(
    join(runDir, 'blobs', `${ANSWER.replace(':', '-')}.json`),
    JSON.stringify('csvstat builds; 6 of 6 cases pass.'),
  )
  await writeFile(
    join(runDir, 'play-checks.jsonl'),
    jsonl([
      {
        at: at(4),
        solved: false,
        known: true,
        exitCode: 2,
        commit: 'c'.repeat(40),
        detail: 'SCORE {"stage":"hidden","reached":3,"of":6}',
      },
      {
        at: at(5),
        solved: false,
        known: false,
        exitCode: null,
        commit: null,
        detail: 'repo check waiting for Beelink',
      },
    ]),
  )
  const repo = join(runDir, 'deliverables.git')
  const git = (...args: string[]) =>
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.com',
      // A throwaway fixture repo: the host's global commit hooks guard real work, not this.
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ])
  await mkdir(repo)
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'base')
  git('branch', 'workers/root')
  git('switch', '-q', '-c', 'workers/builder')
  git('commit', '-q', '--allow-empty', '-m', 'one')
  git('commit', '-q', '--allow-empty', '-m', 'two')
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
  it('imports a Discovery run, harness sessions and gate receipts into one screened ledger', async () => {
    const out = join(dir, 'ledger.jsonl')
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runSupervisorRunCommand(
      [
        'rollouts',
        await discoveryRun(),
        '--sessions',
        `claude-code:${join(FIXTURES, 'claude-code.jsonl')}`,
        '--sessions',
        join(FIXTURES, 'opencode.db'),
        '--sessions',
        `kimi-code:${await kimiHome()}`,
        '--gate-receipts',
        await gateReceipts(),
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
    expect(root.task.suite).toBe('discovery/spec-build')
    expect(root.outcome.reward).toBe(0.5)
    expect(root.outcome.reward_source).toBe('discovery/play-check')
    expect(root.policy).toMatchObject({
      harness: 'opencode',
      provider: 'zai-coding-plan',
      model: 'glm-5.3',
      license_class: 'open-weight-api',
    })
    expect(root.outcome.metrics.deliverable_commits).toBe(0)

    const worker = byId.get(WORKER)!
    expect(worker.role).toBe('worker')
    expect(worker.parent_rollout_id).toBe(ROOT)
    expect(worker.policy).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4',
      license_class: 'open-weight-api',
    })
    expect(worker.messages).toEqual([
      { role: 'user', content: 'Build csvstat to the spec.' },
      { role: 'assistant', content: 'csvstat builds; 6 of 6 cases pass.' },
    ])
    expect(worker.outcome.reward).toBe(1)
    expect(worker.outcome.metrics).toMatchObject({ deliverable_commits: 2 })

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
