/**
 * Capture-integrity contract for the scenario executor. Two failure classes
 * that a sloppy fallback erases must stay loud:
 *   1. a malformed/hung chat response must NOT be recorded as a real empty turn
 *      (capture defect, indistinguishable from a model that said nothing);
 *   2. a judge that errors must record WHY, retry only transient faults, and
 *      fail deterministic faults immediately.
 */

import { describe, expect, it, vi } from 'vitest'

import { type ChatClient, type ChatResponse, createChatClient } from './analyst/chat-client'
import { CostLedger } from './cost-ledger'
import { CaptureIntegrityError } from './errors'
import { type ExecutorConfig, executeScenario, type JudgeFailure } from './executor'
import { ModelSubstitutionError } from './integrity/served-model'
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

type StubChat = ChatClient & { handler: ReturnType<typeof vi.fn> }

function response(content: unknown, overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: content as string,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costUsd: null,
    model: 'gpt-4o',
    durationMs: 0,
    raw: {},
    ...overrides,
  }
}

function chatStub(resp: ChatResponse): StubChat {
  const handler = vi.fn(async () => resp)
  return Object.assign(
    createChatClient({
      transport: 'mock',
      defaultModel: 'gpt-4o',
      handler,
    }),
    { handler },
  )
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

describe('executeScenario — canonical chat responses preserve capture integrity', () => {
  it('meters the scenario agent and rejects it before a capped run can overspend', async () => {
    const chat = chatStub(
      response('measured', {
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      }),
    )
    const blocked = new CostLedger(0)
    await expect(
      executeScenario(chat, scenario(), config({ costLedger: blocked })),
    ).rejects.toThrow(/would exceed ceiling/)
    expect(chat.handler).not.toHaveBeenCalled()

    const admitted = new CostLedger(1)
    const result = await executeScenario(
      chat,
      scenario(),
      config({
        costLedger: admitted,
        costTags: { benchmarkRunId: 'benchmark-a' },
      }),
    )
    expect(result.cost).toMatchObject({ totalCalls: 1, inputTokens: 10, outputTokens: 2 })
    expect(admitted.list()[0]?.tags).toMatchObject({ benchmarkRunId: 'benchmark-a' })
  })

  it('marks explicitly uncaptured canonical usage as incomplete', async () => {
    const chat = chatStub(
      response('measured', {
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, captured: false },
      }),
    )
    const ledger = new CostLedger(1)
    const result = await executeScenario(chat, scenario(), config({ costLedger: ledger }))

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

  it('uses canonical provider-reported cost and token usage', async () => {
    const chat = chatStub(
      response('measured', {
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        costUsd: 0.01,
      }),
    )
    const result = await executeScenario(chat, scenario(), config({ costLedger: new CostLedger() }))

    expect(result.cost).toMatchObject({
      totalCalls: 1,
      inputTokens: 10,
      outputTokens: 2,
      totalCostUsd: 0.01,
      usageComplete: true,
      accountingComplete: true,
    })
  })

  it('throws CaptureIntegrityError when canonical content is absent', async () => {
    const chat = chatStub(response(undefined))
    await expect(executeScenario(chat, scenario(), config())).rejects.toBeInstanceOf(
      CaptureIntegrityError,
    )
  })

  it('throws when canonical content is null', async () => {
    const chat = chatStub(response(null))
    await expect(executeScenario(chat, scenario(), config())).rejects.toBeInstanceOf(
      CaptureIntegrityError,
    )
  })

  it('throws when canonical content is non-string', async () => {
    const chat = chatStub(response({ text: 'wrong shape' }))
    await expect(executeScenario(chat, scenario(), config())).rejects.toBeInstanceOf(
      CaptureIntegrityError,
    )
  })

  it('PRESERVES a legitimately-empty string — a model that chose to say nothing is real signal', async () => {
    const chat = chatStub(response(''))
    const result = await executeScenario(chat, scenario(), config())
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]!.agentResponse).toBe('')
  })
})

describe('executeScenario — judge retry policy records the reason and gates on transience', () => {
  const goodResp = response('hi there')

  it('does NOT retry a deterministic judge error — calls the judge exactly once', async () => {
    const judge = vi.fn(async () => {
      throw new Error('rubric validation failed')
    }) as unknown as JudgeFn
    const chat = chatStub(goodResp)

    const result = await executeScenario(chat, scenario(), config({ judges: [judge] }))

    expect((judge as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(result.judgeErrors).toBe(1)
  })

  it('records WHY a judge failed in additive judgeFailures with the actual error message', async () => {
    const judge = vi.fn(async () => {
      throw new Error('rubric validation failed')
    }) as unknown as JudgeFn
    const chat = chatStub(goodResp)

    const result = (await executeScenario(
      chat,
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
    const chat = chatStub(goodResp)

    const result = (await executeScenario(
      chat,
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
    const chat = chatStub(goodResp)

    const result = (await executeScenario(
      chat,
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
    const chat = chatStub(goodResp)

    const result = (await executeScenario(
      chat,
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

describe('executeScenario — served-model identity', () => {
  it('rejects a turn answered by a different model than the scenario requested', async () => {
    const chat = chatStub(response('swapped', { servedModel: 'gemini-2.5-flash-lite' }))
    await expect(
      executeScenario(chat, scenario(), config({ model: 'gpt-4.1-mini' })),
    ).rejects.toBeInstanceOf(ModelSubstitutionError)
  })

  it('names the requested and the served id so the swap is legible', async () => {
    const chat = chatStub(response('swapped', { servedModel: 'gemini-2.5-flash-lite' }))
    const error = await executeScenario(chat, scenario(), config({ model: 'gpt-4.1-mini' })).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(error?.message).toContain('gpt-4.1-mini')
    expect(error?.message).toContain('gemini-2.5-flash-lite')
  })

  it('accepts the same model spelled with a provider prefix', async () => {
    const chat = chatStub(response('fine', { servedModel: 'zai/glm-5.2' }))
    const result = await executeScenario(chat, scenario(), config({ model: 'glm-5.2' }))
    expect(result.turns).toHaveLength(1)
  })

  // A mock or CLI transport names no model. The library cannot manufacture
  // identity for it, so the run proceeds and the caller proves identity at the
  // client or in preflight.
  it('proceeds when the transport echoes no model id', async () => {
    const chat = chatStub(response('fine'))
    const result = await executeScenario(chat, scenario(), config({ model: 'glm-5.2' }))
    expect(result.turns).toHaveLength(1)
  })
})
