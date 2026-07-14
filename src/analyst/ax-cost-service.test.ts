import {
  type AxAIService,
  type AxChatRequest,
  type AxChatResponse,
  ai as createAxAi,
} from '@ax-llm/ax'
import { describe, expect, it, vi } from 'vitest'
import { CostCeilingReachedError, CostLedger } from '../cost-ledger'
import { maximumChargeForAxChatRequest, meterAxChatService } from './ax-cost-service'
import { usageReceiptFromCostLedger } from './usage-receipt'

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
    expect(received?.modelConfig?.n).toBe(1)
    expect(receivedOptions).toMatchObject({
      retry: { maxRetries: 0 },
      stream: false,
      showThoughts: false,
      thinkingTokenBudget: 'none',
    })
    expect(ledger.list()).toHaveLength(1)
    expect(usageReceiptFromCostLedger(ledger)).toEqual({
      calls: 1,
      tokens: { input: 100, output: 20, cached: 8 },
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
          totalTokens: 133,
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

    expect(usageReceiptFromCostLedger(ledger).tokens).toEqual({
      input: 100,
      output: 20,
      reasoning: 5,
      cached: 8,
      cacheWrite: 5,
    })
  })

  it('preserves thoughts reported outside provider totals', async () => {
    const ai = fakeAi(async () => ({
      results: [{ index: 0, content: 'done' }],
      modelUsage: {
        ai: 'anthropic',
        model: 'gpt-4o-mini',
        tokens: {
          promptTokens: 20,
          completionTokens: 10,
          totalTokens: 30,
          thoughtsTokens: 100,
        },
      },
    }))
    const ledger = new CostLedger()
    const metered = meterAxChatService(ai, {
      ledger,
      actor: 'failure-mode',
      maxOutputTokens: 128,
    })

    await metered.chat(request())

    expect(usageReceiptFromCostLedger(ledger).tokens).toEqual({
      input: 20,
      output: 110,
      reasoning: 100,
    })
  })

  it('reserves the full output bound for multi-completion requests', () => {
    const input = { ...request(), modelConfig: { maxTokens: 64, n: 3 } }
    const requestBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength

    expect(maximumChargeForAxChatRequest(input)).toMatchObject({
      inputTokens: requestBytes * 3,
      outputTokens: 192,
    })
  })

  it('refuses to claim a hard maximum before completion count is explicit', () => {
    expect(
      maximumChargeForAxChatRequest({ ...request(), modelConfig: { maxTokens: 64 } }),
    ).toBeUndefined()
  })

  it('rejects invalid completion counts before calling the provider', async () => {
    const chatResponse = vi.fn(async () => ({ results: [{ index: 0, content: 'never called' }] }))
    const metered = meterAxChatService(fakeAi(chatResponse), {
      ledger: new CostLedger(1),
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await expect(metered.chat({ ...request(), modelConfig: { n: 0 } })).rejects.toThrow(
      /modelConfig\.n/,
    )
    expect(chatResponse).not.toHaveBeenCalled()
  })

  it('marks contradictory provider totals as uncaptured instead of undercounting', async () => {
    const ai = fakeAi(async () => ({
      results: [{ index: 0, content: 'done' }],
      modelUsage: {
        ai: 'openai',
        model: 'gpt-4o-mini',
        tokens: { promptTokens: 10, completionTokens: 4, totalTokens: 12 },
      },
    }))
    const ledger = new CostLedger()
    const metered = meterAxChatService(ai, {
      ledger,
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await metered.chat(request())

    expect(usageReceiptFromCostLedger(ledger)).toEqual({
      calls: 1,
      tokens: null,
      cost: { kind: 'uncaptured', usd: null },
      knownCostUsd: 0,
    })
  })

  it('keeps an observed provider charge when only token usage is missing', async () => {
    const ledger = new CostLedger()

    await ledger.runPaidCall({
      channel: 'analyst',
      phase: 'analyst.test',
      actor: 'failure-mode',
      model: 'gpt-4o-mini',
      execute: async () => undefined,
      receipt: () => ({
        model: 'gpt-4o-mini',
        inputTokens: 0,
        outputTokens: 0,
        usageUnknown: true,
        actualCostUsd: 0.25,
      }),
    })

    expect(usageReceiptFromCostLedger(ledger)).toEqual({
      calls: 1,
      tokens: null,
      cost: { kind: 'observed', usd: 0.25 },
    })
  })

  it('rejects every cache breakpoint and non-text input before a capped call', async () => {
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
    await expect(
      metered.chat({
        model: 'gpt-4o-mini',
        chatPrompt: [{ role: 'user', content: [{ type: 'text', text: 'inspect', cache: true }] }],
      }),
    ).rejects.toThrow(/hard maximumCharge/)
    await expect(
      metered.chat({
        model: 'gpt-4o-mini',
        chatPrompt: [
          {
            role: 'user',
            content: [{ type: 'image', mimeType: 'image/png', image: 'aGVsbG8=' }],
          },
        ],
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

    const usage = usageReceiptFromCostLedger(ledger)
    expect(usage.cost).toEqual({ kind: 'uncaptured', usd: null })
    expect(usage.knownCostUsd).toBeGreaterThan(0)
  })

  it('disables Ax provider retries so each reservation covers one HTTP call', async () => {
    const fetchImpl = vi.fn(async () => new Response('temporary failure', { status: 500 }))
    const ai = createAxAi({
      name: 'openai',
      apiKey: 'test-key',
      apiURL: 'https://provider.invalid/v1',
      config: { model: 'gpt-4o-mini' },
      options: { fetch: fetchImpl },
    })
    const metered = meterAxChatService(ai, {
      ledger: new CostLedger(),
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await expect(metered.chat(request(), { retry: { maxRetries: 4 } })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('keeps Gemini 3 output bounded without Ax thinking-level conflicts', async () => {
    const fetchImpl = vi.fn(
      async (_input: unknown, _init?: RequestInit) =>
        new Response('temporary failure', { status: 500 }),
    )
    const ai = createAxAi({
      name: 'google-gemini',
      apiKey: 'test-key',
      config: { model: 'models/gemini-3-flash-preview' },
      options: { fetch: fetchImpl },
    })
    const metered = meterAxChatService(ai, {
      ledger: new CostLedger(),
      actor: 'failure-mode',
      maxOutputTokens: 64,
    })

    await expect(
      metered.chat(request('models/gemini-3-flash-preview'), { thinkingTokenBudget: 'none' }),
    ).rejects.toThrow()

    expect(fetchImpl).toHaveBeenCalledOnce()
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined
    const body = JSON.parse(String(init?.body)) as {
      generationConfig?: {
        maxOutputTokens?: number
        thinkingConfig?: {
          includeThoughts?: boolean
          thinkingBudget?: number
          thinkingLevel?: string
        }
      }
    }
    expect(body.generationConfig?.maxOutputTokens).toBe(64)
    expect(body.generationConfig?.thinkingConfig).toEqual({ includeThoughts: false })
  })

  it('combines cancellation signals on every supported Node 20 release', async () => {
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      value: undefined,
    })
    const runController = new AbortController()
    const callController = new AbortController()
    let providerSignal: AbortSignal | undefined
    const ai = fakeAi(
      async (_request, callOptions) =>
        new Promise<AxChatResponse>((_resolve, reject) => {
          providerSignal = callOptions?.abortSignal as AbortSignal | undefined
          providerSignal?.addEventListener(
            'abort',
            () => reject(providerSignal?.reason ?? new DOMException('aborted', 'AbortError')),
            { once: true },
          )
        }),
    )
    const metered = meterAxChatService(ai, {
      ledger: new CostLedger(),
      actor: 'failure-mode',
      maxOutputTokens: 64,
      signal: runController.signal,
    })

    try {
      const run = metered.chat(request(), { abortSignal: callController.signal })
      await Promise.resolve()
      callController.abort(new DOMException('cancelled', 'AbortError'))

      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      expect(providerSignal?.aborted).toBe(true)
    } finally {
      if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor)
      else Reflect.deleteProperty(AbortSignal, 'any')
    }
  })
})
