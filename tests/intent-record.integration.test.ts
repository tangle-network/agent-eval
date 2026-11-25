/**
 * Intent records over real Claude Code transcripts, through the registry.
 *
 * Every typed turn here is invented. Three sessions are written:
 *
 * | Session | What it records |
 * |---|---|
 * | S1 | a task that runs `tidy` and opens a pull request, a correction of it, then a second task that ends the session |
 * | S2 | two typed turns nobody labeled, and a subagent that runs `audit` while the first is open |
 * | S3 | a typed turn that opens a pull request nobody supplied an outcome for |
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IntentLabeler, IntentRecord } from '../src/intent-record'
import { buildProcedureRegistry, type ProcedureRegistry } from '../src/procedure-registry'
import { claudeCodeSkillSessions } from '../src/skill-usage'
import { skillBodySha256 } from '../src/skill-usage/skill-file'

const TIDY = '# Tidy\n\nRemove dead code.'
const AUDIT = '# Audit\n\nRead the diff.'
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

type Item =
  | { user: string }
  | { tool: string; input: Record<string, unknown>; result?: string; loaded?: string }

let root: string
let registry: ProcedureRegistry

/** One transcript; every record is a minute after the one before. */
function transcript(
  sessionId: string,
  items: readonly Item[],
  options: { agentId?: string; startMinute?: number } = {},
): string {
  const owner = options.agentId ?? sessionId
  const lines: unknown[] = []
  let previous: string | null = null
  let minute = options.startMinute ?? 0
  const push = (type: string, uuid: string, message: unknown, extra: object = {}): void => {
    lines.push({
      parentUuid: previous,
      isSidechain: options.agentId !== undefined,
      userType: 'external',
      cwd: '/work/app',
      sessionId,
      version: '0.0.0-fixture',
      type,
      uuid,
      timestamp: new Date(Date.parse('2026-11-10T10:00:00Z') + 60_000 * minute++).toISOString(),
      message,
      ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      ...extra,
    })
    previous = uuid
  }
  items.forEach((item, index) => {
    if ('user' in item) {
      push('user', `${owner}-u${index}`, { role: 'user', content: item.user })
      return
    }
    const id = `toolu_${owner}_${index}`
    push('assistant', `${owner}-a${index}`, {
      id: `msg_${owner}_${index}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'tool_use', id, name: item.tool, input: item.input }],
      usage: { input_tokens: 100, output_tokens: 10 },
    })
    push('user', `${owner}-r${index}`, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: item.result ?? 'ok' }],
    })
    if (item.loaded !== undefined) {
      push(
        'user',
        `${owner}-l${index}`,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Base directory for this skill: /skills/${String(item.input.skill)}\n\n${item.loaded}`,
            },
          ],
        },
        { isMeta: true, sourceToolUseID: id },
      )
    }
  })
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

const skill = (name: string, loaded: string): Item => ({
  tool: 'Skill',
  input: { skill: name },
  loaded,
})
const bash = (command: string, result = 'ok'): Item => ({
  tool: 'Bash',
  input: { command },
  result,
})

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** Labels by the invented words a turn contains; a turn with none of them is unlabeled. */
const labeler: IntentLabeler = (turn) => {
  if (turn.text.includes('wrong')) {
    return { source: 'test', kind: 'correction', done: null, correction: true, reask: false }
  }
  if (turn.text.includes('widget')) {
    return { source: 'test', kind: 'task', done: 'stated', correction: false, reask: false }
  }
  if (turn.text.includes('next job')) {
    return { source: 'test', kind: 'task', done: 'inferred', correction: false, reask: false }
  }
  if (turn.text.includes('gadget')) {
    return { source: 'test', kind: 'problem', done: 'none', correction: false, reask: false }
  }
  return null
}

const NOW = Date.parse('2026-11-20T00:00:00Z')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'intent-record-'))
  const app = join(root, 'projects', '-work-app')
  write(
    join(app, 's1.jsonl'),
    transcript('s1', [
      { user: 'Fixture: add the widget' },
      skill('tidy', TIDY),
      bash('gh pr create', 'https://github.com/acme/widgets/pull/7\n'),
      { user: 'Fixture: that is wrong' },
      bash('ls'),
      { user: 'Fixture: the next job' },
      bash('ls'),
    ]),
  )
  write(
    join(app, 's2.jsonl'),
    transcript('s2', [
      { user: 'Fixture: first unlabeled' },
      bash('ls'),
      { user: 'Fixture: second unlabeled' },
      bash('ls'),
    ]),
  )
  // The subagent runs inside the first unlabeled turn's span: minutes 1 and 2 of S2.
  write(
    join(app, 's2', 'subagents', 'agent-cd34.jsonl'),
    transcript('s2', [{ user: 'Fixture: subtask' }, skill('audit', AUDIT)], {
      agentId: 'cd34',
      startMinute: 1,
    }),
  )
  write(
    join(app, 's3.jsonl'),
    transcript('s3', [
      { user: 'Fixture: the gadget is broken' },
      bash('gh pr create', 'https://github.com/acme/other/pull/3\n'),
    ]),
  )
  registry = await buildProcedureRegistry(
    {
      sessions: claudeCodeSkillSessions(join(root, 'projects')),
      outcomes: [
        {
          ref: 'acme/widgets#7',
          merged: true,
          gateGreenFirstTry: true,
          hotfixed: true,
          hotfixWindowDays: 7,
        },
      ],
    },
    { sinceMs: NOW - 30 * 86_400_000, intents: { labeler } },
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function intentsOf(sessionId: string): IntentRecord[] {
  return (registry.intents?.intents ?? [])
    .filter((record) => record.sessionId === sessionId)
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
}

const TIDY_KEY = `sha256:${skillBodySha256(TIDY)}`
const AUDIT_KEY = `sha256:${skillBodySha256(AUDIT)}`

describe('intent records', () => {
  it('attaches a correction to the intent it corrects and closes the intent on the next one', () => {
    const [task, next] = intentsOf('s1')
    expect(intentsOf('s1')).toHaveLength(2)
    expect(task?.label).toEqual({ source: 'test', kind: 'task', done: 'stated' })
    expect(task?.prompt).toEqual({ sha256: sha256('Fixture: add the widget'), chars: 23 })
    expect(task?.end).toMatchObject({
      userTurns: 2,
      corrections: 1,
      reasks: 0,
      closedBy: 'next-intent',
    })
    expect(next?.end).toMatchObject({ userTurns: 1, corrections: 0, closedBy: 'session-end' })
    expect(next?.label?.done).toBe('inferred')
  })

  it('names the procedure versions that served an intent and what its span cost', () => {
    const [task, next] = intentsOf('s1')
    expect(task?.procedures).toEqual([TIDY_KEY])
    // Three model calls of 110 tokens, then one.
    expect(task?.cost).toMatchObject({ modelCalls: 3, tokens: 330 })
    expect(next?.procedures).toEqual([])
    expect(next?.cost).toMatchObject({ modelCalls: 1, tokens: 110 })
  })

  it('counts a subagent’s procedures toward the intent open when it ran', () => {
    const [first, second] = intentsOf('s2')
    expect(first?.procedures).toEqual([AUDIT_KEY])
    expect(second?.procedures).toEqual([])
  })

  it('reads the end from the outcome of the intent’s changes when there is one', () => {
    const [task, next] = intentsOf('s1')
    // The pull request merged and then needed a fix inside the window: not done.
    expect(task?.changes).toMatchObject({ status: 'joined', refs: ['acme/widgets#7'] })
    expect(task?.end).toMatchObject({
      reachedDone: false,
      abandoned: false,
      evidence: 'change-outcome',
    })
    // The session just ends after this one: nothing says whether it was done.
    expect(next?.changes).toEqual({ status: 'none' })
    expect(next?.end).toMatchObject({ reachedDone: null, abandoned: null, evidence: 'none' })
  })

  it('takes moving on as weak evidence and a change nobody supplied an outcome for as none', () => {
    const [problem] = intentsOf('s3')
    expect(problem?.changes).toMatchObject({ status: 'joined', outcomes: [] })
    expect(problem?.end).toMatchObject({ reachedDone: null, evidence: 'none' })
  })

  it('keeps a label nobody gave apart from a measured zero', () => {
    const [first, second] = intentsOf('s2')
    expect(first?.label).toBeNull()
    // The turn after it was not labeled, so the first cannot say how many corrections it drew.
    expect(first?.end).toMatchObject({ corrections: null, reasks: null, closedBy: 'next-intent' })
    expect(first?.end).toMatchObject({ reachedDone: true, evidence: 'moved-on' })
    expect(second?.end).toMatchObject({ corrections: 0, reasks: 0 })
  })

  it('holds no prompt text', () => {
    const text = JSON.stringify(registry.intents)
    for (const word of ['Fixture', 'add the', 'that is wrong', 'next job', 'is broken']) {
      expect(text).not.toContain(word)
    }
  })

  it('summarizes the known ends per kind, with unlabeled intents in a row of their own', () => {
    const summary = registry.intents?.summary
    expect(summary?.sessionsWithoutTurns).toBe(0)
    const row = (kind: string | null) => summary?.byKind.find((entry) => entry.kind === kind)
    expect(row('task')).toMatchObject({
      intents: 2,
      knownEnd: 1,
      knownEndShare: 0.5,
      joinedToChange: 1,
      withChangeOutcome: 1,
    })
    expect(row('problem')).toMatchObject({
      intents: 1,
      knownEnd: 0,
      joinedToChange: 1,
      withChangeOutcome: 0,
    })
    expect(row(null)?.intents).toBeGreaterThanOrEqual(2)
    expect(summary?.knownEndShare).toBeGreaterThan(0)
  })
})
