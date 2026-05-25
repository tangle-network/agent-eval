import { describe, expect, it, vi } from 'vitest'

const llmMock = vi.hoisted(() => ({
  value: {
    dimensions: { quality: 0.8 },
    failureModes: [],
    wins: [],
    rationale: 'Clear enough.',
  } as unknown,
}))

vi.mock('../../src/llm-client', () => ({
  callLlmJson: vi.fn(async () => ({
    value: llmMock.value,
    result: { model: 'mock-model', content: JSON.stringify(llmMock.value), durationMs: 1 },
  })),
}))

import { handleJudge, type WireError } from '../../src/wire/handlers'
import type { Rubric } from '../../src/wire/schemas'

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
    llmMock.value = {
      dimensions: { quality: 0.8 },
      failureModes: ['bad'],
      wins: ['good'],
      rationale: 'Clear enough.',
    }

    const result = await handleJudge({ rubric, content: 'hello' })

    expect(result.composite).toBe(0.8)
    expect(result.failureModes).toEqual(['bad'])
    expect(result.wins).toEqual(['good'])
    expect(result.rationale).toBe('Clear enough.')
  })

  it('rejects malformed dimension scores before returning wire output', async () => {
    llmMock.value = {
      dimensions: { quality: Number.NaN },
      rationale: 'nope',
    }

    await expect(handleJudge({ rubric, content: 'hello' })).rejects.toMatchObject<
      Partial<WireError>
    >({
      code: 'judge_error',
      status: 500,
    })
  })

  it('rejects unknown failure and win ids', async () => {
    llmMock.value = {
      dimensions: { quality: 0.7 },
      failureModes: ['unknown-failure'],
      wins: [],
      rationale: 'bad id',
    }
    await expect(handleJudge({ rubric, content: 'hello' })).rejects.toThrow(/unknown failureModes/)

    llmMock.value = {
      dimensions: { quality: 0.7 },
      failureModes: [],
      wins: ['unknown-win'],
      rationale: 'bad id',
    }
    await expect(handleJudge({ rubric, content: 'hello' })).rejects.toThrow(/unknown wins/)
  })

  it('rejects missing rationale', async () => {
    llmMock.value = {
      dimensions: { quality: 0.7 },
      rationale: '',
    }

    await expect(handleJudge({ rubric, content: 'hello' })).rejects.toThrow(/missing rationale/)
  })
})
