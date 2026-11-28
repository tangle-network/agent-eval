/**
 * The instruction files a harness loaded, through the published session
 * readers. Every path, text and id below is invented; the record shapes are
 * those Claude Code 2.1 and Codex 0.172 write.
 *
 * | Session | What it records | Expected |
 * |---|---|---|
 * | Claude Code `loaded` | a user file and a project file at session start, the same two again after a compaction, the project file again with new text, a file loaded when the agent read below its directory, and a sidechain record of a subagent's own load | four entries: each file and text once, in recorded order; the subagent's load is not the session's |
 * | Claude Code `bare` | no instruction attachment | an empty list: looked, found none |
 * | Codex `rollout` | the AGENTS.md message for one directory, and a typed turn | one entry naming the directory and no file |
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// The published `./analyst` entry, so a field it does not carry fails here.
import {
  claudeCodeSkillSessions,
  codexSkillSessions,
  type SkillSessionRecord,
} from '../src/analyst'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const USER_FILE = '/home/someone/.claude/CLAUDE.md'
const PROJECT_FILE = '/work/app/AGENTS.md'
const NESTED_FILE = '/work/app/service/CLAUDE.md'
const USER_TEXT = '# Defaults\n\n1. Run the checks before you merge.\n'
const PROJECT_TEXT = '# App\n\n- The gate is `make gate`.\n'
const PROJECT_TEXT_2 = '# App\n\n- The gate is `make gate`; read its receipt before merging.\n'
const NESTED_TEXT = '# Service\n\nKeep handlers small.\n'
const CODEX_TEXT =
  '# Shared defaults\n\n- Gate every head before merging.\n\n# App\n\n- The gate is `make gate`.'

let root: string

type Line = Record<string, unknown>

function claudeLine(sessionId: string, n: number, fields: Line): Line {
  return {
    parentUuid: n === 1 ? null : `${sessionId}-${n - 1}`,
    isSidechain: false,
    userType: 'external',
    cwd: '/work/app',
    sessionId,
    version: '2.1.0',
    uuid: `${sessionId}-${n}`,
    timestamp: new Date(Date.parse('2026-11-10T10:00:00Z') + n * 1000).toISOString(),
    ...fields,
  }
}

const instructions = (files: Array<[string, string, string]>, extra: Line = {}): Line => ({
  type: 'attachment',
  attachment: {
    type: 'instructions',
    files: files.map(([path, type, content]) => ({ path, type, content })),
    ...extra,
  },
})

function writeJsonl(path: string, lines: readonly Line[]): void {
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
}

function claudeSession(sessionId: string, steps: readonly Line[]): Line[] {
  return [
    claudeLine(sessionId, 1, {
      type: 'user',
      message: { role: 'user', content: 'Invented request: tidy the service.' },
    }),
    ...steps.map((step, index) => claudeLine(sessionId, index + 2, step)),
    claudeLine(sessionId, steps.length + 2, {
      type: 'assistant',
      message: {
        id: `msg-${sessionId}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    }),
  ]
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'instruction-files-'))
  const project = join(root, 'claude', '-work-app')
  mkdirSync(project, { recursive: true })
  writeJsonl(
    join(project, 'loaded-0000-4000-8000-000000000001.jsonl'),
    claudeSession('loaded-0000-4000-8000-000000000001', [
      instructions([
        [USER_FILE, 'User', USER_TEXT],
        [PROJECT_FILE, 'Project', PROJECT_TEXT],
      ]),
      {
        ...instructions([[USER_FILE, 'User', 'a subagent loads its own text']]),
        isSidechain: true,
      },
      instructions(
        [
          [USER_FILE, 'User', USER_TEXT],
          [PROJECT_FILE, 'Project', PROJECT_TEXT],
        ],
        { changed: true, reason: 'compact' },
      ),
      instructions([[PROJECT_FILE, 'Project', PROJECT_TEXT_2]], {
        changed: true,
        reason: 'file_changed',
      }),
      {
        type: 'attachment',
        attachment: {
          type: 'nested_memory',
          path: NESTED_FILE,
          displayPath: 'service/CLAUDE.md',
          content: {
            path: NESTED_FILE,
            type: 'Project',
            content: NESTED_TEXT,
            contentDiffersFromDisk: false,
          },
        },
      },
    ]),
  )
  writeJsonl(
    join(project, 'bare-0000-4000-8000-000000000002.jsonl'),
    claudeSession('bare-0000-4000-8000-000000000002', []),
  )

  const codex = join(root, 'codex', '2026', '11', '10')
  mkdirSync(codex, { recursive: true })
  const id = '00000001-0000-7000-8000-000000000001'
  const at = (n: number) => new Date(Date.parse('2026-11-10T10:00:00Z') + n * 1000).toISOString()
  writeJsonl(join(codex, `rollout-2026-11-10T10-00-00-${id}.jsonl`), [
    {
      timestamp: at(0),
      type: 'session_meta',
      payload: {
        id,
        session_id: id,
        cwd: '/work/app',
        originator: 'codex_exec',
        cli_version: '0.172.0',
        source: 'exec',
      },
    },
    { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: `${id}-t` } },
    {
      timestamp: at(2),
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg-1',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `# AGENTS.md instructions for /work/app\n\n<INSTRUCTIONS>\n${CODEX_TEXT}\n</INSTRUCTIONS>`,
          },
        ],
      },
    },
    {
      timestamp: at(3),
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg-2',
        role: 'user',
        content: [{ type: 'input_text', text: 'Invented request: tidy the service.' }],
      },
    },
  ])
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function sessions(
  source: AsyncIterable<{ succeeded: boolean }>,
): Promise<SkillSessionRecord[]> {
  const records: SkillSessionRecord[] = []
  for await (const read of source) {
    expect(read.succeeded).toBe(true)
    if (read.succeeded) records.push((read as { value: SkillSessionRecord }).value)
  }
  return records
}

describe('instruction files a session loaded', () => {
  it('reads each Claude Code file once per text, with its scope, and not a subagent load', async () => {
    const records = await sessions(claudeCodeSkillSessions(join(root, 'claude')))
    const loaded = records.find((session) => session.sessionId.startsWith('loaded'))
    const bare = records.find((session) => session.sessionId.startsWith('bare'))
    expect(
      loaded?.instructions?.map(({ path, directory, scope, sha256: digest, text }) => ({
        path,
        directory,
        scope,
        digest,
        text,
      })),
    ).toEqual([
      {
        path: USER_FILE,
        directory: null,
        scope: 'User',
        digest: sha256(USER_TEXT),
        text: USER_TEXT,
      },
      {
        path: PROJECT_FILE,
        directory: null,
        scope: 'Project',
        digest: sha256(PROJECT_TEXT),
        text: PROJECT_TEXT,
      },
      {
        path: PROJECT_FILE,
        directory: null,
        scope: 'Project',
        digest: sha256(PROJECT_TEXT_2),
        text: PROJECT_TEXT_2,
      },
      {
        path: NESTED_FILE,
        directory: null,
        scope: 'Project',
        digest: sha256(NESTED_TEXT),
        text: NESTED_TEXT,
      },
    ])
    expect(loaded?.instructions?.[0]?.at).toBe('2026-11-10T10:00:02.000Z')
    expect(bare?.instructions).toEqual([])
  })

  it('reads the AGENTS.md text a Codex rollout loaded, naming the directory', async () => {
    const [rollout] = await sessions(codexSkillSessions(join(root, 'codex')))
    expect(rollout?.instructions).toEqual([
      {
        path: null,
        directory: '/work/app',
        scope: 'AGENTS.md',
        sha256: sha256(CODEX_TEXT),
        text: CODEX_TEXT,
        at: '2026-11-10T10:00:02.000Z',
      },
    ])
  })
})
