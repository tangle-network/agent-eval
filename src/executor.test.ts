/**
 * Capture-integrity contract for the scenario executor. Two failure classes
 * that a sloppy fallback erases must stay loud:
 *   1. a malformed/hung chat response must NOT be recorded as a real empty turn
 *      (capture defect, indistinguishable from a model that said nothing);
 *   2. a judge that errors must record WHY, retry only transient faults, and
 *      fail deterministic faults immediately.
 */

import type { TCloud } from '@tangle-network/tcloud'
import { describe, expect, it, vi } from 'vitest'

import { CostLedger } from './cost-ledger'
import { CaptureIntegrityError } from './errors'
import { type ExecutorConfig, executeScenario, type JudgeFailure } from './executor'
import { JudgeParseError } from './judges'
import type { JudgeFn, Scenario, ScenarioResult } from './types'

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'cap-1',
    persona: 'analyst',
    label: 'capture',
    thesis: 'executor preserves capture integrity',
    dimensions: ['accuracy'],
    turns: [{ user: 'hello', expectedBehaviors: [] }],
    artifactChecks: [],
    ...overrides,
  }
}

/** A TCloud whose chat() returns whatever shape the test supplies. */
function chatStub(resp: unknown): TCloud {
  return { chat: vi.fn(async () => resp) } as unknown as TCloud
}

/** No-op sleep so the retry policy runs without real backoff. */
const noSleep = (_ms: number) => Promise.resolve()

function config(overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    systemPrompt: 'you are a test agent',
    judges: [],
    sleep: noSleep,
    ...overrides,
  }
}

describe('executeScenario — malformed chat response is a loud capture defect', () => {
  it('meters the scenario agent and rejects it before a capped run can overspend', async () => {
    const tc = chatStub({
      model: 'gpt-4o',
      choices: [{ message: { content: 'measured' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
    const blocked = new CostLedger(0)
    await expect(
      executeScenario(tc, scenario(), config({ costLedger: blocked, tcloudMaximumAttempts: 1 })),
    ).rejects.toThrow(/would exceed ceiling/)
    expect(tc.chat).not.toHaveBeenCalled()

    const admitted = new CostLedger(1)
    const result = await executeScenario(
      tc,
      scenario(),
      config({
        costLedger: admitted,
        costTags: { benchmarkRunId: 'benchmark-a' },
        tcloudMaximumAttempts: 1,
      }),
    )
    expect(result.cost).toMatchObject({ totalCalls: 1, inputTokens: 10, outputTokens: 2 })
    expect(admitted.list()[0]?.tags).toMatchObject({ benchmarkRunId: 'benchmark-a' })
  })

  it('marks omitted TCloud usage as incomplete instead of known zero spend', async () => {
    const tc = chatStub({
      model: 'gpt-4o',
      choices: [{ message: { content: 'measured' } }],
      usage: {},
    })
    const ledger = new CostLedger(1)
    const result = await executeScenario(
      tc,
      scenario(),
      config({ costLedger: ledger, tcloudMaximumAttempts: 1 }),
    )

    expect(result.cost).toMatchObject({
      totalCalls: 1,
      totalCostUsd: 0,
      usageComplete: false,
      accountingComplete: false,
    })
    if (!result.cost) throw new Error('expected the shared cost summary')
    expect(result.cost.incompleteReasons).toEqual(
      expect.arrayContaining([expect.stringContaining('token usage unknown')]),
    )
  })

  it('marks inconsistent TCloud token totals as incomplete', async () => {
    const tc = chatStub({
      model: 'gpt-4o',
      choices: [{ message: { content: 'measured' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 1 },
    })
    const result = await executeScenario(
      tc,
      scenario(),
      config({ costLedger: new CostLedger(), tcloudMaximumAttempts: 1 }),
    )

    expect(result.cost).toMatchObject({ usageComplete: false, accountingComplete: false })
  })

  it('throws CaptureIntegrityError when choices[0].message is absent', async () => {
    const tc = chatStub({ choices: [{}] })
    await expect(executeScenario(tc, scenario(), config())).rejects.toBeInstanceOf(
      CaptureIntegrityError,
    )
  })

  it('throws when content is missing entirely (collapsed to "" under the old code)', async () => {
    const tc = chatStub({ choices: [{ message: { role: 'assistant' } }] })
    await expect(executeScenario(tc, scenario(), config())).rejects.toBeInstanceOf(
      CaptureIntegrityError,
    )
  })

  it('throws when content is a non-string (e.g. null) instead of recording an empty turn', async () => {
    const tc = chatStub({ choices: [{ message: { content: null } }] })
    await expect(executeScenario(tc, scenario(), config())).rejects.toBeInstanceOf(
      CaptureIntegrityError,
    )
  })

  it('PRESERVES a legitimately-empty string — a model that chose to say nothing is real signal', async () => {
    const tc = chatStub({ choices: [{ message: { content: '' } }] })
    const result = await executeScenario(tc, scenario(), config())
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]!.agentResponse).toBe('')
  })
})

describe('executeScenario — judge retry policy records the reason and gates on transience', () => {
  const goodResp = { choices: [{ message: { content: 'hi there' } }] }

  it('does NOT retry a deterministic judge error — calls the judge exactly once', async () => {
    const judge = vi.fn(async () => {
      throw new Error('rubric validation failed')
    }) as unknown as JudgeFn
    const tc = chatStub(goodResp)

    const result = await executeScenario(tc, scenario(), config({ judges: [judge] }))

    expect((judge as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(result.judgeErrors).toBe(1)
  })

  it('records WHY a judge failed in additive judgeFailures with the actual error message', async () => {
    const judge = vi.fn(async () => {
      throw new Error('rubric validation failed')
    }) as unknown as JudgeFn
    const tc = chatStub(goodResp)

    const result = (await executeScenario(
      tc,
      scenario(),
      config({ judges: [judge] }),
    )) as ScenarioResult & {
      judgeFailures?: JudgeFailure[]
    }

    expect(result.judgeFailures).toBeDefined()
    expect(result.judgeFailures).toHaveLength(1)
    expect(result.judgeFailures![0]!.reason).toContain('rubric validation failed')
    expect(result.judgeFailures![0]!.attempts).toBe(1)
  })

  it('retries a transient judge error and succeeds on the next attempt', async () => {
    let calls = 0
    const judge = vi.fn(async () => {
      calls++
      if (calls === 1) {
        const err = new Error('socket hang up') as Error & { status?: number }
        err.status = 503
        throw err
      }
      return [{ judgeName: 'j', dimension: 'accuracy', score: 0.8, reasoning: 'ok' }]
    }) as unknown as JudgeFn
    const tc = chatStub(goodResp)

    const result = (await executeScenario(
      tc,
      scenario(),
      config({ judges: [judge] }),
    )) as ScenarioResult & {
      judgeFailures?: JudgeFailure[]
    }

    expect(calls).toBe(2)
    expect(result.judgeErrors).toBe(0)
    expect(result.judgeFailures).toBeUndefined()
    expect(result.judgeScores).toHaveLength(1)
  })

  it('exhausts retries on a persistently-transient judge and reports exactly 3 attempts', async () => {
    const judge = vi.fn(async () => {
      const err = new Error('ECONNRESET') as Error & { status?: number }
      err.status = 503
      throw err
    }) as unknown as JudgeFn
    const tc = chatStub(goodResp)

    const result = (await executeScenario(
      tc,
      scenario(),
      config({ judges: [judge] }),
    )) as ScenarioResult & {
      judgeFailures?: JudgeFailure[]
    }

    expect((judge as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
    expect(result.judgeFailures![0]!.attempts).toBe(3)
    expect(result.judgeErrors).toBe(1)
  })

  it('does not retry a JudgeParseError but still records it as a failed judge', async () => {
    const judge = vi.fn(async () => {
      throw new JudgeParseError('domain', 'not json at all')
    }) as unknown as JudgeFn
    const tc = chatStub(goodResp)

    const result = (await executeScenario(
      tc,
      scenario(),
      config({ judges: [judge] }),
    )) as ScenarioResult & {
      judgeFailures?: JudgeFailure[]
    }

    expect((judge as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(result.judgeErrors).toBe(1)
    expect(result.judgeFailures![0]!.reason).toContain('unparseable')
  })
})
