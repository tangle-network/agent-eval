/**
 * The change ledger through the command the package ships: Claude Code
 * transcripts and a ledger file in, the registry's intents out.
 *
 * | Session | Transcript | Ledger | Expected |
 * |---|---|---|---|
 * | `obs` | two typed turns; turn 1 runs `git commit` and `gh pr create`, turn 2 only reads | observed, a commit and a pull request under turn 1's calls, a merge naming no number | turn 1 joined to exactly its two changes, turn 2 none |
 * | `quiet` | one typed turn, no change in the transcript | observed, no change | none |
 * | `dark` | one typed turn, no change in the transcript | no row | not recorded, never none |
 * | `old` | one typed turn that merged a pull request by number, which the transcript names | no row | the transcript's change survives |
 * | `lead` and a subagent | the subagent commits | observed under the subagent's id | the commit is the subagent's, not the lead intent's |
 * | `gw` | two typed turns; turn 1 runs a command | a gateway's rows (no tool call id) keyed by the harness's session id: observed, two turns, a commit in turn 1's window | the commit joined to turn 1 only, turn 2 none |
 * | `gwshared` | one typed turn | a gateway turn that shared its checkout | not recorded, with a gap |
 * | `gwlate` | one typed turn, calls outside the window | a gateway commit whose window holds no call | not recorded, with a gap |
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseChangeLedger } from '../src/analyst'
import { runProcedureRegistryCommand } from '../src/procedure-registry'

let root: string
let projects: string
let ledgerFile: string
let registry: {
  intents: {
    intents: Array<{
      sessionId?: string
      changes: { status: string; refs?: string[] }
    }>
  }
}

type Step = { kind: 'turn'; text: string } | { kind: 'bash'; id: string; command: string; result: string }

function transcript(sessionId: string, steps: readonly Step[], agentId: string | null = null): string {
  const lines: unknown[] = []
  let previous: string | null = null
  let tick = 0
  const owner = agentId ?? sessionId
  const line = (type: 'user' | 'assistant', message: unknown): unknown => {
    const uuid = `${owner}-${tick}`
    const entry = {
      parentUuid: previous,
      isSidechain: agentId !== null,
      userType: 'external',
      cwd: '/work/app',
      sessionId,
      version: '0.0.0-fixture',
      type,
      uuid,
      timestamp: new Date(Date.parse('2026-11-10T10:00:00Z') + 60_000 * tick++).toISOString(),
      message,
      ...(agentId === null ? {} : { agentId }),
    }
    previous = uuid
    return entry
  }
  for (const step of steps) {
    if (step.kind === 'turn') {
      lines.push(line('user', { role: 'user', content: step.text }))
      continue
    }
    lines.push(
      line('assistant', {
        id: `msg_${step.id}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'tool_use', id: step.id, name: 'Bash', input: { command: step.command } }],
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
      line('user', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: step.id, content: step.result }],
      }),
    )
  }
  return `${lines.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

const row = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    v: 1,
    at: '2026-11-10T10:05:00.000Z',
    harness: 'claude-code',
    agentId: null,
    toolUseId: null,
    remote: null,
    sha: null,
    pr: null,
    ...fields,
  })

function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'change-ledger-'))
  projects = join(root, 'projects')
  ledgerFile = join(root, 'changes.jsonl')
  put(
    join(projects, 'app', 'obs.jsonl'),
    transcript('obs', [
      { kind: 'turn', text: 'ship the fix' },
      { kind: 'bash', id: 'toolu_c1', command: 'git commit -m fix', result: '[main abc1234] fix' },
      { kind: 'bash', id: 'toolu_p1', command: 'gh pr create', result: 'opened' },
      { kind: 'bash', id: 'toolu_m1', command: 'gh pr merge --auto', result: '' },
      { kind: 'turn', text: 'now explain it' },
      { kind: 'bash', id: 'toolu_r1', command: 'ls', result: 'a b' },
    ]),
  )
  put(
    join(projects, 'app', 'quiet.jsonl'),
    transcript('quiet', [
      { kind: 'turn', text: 'read this' },
      { kind: 'bash', id: 'toolu_q1', command: 'ls', result: 'a' },
    ]),
  )
  put(
    join(projects, 'app', 'dark.jsonl'),
    transcript('dark', [
      { kind: 'turn', text: 'read that' },
      { kind: 'bash', id: 'toolu_d1', command: 'ls', result: 'a' },
    ]),
  )
  put(
    join(projects, 'app', 'old.jsonl'),
    transcript('old', [
      { kind: 'turn', text: 'merge it' },
      { kind: 'bash', id: 'toolu_o1', command: 'gh pr merge 9 -R acme/widgets', result: '' },
    ]),
  )
  put(
    join(projects, 'app', 'lead.jsonl'),
    transcript('lead', [
      { kind: 'turn', text: 'delegate' },
      { kind: 'bash', id: 'toolu_l1', command: 'ls', result: 'a' },
    ]),
  )
  put(
    join(projects, 'app', 'lead', 'subagents', 'agent-sub1.jsonl'),
    transcript('lead', [
      { kind: 'turn', text: 'sub task' },
      { kind: 'bash', id: 'toolu_s1', command: 'git commit -m sub', result: '[main def5678] sub' },
    ], 'sub1'),
  )
  put(
    join(projects, 'app', 'gw.jsonl'),
    transcript('gw', [
      { kind: 'turn', text: 'ship the gateway fix' },
      { kind: 'bash', id: 'toolu_g1', command: 'make fix', result: 'ok' },
      { kind: 'turn', text: 'now read' },
      { kind: 'bash', id: 'toolu_g2', command: 'ls', result: 'a' },
    ]),
  )
  put(
    join(projects, 'app', 'gwshared.jsonl'),
    transcript('gwshared', [
      { kind: 'turn', text: 'shared checkout' },
      { kind: 'bash', id: 'toolu_h1', command: 'make fix', result: 'ok' },
    ]),
  )
  put(
    join(projects, 'app', 'gwlate.jsonl'),
    transcript('gwlate', [
      { kind: 'turn', text: 'late' },
      { kind: 'bash', id: 'toolu_i1', command: 'make fix', result: 'ok' },
    ]),
  )
  // A gateway names the turn, not the tool call: the transcript's calls sit at 10:01 and 10:04 (one minute per record).
  const gateway = (fields: Record<string, unknown>): string =>
    row({ source: 'cli-bridge', sessionId: 'bridge-1', turnId: 't', runId: 'r', ...fields })
  put(
    ledgerFile,
    [
      gateway({ nativeSessionId: 'gw', action: 'observed', at: '2026-11-10T10:03:00.000Z', turnStartedAt: '2026-11-10T10:00:30.000Z' }),
      gateway({ nativeSessionId: 'gw', action: 'turn', at: '2026-11-10T10:03:00.000Z', turnStartedAt: '2026-11-10T10:00:30.000Z', incomplete: null, headBefore: 'c'.repeat(40), head: 'd'.repeat(40) }),
      gateway({ nativeSessionId: 'gw', action: 'commit', at: '2026-11-10T10:03:00.000Z', turnStartedAt: '2026-11-10T10:00:30.000Z', remote: 'acme/widgets', sha: 'd'.repeat(40) }),
      gateway({ nativeSessionId: 'gw', action: 'push', at: '2026-11-10T10:03:00.000Z', turnStartedAt: '2026-11-10T10:00:30.000Z', remote: 'acme/widgets', sha: 'd'.repeat(40), branch: 'feature' }),
      gateway({ nativeSessionId: 'gw', action: 'turn', at: '2026-11-10T10:05:00.000Z', turnStartedAt: '2026-11-10T10:03:30.000Z', incomplete: null, headBefore: 'd'.repeat(40), head: 'd'.repeat(40) }),
      gateway({ nativeSessionId: 'gwshared', action: 'observed', at: '2026-11-10T10:03:00.000Z', turnStartedAt: '2026-11-10T10:00:30.000Z' }),
      gateway({ nativeSessionId: 'gwshared', action: 'turn', at: '2026-11-10T10:03:00.000Z', turnStartedAt: '2026-11-10T10:00:30.000Z', incomplete: 'shared-checkout' }),
      gateway({ nativeSessionId: 'gwlate', action: 'observed', at: '2026-11-10T10:30:00.000Z', turnStartedAt: '2026-11-10T10:20:00.000Z' }),
      gateway({ nativeSessionId: 'gwlate', action: 'turn', at: '2026-11-10T10:30:00.000Z', turnStartedAt: '2026-11-10T10:20:00.000Z', incomplete: null }),
      gateway({ nativeSessionId: 'gwlate', action: 'commit', at: '2026-11-10T10:30:00.000Z', turnStartedAt: '2026-11-10T10:20:00.000Z', remote: 'acme/widgets', sha: 'e'.repeat(40) }),
    ].join('\n') + '\n' + [
      row({ sessionId: 'obs', action: 'observed' }),
      row({ sessionId: 'obs', action: 'commit', toolUseId: 'toolu_c1', remote: 'acme/widgets', sha: 'a'.repeat(40) }),
      row({ sessionId: 'obs', action: 'pr-create', toolUseId: 'toolu_p1', remote: 'acme/widgets', pr: 41 }),
      row({ sessionId: 'obs', action: 'pr-merge', toolUseId: 'toolu_m1', remote: 'acme/widgets' }),
      row({ sessionId: 'quiet', action: 'observed' }),
      row({ sessionId: 'lead', agentId: 'sub1', action: 'observed' }),
      row({ sessionId: 'lead', agentId: 'sub1', action: 'commit', toolUseId: 'toolu_s1', remote: 'acme/widgets', sha: 'b'.repeat(40) }),
      'not a row',
    ].join('\n'),
  )
  let out = ''
  let err = ''
  const code = await runProcedureRegistryCommand(
    [projects, '--change-ledger', ledgerFile, '--intents', '--format', 'json'],
    { stdout: (t) => { out += t }, stderr: (t) => { err += t } },
  )
  expect(code, err).toBe(0)
  expect(err).toContain('1 lines are not rows')
  registry = JSON.parse(out)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const intentsOf = (text: string) =>
  registry.intents.intents.filter((intent) => JSON.stringify(intent).includes(text))

describe('change ledger', () => {
  it('reads rows by the format and counts a line that is not one', () => {
    const ledger = parseChangeLedger(
      [row({ sessionId: 's', action: 'observed' }), '{"v":2}', ''].join('\n'),
    )
    expect(ledger.rows).toBe(1)
    expect(ledger.malformed).toBe(1)
  })

  it('joins each intent to exactly the changes whose call lies in its span', () => {
    const obs = registry.intents.intents.filter((intent) => intent.changes.refs?.includes('acme/widgets#41'))
    expect(obs).toHaveLength(1)
    expect(obs[0]?.changes).toMatchObject({
      status: 'joined',
      refs: ['acme/widgets#41', `acme/widgets@${'a'.repeat(40)}`],
    })
  })

  it('reports an observed session without a change as none, and an unseen one as not recorded', () => {
    const statuses = registry.intents.intents.map((intent) => intent.changes.status).sort()
    // obs turn 2, quiet and gw turn 2 are none; dark, lead's own turn, gwshared and gwlate are not recorded.
    expect(statuses.filter((status) => status === 'none')).toHaveLength(3)
    expect(statuses.filter((status) => status === 'not-recorded')).toHaveLength(4)
  })

  it('keeps a change a transcript shows when the ledger never saw the session', () => {
    expect(intentsOf('acme/widgets#9').map((intent) => intent.changes.status)).toEqual(['joined'])
  })

  it('keys a subagent by its own id, so its commit is never the spawning session’s', () => {
    const ledger = parseChangeLedger(readFileSync(ledgerFile, 'utf8'))
    expect(ledger.sessions.get('claude-code\u0000sub1')?.changes).toHaveLength(1)
    expect(ledger.sessions.has('claude-code\u0000lead')).toBe(false)
    const refs = registry.intents.intents.flatMap((intent) => intent.changes.refs ?? [])
    expect(refs.filter((ref) => ref.endsWith(`@${'b'.repeat(40)}`))).toHaveLength(0)
  })

  it('places a gateway row, which names no tool call, on the turn whose window holds the session record\'s call', () => {
    const joined = registry.intents.intents.filter((intent) => intent.changes.refs?.includes(`acme/widgets@${'d'.repeat(40)}`))
    expect(joined).toHaveLength(1)
    expect(joined[0]?.changes).toMatchObject({ status: 'joined', refs: [`acme/widgets@${'d'.repeat(40)}`] })
    const quiet = registry.intents.intents.filter((intent) => intent.sessionId === 'gw' && intent.changes.status === 'none')
    expect(quiet).toHaveLength(1)
  })

  it('keys a gateway\'s rows by the harness\'s session id and counts a push as seen, not as a change', () => {
    const ledger = parseChangeLedger(readFileSync(ledgerFile, 'utf8'))
    expect(ledger.sessions.has('claude-code\u0000bridge-1')).toBe(false)
    expect(ledger.sessions.get('claude-code\u0000gw')).toMatchObject({ observed: true, unnamed: 0 })
    expect(ledger.sessions.get('claude-code\u0000gw')?.timed).toHaveLength(1)
  })

  it('leaves a session unknown, with a gap, when a gateway turn said its changes may be incomplete or no call lies in its window', () => {
    const intents = registry.intents.intents.filter((intent) => intent.sessionId === 'gwshared' || intent.sessionId === 'gwlate')
    expect(intents.map((intent) => intent.changes.status)).toEqual(['not-recorded', 'not-recorded'])
    const ledger = parseChangeLedger(readFileSync(ledgerFile, 'utf8'))
    expect(ledger.sessions.get('claude-code\u0000gwshared')?.incomplete.get('shared-checkout')).toBe(1)
  })
})
