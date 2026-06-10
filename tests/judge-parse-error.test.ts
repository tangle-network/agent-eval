/**
 * Judge parse failures are fail-loud: an unparseable judge response throws a
 * typed JudgeParseError (raw response attached) instead of fabricating a
 * `{ dimension: 'parse_error', score: 0 }` row, and the executor records the
 * failed judge without folding a synthetic zero into the composite.
 */

import type { TCloud } from '@tangle-network/tcloud'
import { describe, expect, it, vi } from 'vitest'
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
