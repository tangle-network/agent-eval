/**
 * The transcript is a real Claude Code 2.1.286 session written while the CLI talked to the
 * trace-proof scripted model (beelink1 trace-proof-r2, 2026-10-04): two shell tool calls and a
 * final answer, 100 input and 20 output tokens per response, each response written as one record
 * per content block.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeProjectSlug,
  findClaudeTranscripts,
  parseClaudeTranscript,
  readClaudeTranscript,
} from './claude-jsonl'

const FIXTURE = join(
  import.meta.dirname,
  '../../../tests/fixtures/harness-sessions/claude-code.jsonl',
)

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-reader-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('claudeProjectSlug', () => {
  it('matches Claude Code project-directory naming', () => {
    expect(claudeProjectSlug('/tmp/claude-1000/-home-drew/x.y_z')).toBe(
      '-tmp-claude-1000--home-drew-x-y-z',
    )
  })
})

describe('findClaudeTranscripts', () => {
  it('lists jsonl session files for a cwd, empty when the project dir is absent', async () => {
    const cwd = '/tmp/some/worktree'
    const project = join(dir, claudeProjectSlug(cwd))
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'abc.jsonl'), '')
    await writeFile(join(project, 'notes.txt'), '')
    const refs = await findClaudeTranscripts(cwd, dir)
    expect(refs).toEqual([{ sessionId: 'abc', path: join(project, 'abc.jsonl') }])
    expect(await findClaudeTranscripts('/tmp/other', dir)).toEqual([])
  })
})

describe('readClaudeTranscript', () => {
  it('reads a real transcript: one message per response, usage counted once per response', async () => {
    const transcript = await readClaudeTranscript(FIXTURE)
    expect(transcript.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(transcript.messages[1]!.tool_calls?.map((c) => c.function.name)).toEqual(['Bash'])
    expect(transcript.messages[2]!.content).toContain('TRACEPROOF-WORKER-REAP-TOOL-OUTPUT')
    expect(transcript.usage).toEqual({ tokensIn: 300, tokensOut: 60, cacheRead: 0, cacheWrite: 0 })
    expect(transcript.model).toBe('traceproof-scripted-model')
    expect(transcript.gaps).toEqual([])
  })

  it('parses retained text the same way and names a malformed line without losing usage', async () => {
    const raw = await readFile(FIXTURE, 'utf8')
    expect(parseClaudeTranscript(raw)).toEqual(await readClaudeTranscript(FIXTURE))
    const lines = raw.split('\n')
    const broken = [...lines.slice(0, 3), '{bad json', ...lines.slice(3)].join('\n')
    const transcript = parseClaudeTranscript(broken)
    expect(transcript.gaps).toEqual(['retained transcript: line 4 is not a JSON record'])
    expect(transcript.usage).toEqual({ tokensIn: 300, tokensOut: 60, cacheRead: 0, cacheWrite: 0 })
  })
})
