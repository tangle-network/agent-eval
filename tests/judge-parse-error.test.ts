/**
 * Judge parse failures are fail-loud: an unparseable judge response throws a
 * typed JudgeParseError (raw response attached) instead of fabricating a
 * `{ dimension: 'parse_error', score: 0 }` row, and the executor records the
 * failed judge without folding a synthetic zero into the composite.
 */

import type { TCloud } from '@tangle-network/tcloud'
import { describe, expect, it, vi } from 'vitest'
import { CostLedger } from '../src/cost-ledger'
import { executeScenario } from '../src/executor'
import { createCustomJudge, JudgeParseError } from '../src/judges'
import type { JudgeFn, Scenario } from '../src/types'

const GARBAGE = 'I refuse to emit JSON today'

function tcWith(judgeReply: string): TCloud {
  return {
    chat: async () => ({ choices: [{ message: { content: judgeReply } }] }),
  } as unknown as TCloud
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
    const err = await judge(tcWith(GARBAGE), {
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
    const rows = await judge(tcWith('[{"dimension":"quality","score":7,"reasoning":"fine"}]'), {
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
    const tc = {
      chat: async () => {
        calls++
        return {
          model: 'gpt-4o',
          choices: [
            { message: { content: '[{"dimension":"quality","score":7,"reasoning":"fine"}]' } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      },
    } as unknown as TCloud
    const judge = createCustomJudge('strict', 'score it', {
      model: 'gpt-4o',
      maxTokens: 1_000,
    })
    const baseInput = {
      scenario: scenario as never,
      turns: [{ userMessage: 'hi', agentResponse: 'yo' }],
      artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
      tcloudMaximumAttempts: 1,
    }

    const blocked = new CostLedger({ costCeilingUsd: 0 })
    await expect(judge(tc, { ...baseInput, costLedger: blocked } as never)).rejects.toThrow(
      /would exceed ceiling/,
    )
    expect(calls).toBe(0)
    expect(blocked.summary().totalCostUsd).toBe(0)

    const admitted = new CostLedger({ costCeilingUsd: 1 })
    await judge(tc, { ...baseInput, costLedger: admitted } as never)
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
    const result = await executeScenario(tcWith(GARBAGE), scenario, {
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
      const promise = executeScenario(tcWith(GARBAGE), scenario, {
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
