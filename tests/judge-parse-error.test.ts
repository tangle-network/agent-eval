import { describe, expect, it, vi } from 'vitest'
import { type ChatClient, type ChatResponse, createChatClient } from '../src/analyst/chat-client'
import { executeScenario } from '../src/executor'
import { JudgeParseError } from '../src/judges'
import type { JudgeFn, Scenario } from '../src/types'

const GARBAGE = 'I refuse to emit JSON today'

function response(content: string): ChatResponse {
  return {
    content,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costUsd: null,
    model: 'gpt-4o',
    durationMs: 0,
    raw: {},
  }
}

function chatWith(content: string): ChatClient {
  return createChatClient({
    transport: 'mock',
    defaultModel: 'gpt-4o',
    handler: async () => response(content),
  })
}

const scenario: Scenario = {
  id: 's1',
  persona: 'analyst',
  label: 'unit',
  thesis: 'test thesis',
  dimensions: ['quality'],
  turns: [{ user: 'hello', expectedBehaviors: [] }],
  artifactChecks: [],
}

const parseFailing: JudgeFn = async () => {
  throw new JudgeParseError('broken', GARBAGE)
}

describe('executeScenario judge failures', () => {
  it('records a parse failure without injecting a zero score', async () => {
    const result = await executeScenario(chatWith(GARBAGE), scenario, {
      systemPrompt: 'be helpful',
      judges: [parseFailing],
    })

    expect(result.judgeErrors).toBe(1)
    expect(result.judgeScores).toEqual([])
  })

  it('keeps valid judge rows alongside a failed judge', async () => {
    vi.useFakeTimers()
    try {
      const goodJudge: JudgeFn = async () => [
        { judgeName: 'good', dimension: 'quality', score: 8, reasoning: 'solid' },
      ]
      const promise = executeScenario(chatWith(GARBAGE), scenario, {
        systemPrompt: 'be helpful',
        judges: [goodJudge, parseFailing],
      })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result.judgeErrors).toBe(1)
      expect(result.judgeScores).toHaveLength(1)
      expect(result.judgeScores[0]!.dimension).toBe('quality')
      expect(result.overallScore).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
