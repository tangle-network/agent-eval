/**
 * A native Pi session: a real Pi 0.85.1 session written while the CLI talked to the trace-proof
 * scripted model (beelink1, 2026-10-04), resumed for a second turn. Two bash tool calls (which
 * failed: the scripted commands wrote into a directory the CLI could not write), four answered
 * model calls of 100 input and 20 output tokens.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromPiSession } from '../src/contract'

const FIXTURE = join(import.meta.dirname, 'fixtures/harness-sessions/pi.jsonl')
const entries = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

describe('fromPiSession reads a native Pi session', () => {
  it('counts the session the shared reader folds', () => {
    const { runs, metrics, observations } = fromPiSession({ entries, sourcePath: FIXTURE })
    const [m] = metrics
    expect(m).toMatchObject({
      toolCalls: 2,
      toolOutputs: 2,
      toolErrors: 2,
      assistantMessages: 4,
      userMessages: 2,
      inputTokens: 400,
      outputTokens: 80,
      turnsCompleted: 1,
    })
    expect(runs[0]!.runId).toBe('pi:7b2f3c4e-1d2a-4b5c-8e9f-0a1b2c3d4e5f')
    expect(runs[0]!.model).toContain('traceproof/traceproof-scripted-model')
    expect(observations[0]!.terminal).toEqual({ status: 'completed', explicit: true })
    expect(observations[0]!.actions.map((a) => [a.name, a.status])).toEqual([
      ['bash', 'failed'],
      ['bash', 'failed'],
    ])
    expect(observations[0]!.finalText).toContain('TRACEPROOF-WORKER-PI-FINAL-ANSWER')
  })
})
