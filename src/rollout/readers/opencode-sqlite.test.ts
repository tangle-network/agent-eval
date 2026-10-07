/**
 * The store is a real OpenCode 1.18.25 opencode.db written while the CLI talked to the trace-proof
 * scripted model (beelink1 trace-proof-r2, 2026-10-04): two bash tool calls and a final answer.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findOpencodeSessionsByDirectory,
  readOpencodeSession,
  readOpencodeSessionMessages,
} from './opencode-sqlite'

const DB = join(import.meta.dirname, '../../../tests/fixtures/harness-sessions/opencode.db')

describe('opencode sqlite reader', () => {
  it('finds the session by its cwd and reads each model step and its tool results', async () => {
    const [ref, ...rest] = await findOpencodeSessionsByDirectory('/home/agent', DB)
    expect(rest).toEqual([])
    const messages = await readOpencodeSessionMessages(ref!.nativeSessionId, DB)
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(messages[1]!.tool_calls?.map((c) => c.function.name)).toEqual(['bash'])
    expect(messages[2]!.content).toContain('TRACEPROOF-WORKER-OPENCODE-TOOL-OUTPUT')
    const session = await readOpencodeSession(ref!.nativeSessionId, DB)
    expect(session.servedModels).toEqual({ 'openai-compat/openai/gpt-5.5': 3 })
    expect(session.usage).toEqual({
      input: 300,
      output: 60,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('refuses a session that is not in the store', async () => {
    await expect(readOpencodeSessionMessages('ses_missing', DB)).rejects.toThrow(/not in/)
    expect(await findOpencodeSessionsByDirectory('/elsewhere', DB)).toEqual([])
  })
})
