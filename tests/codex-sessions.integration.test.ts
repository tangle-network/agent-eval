/**
 * Codex rollouts through the command the package ships: a Codex sessions
 * directory and a change ledger in, the registry's skills and intents out.
 * Every prompt, path, id and repository in the rollouts is invented; their
 * shapes are those Codex 0.172 writes.
 *
 * | Session | Rollout | Ledger | Expected |
 * |---|---|---|---|
 * | `direct` | turn 1 reads the `tidy` skill with `sed`, then commits with `exec_command`; turn 2 only lists files | observed, a commit under the call's own id | turn 1 holds the skill and exactly the commit; turn 2 none |
 * | `coded` | turn 1 commits from inside a code-mode `exec` script; turn 2 lists files | observed, a commit under the script command's `exec-` id | the commit joins turn 1 through the alias, not turn 2 |
 * | `fan` | two `exec` scripts open at once, each running a command | observed, a commit under one `exec-` id | the commit cannot be placed, and the session says so |
 * | `dark` | one turn, no change | no row | not recorded, never none |
 * | `child` | a subagent thread forked from `direct`, one commit | observed under its own id | the thread is `direct`'s child and holds the commit; Codex writes a subagent's first message as a spawn, not a typed turn, so it has no intent |
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcedureRegistryCommand } from '../src/procedure-registry'
import { codexSkillSessions, readChangeLedger, withChangeLedger } from '../src/skill-usage'
import { runSkillUsageCommand } from '../src/skill-usage/command'

const TIDY = '# Tidy\n\nRemove dead code, then run the checks.\n'
const uuid = (n: number): string => `0000000${n}-0000-7000-8000-00000000000${n}`

let root: string
let sessions: string
let ledgerFile: string
let registry: {
  versions: Array<{ key: string; names: string[]; sessions: { invocations: number } }>
  intents: {
    intents: Array<{
      sessionId?: string
      changes: { status: string; refs?: string[] }
    }>
  }
}

type Line = Record<string, unknown>

/** The lines of one rollout, built from the steps the session took. */
class Rollout {
  readonly lines: Line[] = []
  private tick = 0
  constructor(
    readonly id: string,
    parent: string | null = null,
  ) {
    this.push('session_meta', {
      id,
      session_id: id,
      cwd: '/work/app',
      originator: 'codex_exec',
      cli_version: '0.172.0',
      source: parent === null ? 'exec' : { subagent: { thread_spawn: { parent_thread_id: parent } } },
      ...(parent === null ? {} : { parent_thread_id: parent, forked_from_id: parent }),
    })
    this.push('event_msg', { type: 'task_started', turn_id: `${id}-t` })
  }
  private push(type: string, payload: Line): void {
    this.lines.push({
      timestamp: new Date(Date.parse('2026-11-10T10:00:00Z') + 60_000 * this.tick++).toISOString(),
      type,
      payload,
    })
  }
  turn(text: string): this {
    this.push('response_item', {
      type: 'message',
      id: `msg-${this.tick}`,
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
    return this
  }
  private response(): void {
    this.push('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 100 * this.tick, output_tokens: 10, total_tokens: 100 * this.tick + 10 },
        last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    })
  }
  /** `exec_command`: the hook sees the call's own id. */
  direct(callId: string, cmd: string, output: string): this {
    this.push('response_item', {
      type: 'function_call',
      call_id: callId,
      name: 'exec_command',
      arguments: JSON.stringify({ cmd }),
    })
    this.push('response_item', { type: 'function_call_output', call_id: callId, output })
    this.response()
    return this
  }
  /** A code-mode `exec` script. `ran` are the ids its commands completed under, in order. */
  script(callId: string, cmd: string, ran: readonly string[], output: string): this {
    this.open(callId, cmd)
    for (const id of ran) this.completed(id)
    this.close(callId, output)
    return this
  }
  open(callId: string, cmd: string): this {
    this.push('response_item', {
      type: 'custom_tool_call',
      call_id: callId,
      name: 'exec',
      input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}))`,
    })
    return this
  }
  completed(id: string): this {
    this.push('event_msg', {
      type: 'item_completed',
      item: { type: 'CommandExecution', id, status: 'completed', command: ['/bin/zsh', '-lc', 'x'] },
    })
    return this
  }
  close(callId: string, output: string): this {
    this.push('response_item', {
      type: 'custom_tool_call_output',
      call_id: callId,
      output: [{ type: 'input_text', text: output }],
    })
    this.response()
    return this
  }
  text(): string {
    return `${this.lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  }
}

const row = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    v: 1,
    at: '2026-11-10T10:05:00.000Z',
    harness: 'codex',
    agentId: null,
    toolUseId: null,
    remote: null,
    sha: null,
    pr: null,
    ...fields,
  })

function write(session: Rollout): void {
  const file = join(sessions, '2026', '11', '10', `rollout-2026-11-10T10-00-00-${session.id}.jsonl`)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, session.text())
}

const direct = uuid(1)
const coded = uuid(2)
const fan = uuid(3)
const dark = uuid(4)
const child = uuid(5)
const sha = (c: string): string => c.repeat(40)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
  sessions = join(root, 'sessions')
  ledgerFile = join(root, 'changes.jsonl')
  const skills = join(root, 'skills', 'tidy')
  mkdirSync(skills, { recursive: true })
  writeFileSync(join(skills, 'SKILL.md'), TIDY)
  const skillFile = join(skills, 'SKILL.md')

  write(
    new Rollout(direct)
      .turn('tidy the module and commit')
      .direct('call_s1', `sed -n '1,40p' ${skillFile}`, TIDY)
      .direct('call_c1', 'git commit -m tidy', '[main aaaaaaa] tidy')
      .turn('now list the files')
      .direct('call_l1', 'ls', 'a b'),
  )
  write(
    new Rollout(coded)
      .turn('commit from a script')
      .script('call_x1', 'git commit -m scripted', ['exec-11111111-aaaa'], '[main bbbbbbb] scripted')
      .turn('list again')
      .script('call_x2', 'ls', ['exec-22222222-bbbb'], 'a'),
  )
  write(
    new Rollout(fan)
      .turn('two scripts at once')
      .open('call_f1', 'git commit -m one')
      .open('call_f2', 'ls')
      .completed('exec-33333333-cccc')
      .completed('exec-44444444-dddd')
      .close('call_f1', 'one')
      .close('call_f2', 'two'),
  )
  write(new Rollout(dark).turn('read that').direct('call_d1', 'ls', 'a'))
  write(
    new Rollout(child, direct)
      .turn('sub task')
      .direct('call_k1', 'git commit -m sub', '[main ccccccc] sub'),
  )
  writeFileSync(
    ledgerFile,
    [
      row({ sessionId: direct, action: 'observed' }),
      row({ sessionId: direct, action: 'commit', toolUseId: 'call_c1', remote: 'acme/widgets', sha: sha('a') }),
      row({ sessionId: coded, action: 'observed' }),
      row({ sessionId: coded, action: 'commit', toolUseId: 'exec-11111111-aaaa', remote: 'acme/widgets', sha: sha('b') }),
      row({ sessionId: fan, action: 'observed' }),
      row({ sessionId: fan, action: 'commit', toolUseId: 'exec-33333333-cccc', remote: 'acme/widgets', sha: sha('d') }),
      row({ sessionId: child, action: 'observed' }),
      row({ sessionId: child, action: 'commit', toolUseId: 'call_k1', remote: 'acme/widgets', sha: sha('c') }),
    ].join('\n'),
  )
  let out = ''
  let err = ''
  const code = await runProcedureRegistryCommand(
    [sessions, '--harness', 'codex', '--change-ledger', ledgerFile, '--intents', '--format', 'json'],
    {
      stdout: (t) => {
        out += t
      },
      stderr: (t) => {
        err += t
      },
    },
  )
  expect(code, err).toBe(0)
  registry = JSON.parse(out)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const intentsWith = (text: string) =>
  registry.intents.intents.filter((intent) => JSON.stringify(intent).includes(text))

describe('Codex sessions', () => {
  it('reads a skill from the file a shell call viewed, and versions it by the file as it is', () => {
    const tidy = registry.versions.filter((version) => version.names.includes('tidy'))
    expect(tidy).toHaveLength(1)
    expect(tidy[0]?.key).toBe(`sha256:${createHash('sha256').update(TIDY.trim()).digest('hex')}`)
    expect(tidy[0]?.sessions.invocations).toBe(1)
  })

  it('joins a commit to the turn whose call made it, by the call id the hook saw', () => {
    const joined = intentsWith(`acme/widgets@${sha('a')}`)
    expect(joined).toHaveLength(1)
    expect(joined[0]?.changes).toMatchObject({ status: 'joined', refs: [`acme/widgets@${sha('a')}`] })
  })

  it('joins a commit made inside a code-mode script to the turn that ran the script', () => {
    const joined = intentsWith(`acme/widgets@${sha('b')}`)
    expect(joined).toHaveLength(1)
    expect(joined[0]?.changes.refs).toEqual([`acme/widgets@${sha('b')}`])
  })

  it('makes a session unknown when a change names a call no turn holds, and says so', async () => {
    const reads: Array<{ sessionId: string; known: boolean; gaps: string[] }> = []
    const parents = new Map<string, string | null>()
    const changed = new Map<string, string[]>()
    for await (const read of withChangeLedger(
      codexSkillSessions(sessions),
      await readChangeLedger([ledgerFile]),
    )) {
      if (read.succeeded) {
        parents.set(read.value.sessionId, read.value.parentSessionId)
        changed.set(read.value.sessionId, (read.value.changes ?? []).map((change) => change.ref))
        reads.push({
          sessionId: read.value.sessionId,
          known: read.value.changes !== undefined,
          gaps: read.value.gaps,
        })
      }
    }
    const byId = new Map(reads.map((entry) => [entry.sessionId, entry]))
    expect(byId.get(fan)?.known).toBe(false)
    expect(byId.get(fan)?.gaps.join('\n')).toContain('2 commands run inside code-mode scripts')
    expect(byId.get(fan)?.gaps.join('\n')).toContain('1 changes name a tool call')
    expect(byId.get(direct)?.known).toBe(true)
    expect(parents.get(child)).toBe(direct)
    expect(changed.get(child)).toEqual([`acme/widgets@${sha('c')}`])
    expect(byId.get(coded)?.gaps).toEqual([])
    expect(intentsWith(sha('d'))).toHaveLength(0)
  })

  it('reports a session no hook saw as not recorded', () => {
    const statuses = registry.intents.intents.map((intent) => intent.changes.status)
    // dark's one turn and fan's one turn.
    expect(statuses.filter((status) => status === 'not-recorded')).toHaveLength(2)
  })

  it('reads the same sessions through the skill-usage command', async () => {
    let out = ''
    const code = await runSkillUsageCommand([sessions, '--harness', 'codex', '--format', 'json'], {
      stdout: (t) => {
        out += t
      },
      stderr: () => {},
    })
    expect(code).toBe(0)
    expect(JSON.parse(out).sessions.read).toBe(5)
  })

  it('refuses an unknown harness as a usage error', async () => {
    let err = ''
    const code = await runProcedureRegistryCommand([sessions, '--harness', 'vim'], {
      stdout: () => {},
      stderr: (t) => {
        err += t
      },
    })
    expect(code).toBe(2)
    expect(err).toContain('--harness expects one of claude-code|codex')
  })
})
