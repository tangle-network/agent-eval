/**
 * Judge parse failures are fail-loud: an unparseable judge response throws a
 * typed JudgeParseError (raw response attached) instead of fabricating a
 * `{ dimension: 'parse_error', score: 0 }` row, and the executor records the
 * failed judge without folding a synthetic zero into the composite.
 */

import { describe, expect, it, vi } from 'vitest'
import { type ChatClient, type ChatResponse, createChatClient } from '../src/analyst/chat-client'
import { CostLedger } from '../src/cost-ledger'
import { executeScenario } from '../src/executor'
import { createCustomJudge, JudgeParseError } from '../src/judges'
import type { JudgeFn, Scenario } from '../src/types'

const GARBAGE = 'I refuse to emit JSON today'

function response(content: string, overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costUsd: null,
    model: 'gpt-4o',
    durationMs: 0,
    raw: {},
    ...overrides,
  }
}

function chatWith(judgeReply: string): ChatClient {
  return createChatClient({
    transport: 'mock',
    defaultModel: 'gpt-4o',
    handler: async () => response(judgeReply),
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

describe('parseJudgeResponse — fail loud', () => {
  it('throws JudgeParseError with the raw response attached', async () => {
    const judge = createCustomJudge('strict', 'score it')
    const err = await judge(chatWith(GARBAGE), {
      scenario: scenario as never,
      turns: [{ userMessage: 'hi', agentResponse: 'yo' }],
      artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
    } as never).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(JudgeParseError)
    const parseErr = err as JudgeParseError
    expect(parseErr.judgeName).toBe('strict')
    expect(parseErr.raw).toBe(GARBAGE)
    expect(parseErr.code).toBe('judge')
  })

  it('still parses valid responses into rows', async () => {
    const judge = createCustomJudge('strict', 'score it')
    const rows = await judge(chatWith('[{"dimension":"quality","score":7,"reasoning":"fine"}]'), {
      scenario: scenario as never,
      turns: [{ userMessage: 'hi', agentResponse: 'yo' }],
      artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
    } as never)
    expect(rows).toEqual([
      {
        judgeName: 'strict',
        dimension: 'quality',
        score: 7,
        reasoning: 'fine',
        evidence: undefined,
      },
    ])
  })

  it('admits built-in judge calls from an enforced token bound and records their receipt', async () => {
    let calls = 0
    const chat = createChatClient({
      transport: 'mock',
      defaultModel: 'gpt-4o',
      handler: async () => {
        calls++
        return response('[{"dimension":"quality","score":7,"reasoning":"fine"}]', {
          model: 'gpt-4o',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        })
      },
    })
    const judge = createCustomJudge('strict', 'score it', {
      model: 'gpt-4o',
      maxTokens: 1_000,
    })
    const baseInput = {
      scenario: scenario as never,
      turns: [{ userMessage: 'hi', agentResponse: 'yo' }],
      artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
    }

    const blocked = new CostLedger({ costCeilingUsd: 0 })
    await expect(judge(chat, { ...baseInput, costLedger: blocked } as never)).rejects.toThrow(
      /would exceed ceiling/,
    )
    expect(calls).toBe(0)
    expect(blocked.summary().totalCostUsd).toBe(0)

    const admitted = new CostLedger({ costCeilingUsd: 1 })
    await judge(chat, { ...baseInput, costLedger: admitted } as never)
    expect(calls).toBe(1)
    expect(admitted.summary()).toMatchObject({
      totalCalls: 1,
      inputTokens: 10,
      outputTokens: 5,
      fullyPriced: true,
      accountingComplete: true,
    })
    expect(admitted.summary({ channel: 'judge' }).totalCostUsd).toBeGreaterThan(0)
  })
})

describe('executeScenario — failed judges are counted, not faked', () => {
  it('records a JudgeParseError judge as failed without injecting zero rows', async () => {
    const parseFailing = createCustomJudge('broken', 'score it')
    const result = await executeScenario(chatWith(GARBAGE), scenario, {
      systemPrompt: 'be helpful',
      judges: [parseFailing],
    })
    expect(result.judgeErrors).toBe(1)
    expect(result.judgeScores).toEqual([])
    expect(
      result.judgeScores.some((s) => s.dimension === 'parse_error' || s.dimension === 'error'),
    ).toBe(false)
  })

  it('keeps valid judge rows alongside a failed judge', async () => {
    vi.useFakeTimers()
    try {
      const goodJudge: JudgeFn = async () => [
        { judgeName: 'good', dimension: 'quality', score: 8, reasoning: 'solid' },
      ]
      const parseFailing = createCustomJudge('broken', 'score it')
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
