import type { AxAIService, AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { describe, expect, it, vi } from 'vitest'
import { CostCeilingReachedError, CostLedger } from '../cost-ledger'
import { analystUsageFromCostLedger, meterAxChatService } from './ax-cost-service'

function request(model = 'gpt-4o-mini'): AxChatRequest {
  return {
    model,
    chatPrompt: [{ role: 'user', content: 'inspect this trace' }],
  }
}

function fakeAi(
  chat: (
    request: Readonly<AxChatRequest>,
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<AxChatResponse>,
): AxAIService {
  return { chat } as AxAIService
}

describe('meterAxChatService', () => {
  it('records every chat receipt independently of analyst findings', async () => {
    let received: Readonly<AxChatRequest<unknown>> | undefined
    let receivedOptions: Readonly<Record<string, unknown>> | undefined
    const ai = fakeAi(async (input, callOptions) => {
      received = input
      receivedOptions = callOptions
      return {
        results: [{ index: 0, content: 'done' }],
        modelUsage: {
          ai: 'openai',
          model: 'gpt-4o-mini',
          tokens: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            cacheReadTokens: 8,
          },
        },
      }
    })
    const ledger = new CostLedger(1)
    const metered = meterAxChatService(ai, {
      ledger,
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await metered.chat(request())

    expect(received?.modelConfig?.maxTokens).toBe(64)
    expect(receivedOptions).toMatchObject({ retry: { maxRetries: 0 }, stream: false })
    expect(ledger.list()).toHaveLength(1)
    expect(analystUsageFromCostLedger(ledger)).toEqual({
      calls: 1,
      tokens: { input: 92, output: 20, cached: 8 },
      cost: { kind: 'estimated', usd: expect.any(Number) },
    })
  })

  it('bounds a caller-supplied output limit without increasing it', async () => {
    let maxTokens: number | undefined
    const ai = fakeAi(async (input) => {
      maxTokens = input.modelConfig?.maxTokens
      return {
        results: [{ index: 0, content: 'done' }],
        modelUsage: {
          ai: 'openai',
          model: 'gpt-4o-mini',
          tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      }
    })
    const metered = meterAxChatService(ai, {
      ledger: new CostLedger(),
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await metered.chat({ ...request(), modelConfig: { maxTokens: 16 } })

    expect(maxTokens).toBe(16)
  })

  it('rejects before the provider call when the hard budget is exhausted', async () => {
    const chatResponse = vi.fn(async () => ({
      results: [{ index: 0, content: 'never called' }],
    }))
    const metered = meterAxChatService(fakeAi(chatResponse), {
      ledger: new CostLedger(0),
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await expect(metered.chat(request())).rejects.toBeInstanceOf(CostCeilingReachedError)
    expect(chatResponse).not.toHaveBeenCalled()
  })

  it('rejects an unpriced model before spending a capped run', async () => {
    const chatResponse = vi.fn(async () => ({
      results: [{ index: 0, content: 'never called' }],
    }))
    const metered = meterAxChatService(fakeAi(chatResponse), {
      ledger: new CostLedger(1),
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await expect(metered.chat(request('private-model-without-pricing'))).rejects.toThrow(
      /cannot reserve unpriced model/,
    )
    expect(chatResponse).not.toHaveBeenCalled()
  })

  it('uses the configured service model when Ax omits a request override', async () => {
    const chatResponse = vi.fn(async () => ({
      results: [{ index: 0, content: 'done' }],
      modelUsage: {
        ai: 'openai',
        model: 'gpt-4o-mini',
        tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      },
    }))
    const ledger = new CostLedger(1)
    const metered = meterAxChatService(fakeAi(chatResponse), {
      ledger,
      actor: 'failure-mode',
      maxOutputTokens: 64,
      defaultModel: 'gpt-4o-mini',
    })

    await metered.chat({ chatPrompt: [{ role: 'user', content: 'inspect' }] })

    expect(chatResponse).toHaveBeenCalledOnce()
    expect(ledger.list()[0]?.model).toBe('gpt-4o-mini')
  })

  it('reconciles cache and reasoning tokens whether Ax reports them inside or outside totals', async () => {
    const ai = fakeAi(async () => ({
      results: [{ index: 0, content: 'done' }],
      modelUsage: {
        ai: 'anthropic',
        model: 'gpt-4o-mini',
        tokens: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 138,
          reasoningTokens: 5,
          cacheCreationTokens: 5,
          cacheReadTokens: 8,
        },
      },
    }))
    const ledger = new CostLedger()
    const metered = meterAxChatService(ai, {
      ledger,
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await metered.chat(request())

    expect(analystUsageFromCostLedger(ledger).tokens).toEqual({
      input: 100,
      output: 25,
      cached: 13,
    })
  })

  it('rejects cache breakpoints before a capped call because cache-write pricing is provider-specific', async () => {
    const chatResponse = vi.fn(async () => ({ results: [{ index: 0, content: 'never called' }] }))
    const metered = meterAxChatService(fakeAi(chatResponse), {
      ledger: new CostLedger(1),
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await expect(
      metered.chat({
        model: 'gpt-4o-mini',
        chatPrompt: [{ role: 'user', content: 'inspect', cache: true }],
      }),
    ).rejects.toThrow(/hard maximumCharge/)
    expect(chatResponse).not.toHaveBeenCalled()
  })

  it('retains known spend when a later provider call has no receipt', async () => {
    let call = 0
    const ai = fakeAi(async () => {
      call += 1
      if (call === 2) throw new Error('provider disconnected')
      return {
        results: [{ index: 0, content: 'done' }],
        modelUsage: {
          ai: 'openai',
          model: 'gpt-4o-mini',
          tokens: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
        },
      }
    })
    const ledger = new CostLedger()
    const metered = meterAxChatService(ai, {
      ledger,
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await metered.chat(request())
    await expect(metered.chat(request())).rejects.toThrow('provider disconnected')

    const usage = analystUsageFromCostLedger(ledger)
    expect(usage.cost).toEqual({ kind: 'uncaptured', usd: null })
    expect(usage.knownCostUsd).toBeGreaterThan(0)
  })
})
