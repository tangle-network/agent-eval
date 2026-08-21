import { describe, expect, it } from 'vitest'

import { type ChatClient, createChatClient } from '../../src/analyst/chat-client'
import { CostLedger } from '../../src/cost-ledger'
import { handleJudge, type WireError } from '../../src/wire/handlers'
import type { Rubric } from '../../src/wire/schemas'

/** Caller-owned transport: the judge endpoint issues no provider request itself. */
function answering(value: unknown): ChatClient {
  return createChatClient({
    transport: 'custom',
    defaultModel: 'judge-model',
    maximumAttempts: 1,
    chat: async () => ({
      content: JSON.stringify(value),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, captured: true },
      costUsd: 0.001,
      model: 'judge-model',
      servedModel: 'judge-model',
      durationMs: 1,
      raw: {},
    }),
  })
}

const rubric: Rubric = {
  name: 'test-rubric',
  description: 'Test rubric',
  systemPrompt: 'Score it.',
  dimensions: [{ id: 'quality', description: 'Quality', weight: 1, min: 0, max: 1 }],
  failureModes: [{ id: 'bad', description: 'Bad' }],
  wins: [{ id: 'good', description: 'Good' }],
}

describe('handleJudge output validation', () => {
  it('returns validated judge output', async () => {
    const costLedger = new CostLedger()
    const result = await handleJudge(
      { rubric, content: 'hello' },
      {
        chat: answering({
          dimensions: { quality: 0.8 },
          failureModes: ['bad'],
          wins: ['good'],
          rationale: 'Clear enough.',
        }),
        costLedger,
      },
    )

    expect(result.composite).toBe(0.8)
    expect(result.failureModes).toEqual(['bad'])
    expect(result.wins).toEqual(['good'])
    expect(result.rationale).toBe('Clear enough.')
    expect(costLedger.list()).toEqual([
      expect.objectContaining({ channel: 'judge', actor: 'wire.inline', costUsd: 0.001 }),
    ])
  })

  it('refuses when no ChatClient is configured', async () => {
    await expect(handleJudge({ rubric, content: 'hello' })).rejects.toMatchObject<
      Partial<WireError>
    >({
      code: 'llm_not_configured',
      status: 503,
    })
  })

  it('rejects malformed dimension scores before returning wire output', async () => {
    const chat = answering({ dimensions: { quality: Number.NaN }, rationale: 'nope' })

    await expect(handleJudge({ rubric, content: 'hello' }, { chat })).rejects.toMatchObject<
      Partial<WireError>
    >({
      code: 'judge_error',
      status: 500,
    })
  })

  it('rejects unknown failure and win ids', async () => {
    const unknownFailure = answering({
      dimensions: { quality: 0.7 },
      failureModes: ['unknown-failure'],
      wins: [],
      rationale: 'bad id',
    })
    await expect(
      handleJudge({ rubric, content: 'hello' }, { chat: unknownFailure }),
    ).rejects.toThrow(/unknown failureModes/)

    const unknownWin = answering({
      dimensions: { quality: 0.7 },
      failureModes: [],
      wins: ['unknown-win'],
      rationale: 'bad id',
    })
    await expect(handleJudge({ rubric, content: 'hello' }, { chat: unknownWin })).rejects.toThrow(
      /unknown wins/,
    )
  })

  it('rejects missing rationale', async () => {
    const chat = answering({ dimensions: { quality: 0.7 }, rationale: '' })

    await expect(handleJudge({ rubric, content: 'hello' }, { chat })).rejects.toThrow(
      /missing rationale/,
    )
  })
})
