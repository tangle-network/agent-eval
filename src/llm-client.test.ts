import { describe, expect, it, vi } from 'vitest'
import { CostLedger } from './cost-ledger'
import {
  callLlm,
  callLlmJson,
  costReceiptFromLlm,
  extractJsonPayload,
  isTransientLlmError,
  LlmCallError,
  LlmClient,
  LlmResponseError,
  maximumChargeForLlmRequest,
  stripFencedJson,
} from './llm-client'
import { InMemoryRawProviderSink } from './trace/raw-provider-sink'

describe('maximumChargeForLlmRequest', () => {
  it('bounds the exact text request and its enforced output limit', () => {
    const maximum = maximumChargeForLlmRequest(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 400,
      },
      { maxRetries: 2 },
    )

    expect(maximum).toMatchObject({ model: 'gpt-4o', outputTokens: 800 })
    expect(maximum && 'inputTokens' in maximum ? maximum.inputTokens : 0).toBeGreaterThan(5)
  })

  it('reserves both request batches when schema fallback is possible', () => {
    const request = {
      model: 'gpt-4o',
      messages: [{ role: 'user' as const, content: 'hello' }],
      maxTokens: 400,
    }
    const plain = maximumChargeForLlmRequest(request, { maxRetries: 2 })
    const structured = maximumChargeForLlmRequest(
      {
        ...request,
        jsonSchema: { name: 'answer', schema: { type: 'object' } },
      },
      { maxRetries: 2 },
    )

    expect(plain && 'outputTokens' in plain ? plain.outputTokens : 0).toBe(800)
    expect(structured && 'outputTokens' in structured ? structured.outputTokens : 0).toBe(1_600)
  })

  it('prices the exact thinking mode across retries and schema fallback', () => {
    const request = {
      model: 'glm-5.2',
      messages: [{ role: 'user' as const, content: 'hello' }],
      jsonSchema: { name: 'answer', schema: { type: 'object' } },
      maxTokens: 400,
    }
    const providerDefault = maximumChargeForLlmRequest(request, { maxRetries: 2 })
    const requestDisabled = maximumChargeForLlmRequest(
      { ...request, thinking: 'disabled' },
      { maxRetries: 2 },
    )
    const clientDisabled = maximumChargeForLlmRequest(request, {
      maxRetries: 2,
      thinking: 'disabled',
    })
    const inputTokens = (maximum: typeof providerDefault): number =>
      maximum && 'inputTokens' in maximum ? maximum.inputTokens : 0

    expect(inputTokens(requestDisabled) - inputTokens(providerDefault)).toBe(124)
    expect(inputTokens(clientDisabled)).toBe(inputTokens(requestDisabled))
  })

  it('uses caller-supplied prices for an unrecognized model', () => {
    const maximum = maximumChargeForLlmRequest(
      {
        model: 'router/custom-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 400,
      },
      {
        maxRetries: 1,
        customTokenPricing: { inputUsdPerMillion: 0.27, outputUsdPerMillion: 1.1 },
      },
    )

    expect(maximum).toMatchObject({
      customTokenPricing: { inputUsdPerMillion: 0.27, outputUsdPerMillion: 1.1 },
      outputTokens: 400,
    })
  })

  it('reserves one request batch for explicit json-object schema transport', () => {
    const maximum = maximumChargeForLlmRequest(
      {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        jsonSchema: { name: 'answer', schema: { type: 'object' } },
        maxTokens: 400,
      },
      { maxRetries: 2, jsonSchemaTransport: 'json-object' },
    )

    expect(maximum && 'outputTokens' in maximum ? maximum.outputTokens : 0).toBe(800)
  })

  it('combines custom pricing with json-object schema transport', () => {
    const maximum = maximumChargeForLlmRequest(
      {
        model: 'router/custom-model',
        messages: [{ role: 'user', content: 'hello' }],
        jsonSchema: { name: 'answer', schema: { type: 'object' } },
        maxTokens: 400,
      },
      {
        maxRetries: 2,
        jsonSchemaTransport: 'json-object',
        customTokenPricing: { inputUsdPerMillion: 0.27, outputUsdPerMillion: 1.1 },
      },
    )

    expect(maximum).toMatchObject({
      customTokenPricing: { inputUsdPerMillion: 0.27, outputUsdPerMillion: 1.1 },
      outputTokens: 800,
    })
  })

  it('returns no bound for unbounded output or image input', () => {
    expect(
      maximumChargeForLlmRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).toBeUndefined()
    expect(
      maximumChargeForLlmRequest({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }],
          },
        ],
        maxTokens: 400,
      }),
    ).toBeUndefined()
  })
})

describe('costReceiptFromLlm', () => {
  it('marks omitted provider usage as incomplete instead of known zero tokens', async () => {
    const result = await callLlm(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }], maxTokens: 8 },
      {
        maxRetries: 1,
        customTokenPricing: {
          inputUsdPerMillion: 0.27,
          outputUsdPerMillion: 1.1,
        },
        fetch: async () =>
          mkOkResponse({
            model: 'gpt-4o',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          }),
      },
    )

    expect(result.usage).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      captured: false,
    })
    expect(costReceiptFromLlm(result)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      usageUnknown: true,
    })
    expect(
      costReceiptFromLlm(result, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }).actualCostUsd,
    ).toBeUndefined()
  })

  it('prices captured usage when the provider omits billed cost', async () => {
    const result = await callLlm(
      {
        model: 'router/custom-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 8,
      },
      {
        maxRetries: 1,
        customTokenPricing: {
          inputUsdPerMillion: 0.27,
          outputUsdPerMillion: 1.1,
        },
        fetch: async () =>
          mkOkResponse({
            model: 'router/custom-model',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
      },
    )

    const receipt = costReceiptFromLlm(result)
    expect(receipt).toMatchObject({
      model: 'router/custom-model',
      inputTokens: 100,
      outputTokens: 50,
      usageUnknown: false,
    })
    expect(receipt.actualCostUsd).toBeCloseTo(0.000082, 12)
  })

  it('uses the cache-read rate for cached prompt tokens', async () => {
    const result = await callLlm(
      {
        model: 'router/custom-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 8,
      },
      {
        maxRetries: 1,
        customTokenPricing: {
          inputUsdPerMillion: 1,
          cachedInputUsdPerMillion: 0.1,
          outputUsdPerMillion: 2,
        },
        fetch: async () =>
          mkOkResponse({
            model: 'router/custom-model',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
              prompt_tokens_details: { cached_tokens: 80 },
            },
          }),
      },
    )

    const receipt = costReceiptFromLlm(result)
    expect(receipt).toMatchObject({
      inputTokens: 20,
      cachedTokens: 80,
      outputTokens: 50,
    })
    expect(receipt.actualCostUsd).toBeCloseTo(0.000128, 12)
  })

  it('preserves OpenAI-compatible reasoning usage through the cost ledger', async () => {
    const result = await callLlm(
      { model: 'glm-4.5', messages: [{ role: 'user', content: 'test' }], maxTokens: 3_323 },
      {
        maxRetries: 1,
        fetch: async () =>
          mkOkResponse({
            id: 'chatcmpl-r431-fixture',
            object: 'chat.completion',
            model: 'glm-4.5',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 428,
              completion_tokens: 3_323,
              total_tokens: 3_751,
              completion_tokens_details: { reasoning_tokens: 2_072 },
            },
            cost_usd: 0.01,
          }),
      },
    )

    expect(result.usage).toMatchObject({
      promptTokens: 428,
      completionTokens: 3_323,
      totalTokens: 3_751,
      reasoningTokens: 2_072,
      captured: true,
    })
    expect(costReceiptFromLlm(result)).toMatchObject({
      inputTokens: 428,
      outputTokens: 3_323,
      reasoningTokens: 2_072,
    })

    const ledger = new CostLedger()
    const paid = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'fixture',
      actor: 'fixture',
      model: result.model,
      execute: async () => result,
      receipt: costReceiptFromLlm,
    })

    expect(paid.succeeded).toBe(true)
    if (!paid.succeeded) throw paid.error
    expect(paid.receipt.reasoningTokens).toBe(2_072)
    expect(ledger.summary()).toMatchObject({
      reasoningTokens: 2_072,
      byChannel: [{ channel: 'agent', reasoningTokens: 2_072 }],
    })
  })

  it('marks internally inconsistent provider usage as incomplete', async () => {
    const result = await callLlm(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }], maxTokens: 8 },
      {
        maxRetries: 1,
        fetch: async () =>
          mkOkResponse({
            model: 'gpt-4o',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 1,
              total_tokens: 2,
              prompt_tokens_details: { cached_tokens: 20 },
            },
          }),
      },
    )

    expect(result.usage.captured).toBe(false)
    expect(costReceiptFromLlm(result).usageUnknown).toBe(true)
  })

  it('marks reasoning usage larger than completion usage as incomplete', async () => {
    const result = await callLlm(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }], maxTokens: 8 },
      {
        maxRetries: 1,
        fetch: async () =>
          mkOkResponse({
            model: 'gpt-4o',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
              completion_tokens_details: { reasoning_tokens: 6 },
            },
          }),
      },
    )

    expect(result.usage.captured).toBe(false)
    expect(costReceiptFromLlm(result).usageUnknown).toBe(true)
  })
})

function mockFetch(handlers: Array<(url: string, init: RequestInit) => Promise<Response>>) {
  let call = 0
  return ((url: string, init: RequestInit) => {
    const h = handlers[Math.min(call, handlers.length - 1)]
    call++
    return h!(url, init)
  }) as unknown as typeof fetch
}

function mkOkResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function mkErrResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers })
}

describe('llm-client — stripFencedJson', () => {
  it('strips ```json fences', () => {
    expect(stripFencedJson('```json\n{"a": 1}\n```')).toBe('{"a": 1}')
  })

  it('strips bare ``` fences', () => {
    expect(stripFencedJson('```\n{"a": 1}\n```')).toBe('{"a": 1}')
  })

  it('leaves unfenced JSON alone (idempotent)', () => {
    expect(stripFencedJson('{"a": 1}')).toBe('{"a": 1}')
  })

  it('preserves newlines inside JSON', () => {
    const input = '```json\n{\n  "a": 1\n}\n```'
    const out = stripFencedJson(input)
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })
})

describe('llm-client — extractJsonPayload', () => {
  it('keeps complete top-level objects and arrays intact', () => {
    expect(extractJsonPayload('{"findings":[{"claim":"complete"}]}')).toBe(
      '{"findings":[{"claim":"complete"}]}',
    )
    expect(extractJsonPayload('[{"claim":"complete"}]')).toBe('[{"claim":"complete"}]')
  })

  it('extracts a balanced JSON object after prose', () => {
    expect(extractJsonPayload('Reviewing artifact. {"ok": true, "items": [1, 2]}')).toBe(
      '{"ok": true, "items": [1, 2]}',
    )
  })

  it('skips prose braces before the real payload', () => {
    expect(extractJsonPayload('note {not json} then {"ok": true} trailing')).toBe('{"ok": true}')
  })

  it('preserves braces inside strings', () => {
    expect(extractJsonPayload('prefix {"text": "{literal}", "ok": true} suffix')).toBe(
      '{"text": "{literal}", "ok": true}',
    )
  })

  it('does not recover a nested array from an incomplete top-level object', () => {
    const truncated = '{"findings":[{"claim":"complete nested item"}]'
    expect(extractJsonPayload(truncated)).toBe(truncated)
    expect(() => JSON.parse(extractJsonPayload(truncated))).toThrow()
  })

  it('does not recover a nested object from an incomplete top-level array', () => {
    const truncated = '[{"claim":"complete nested item"}'
    expect(extractJsonPayload(truncated)).toBe(truncated)
    expect(() => JSON.parse(extractJsonPayload(truncated))).toThrow()
  })
})

describe('llm-client — callLlm happy path', () => {
  it('returns content + usage + costUsd when present', async () => {
    const fetch = mockFetch([
      async () =>
        mkOkResponse({
          model: 'gpt-test',
          choices: [{ message: { content: 'hello' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          _response_cost: 0.0123,
        }),
    ])
    const r = await callLlm(
      { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] },
      { fetch, baseUrl: 'https://example.test/v1' },
    )
    expect(r.content).toBe('hello')
    expect(r.usage.totalTokens).toBe(15)
    expect(r.costUsd).toBeCloseTo(0.0123)
    expect(r.model).toBe('gpt-test')
  })

  it('posts to <baseUrl>/chat/completions with Bearer header', async () => {
    const fetch = vi.fn(async () =>
      mkOkResponse({ choices: [{ message: { content: '' } }], usage: {} }),
    )
    await callLlm(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        baseUrl: 'https://r.example/v1',
        apiKey: 'sk-abc',
        idempotencyKey: 'cost-call-123',
      },
    )
    expect(fetch).toHaveBeenCalledOnce()
    const call0 = (fetch.mock.calls[0] ?? []) as unknown as [string, RequestInit]
    const url = call0[0]
    const init = call0[1]
    expect(url).toBe('https://r.example/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-abc')
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('cost-call-123')
  })

  it('uses max_completion_tokens for GPT-5 chat-completions models', async () => {
    const fetch = vi.fn(async () =>
      mkOkResponse({ choices: [{ message: { content: '' } }], usage: {} }),
    )
    await callLlm(
      { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'x' }], maxTokens: 64 },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-abc',
      },
    )

    const call = (fetch.mock.calls[0] ?? []) as unknown as [string, RequestInit]
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>
    expect(body.max_completion_tokens).toBe(64)
    expect(body.max_tokens).toBeUndefined()
  })

  it('keeps max_tokens for other OpenAI-compatible chat models', async () => {
    const fetch = vi.fn(async () =>
      mkOkResponse({ choices: [{ message: { content: '' } }], usage: {} }),
    )
    await callLlm(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], maxTokens: 64 },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-abc',
      },
    )

    const call = (fetch.mock.calls[0] ?? []) as unknown as [string, RequestInit]
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>
    expect(body.max_tokens).toBe(64)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('sends and captures a client-default thinking mode', async () => {
    const sink = new InMemoryRawProviderSink()
    const fetch = vi.fn(async () =>
      mkOkResponse({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} }),
    )
    await callLlm(
      {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'Return JSON.' }],
        jsonMode: true,
        maxTokens: 64,
      },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        rawSink: sink,
        provider: 'zai-coding-plan',
        traceContext: { runId: 'thinking-control', spanId: 'structured-output' },
        thinking: 'disabled',
      },
    )

    const call = (fetch.mock.calls[0] ?? []) as unknown as [string, RequestInit]
    const outboundBody = JSON.parse(String(call[1].body)) as Record<string, unknown>
    expect(outboundBody.thinking).toEqual({ type: 'disabled' })
    const [request] = await sink.list({ direction: 'request' })
    expect(request?.requestBody).toMatchObject({
      model: 'glm-5.2',
      thinking: { type: 'disabled' },
    })
  })

  it('lets a per-call thinking mode override the client default', async () => {
    const fetch = vi.fn(async () =>
      mkOkResponse({ choices: [{ message: { content: '' } }], usage: {} }),
    )
    await callLlm(
      {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'x' }],
        thinking: 'enabled',
      },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        thinking: 'disabled',
      },
    )

    const call = (fetch.mock.calls[0] ?? []) as unknown as [string, RequestInit]
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'enabled' })
  })

  it('omits thinking when the caller leaves provider behavior unchanged', async () => {
    const fetch = vi.fn(async () =>
      mkOkResponse({ choices: [{ message: { content: '' } }], usage: {} }),
    )
    await callLlm(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    )

    const call = (fetch.mock.calls[0] ?? []) as unknown as [string, RequestInit]
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
  })

  it('supports custom authHeader over apiKey', async () => {
    const fetch = vi.fn(async () => mkOkResponse({ choices: [], usage: {} }))
    await callLlm(
      { model: 'm', messages: [] },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        apiKey: 'ignored',
        authHeader: { name: 'X-Custom-Auth', value: 'token-123' },
      },
    )
    const call = (fetch.mock.calls[0] ?? []) as unknown as [string, RequestInit]
    const headers = call[1].headers as Record<string, string>
    expect(headers['X-Custom-Auth']).toBe('token-123')
    expect(headers.Authorization).toBeUndefined()
  })
})

describe('llm-client — retry semantics', () => {
  it('retries on 429 with Retry-After header honored', async () => {
    const calls: number[] = []
    const fetch = mockFetch([
      async () => {
        calls.push(429)
        return mkErrResponse(429, 'rate limit', { 'retry-after': '0' })
      },
      async () => {
        calls.push(200)
        return mkOkResponse({ choices: [{ message: { content: 'ok' } }], usage: {} })
      },
    ])
    const r = await callLlm(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { fetch, maxRetries: 3 },
    )
    expect(r.content).toBe('ok')
    expect(calls).toEqual([429, 200])
  })

  it('retries on 503 gateway', async () => {
    const fetch = mockFetch([
      async () => mkErrResponse(503, 'upstream unreachable'),
      async () => mkOkResponse({ choices: [{ message: { content: 'ok' } }], usage: {} }),
    ])
    const r = await callLlm(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { fetch, maxRetries: 3 },
    )
    expect(r.content).toBe('ok')
  })

  it('fails fast on 400 without retry', async () => {
    const fetch = vi.fn(async () => mkErrResponse(400, 'bad request'))
    await expect(
      callLlm(
        { model: 'm', messages: [] },
        { fetch: fetch as unknown as typeof globalThis.fetch, maxRetries: 3 },
      ),
    ).rejects.toBeInstanceOf(LlmCallError)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('gives up after maxRetries on persistent 502', async () => {
    const fetch = vi.fn(async () => mkErrResponse(502, 'bad gateway'))
    await expect(
      callLlm(
        { model: 'm', messages: [] },
        { fetch: fetch as unknown as typeof globalThis.fetch, maxRetries: 2 },
      ),
    ).rejects.toBeInstanceOf(LlmCallError)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('AbortError counts as retriable', async () => {
    let call = 0
    const fetch: typeof globalThis.fetch = (async (_url: string) => {
      call++
      if (call === 1) {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
      return mkOkResponse({ choices: [{ message: { content: 'recovered' } }], usage: {} })
    }) as unknown as typeof globalThis.fetch
    const r = await callLlm({ model: 'm', messages: [] }, { fetch, maxRetries: 3 })
    expect(r.content).toBe('recovered')
  })

  it('retries an HTTP/2 transport fault instead of crashing', async () => {
    // Regression: undici raises `terminated` / NGHTTP2_INTERNAL_ERROR for an
    // HTTP/2 connection that drops mid-response. The old classifier only
    // matched `fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN`, so this escaped
    // the retry loop and surfaced as an uncaught rejection.
    let call = 0
    const fetch: typeof globalThis.fetch = (async (_url: string) => {
      call++
      if (call === 1) {
        const cause = new Error('NGHTTP2_INTERNAL_ERROR')
        throw new TypeError('terminated', { cause })
      }
      return mkOkResponse({ choices: [{ message: { content: 'recovered' } }], usage: {} })
    }) as unknown as typeof globalThis.fetch
    const r = await callLlm({ model: 'm', messages: [] }, { fetch, maxRetries: 3 })
    expect(r.content).toBe('recovered')
    expect(call).toBe(2)
  })
})

describe('llm-client — caller AbortSignal + cross-attempt deadline', () => {
  it('an already-aborted caller signal fails loud without firing fetch', async () => {
    const fetch = vi.fn(async () =>
      mkOkResponse({ choices: [{ message: { content: 'x' } }], usage: {} }),
    ) as unknown as typeof globalThis.fetch
    const controller = new AbortController()
    controller.abort()
    await expect(
      callLlm({ model: 'm', messages: [] }, { fetch, signal: controller.signal }),
    ).rejects.toThrow(/abort/i)
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('a caller abort mid-call is NOT retried — it surfaces immediately', async () => {
    // Regression: callLlm took no external signal, so a campaign cancel could
    // not stop an in-flight call, AND an AbortError matches the transient
    // patterns — so a naive wiring would retry the cancelled call.
    const controller = new AbortController()
    let calls = 0
    const fetch: typeof globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls++
      controller.abort()
      // Mirror fetch's behavior: a request whose linked signal aborts rejects.
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      void init
      throw err
    }) as unknown as typeof globalThis.fetch

    await expect(
      callLlm({ model: 'm', messages: [] }, { fetch, signal: controller.signal, maxRetries: 3 }),
    ).rejects.toThrow(/abort/i)
    expect(calls).toBe(1)
  })

  it('a caller abort cancels the in-flight fetch via the linked signal', async () => {
    const controller = new AbortController()
    const fetch: typeof globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })) as unknown as typeof globalThis.fetch

    const p = callLlm({ model: 'm', messages: [] }, { fetch, signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toThrow(/abort/i)
  })

  it('stops retrying once the cross-attempt deadline is exhausted', async () => {
    // Per-attempt timeout still bounds each call, but a tight wall-clock budget
    // must cut the retry loop short rather than waiting full timeout × retries.
    let calls = 0
    const fetch: typeof globalThis.fetch = (async () => {
      calls++
      // Burn the entire deadline on the first attempt's "work".
      await new Promise((r) => setTimeout(r, 30))
      return mkErrResponse(503, 'still unavailable')
    }) as unknown as typeof globalThis.fetch

    await expect(
      callLlm({ model: 'm', messages: [] }, { fetch, maxRetries: 5, deadlineMs: 10 }),
    ).rejects.toBeInstanceOf(LlmCallError)
    // Without the deadline this would retry up to 5 times; the budget caps it at 1.
    expect(calls).toBe(1)
  })
})

describe('llm-client — empty-content + finishReason signals', () => {
  it('flags empty content and surfaces finish_reason=length (truncation)', async () => {
    const fetch = mockFetch([
      async () =>
        mkOkResponse({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
          usage: {},
        }),
    ])
    const r = await callLlm({ model: 'm', messages: [] }, { fetch })
    expect(r.content).toBe('')
    expect(r.contentEmpty).toBe(true)
    expect(r.finishReason).toBe('length')
  })

  it('non-empty content reports contentEmpty=false and finish_reason=stop', async () => {
    const fetch = mockFetch([
      async () =>
        mkOkResponse({
          choices: [{ message: { content: 'real answer' }, finish_reason: 'stop' }],
          usage: {},
        }),
    ])
    const r = await callLlm({ model: 'm', messages: [] }, { fetch })
    expect(r.contentEmpty).toBe(false)
    expect(r.finishReason).toBe('stop')
  })

  it('whitespace-only content counts as empty; missing finish_reason is null', async () => {
    const fetch = mockFetch([
      async () => mkOkResponse({ choices: [{ message: { content: '   \n ' } }], usage: {} }),
    ])
    const r = await callLlm({ model: 'm', messages: [] }, { fetch })
    expect(r.contentEmpty).toBe(true)
    expect(r.finishReason).toBeNull()
  })
})

describe('llm-client — isTransientLlmError classification', () => {
  it('classifies HTTP/2 + undici transport faults as transient', () => {
    expect(isTransientLlmError(new Error('terminated'))).toBe(true)
    expect(isTransientLlmError(new Error('NGHTTP2_INTERNAL_ERROR'))).toBe(true)
    expect(isTransientLlmError(new Error('other side closed'))).toBe(true)
    expect(isTransientLlmError(new Error('socket hang up'))).toBe(true)
    const coded = Object.assign(new Error('connection lost'), { code: 'UND_ERR_SOCKET' })
    expect(isTransientLlmError(coded)).toBe(true)
  })

  it('follows the undici cause chain to the real socket fault', () => {
    const wrapped = new TypeError('fetch failed', {
      cause: new Error('terminated', { cause: new Error('NGHTTP2_INTERNAL_ERROR') }),
    })
    expect(isTransientLlmError(wrapped)).toBe(true)
  })

  it('classifies network + abort faults as transient', () => {
    expect(isTransientLlmError(new Error('ECONNRESET'))).toBe(true)
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isTransientLlmError(abort)).toBe(true)
  })

  it('treats LlmCallError as transient only on retriable status', () => {
    expect(isTransientLlmError(new LlmCallError('rate limited', 429, '', 'm'))).toBe(true)
    expect(isTransientLlmError(new LlmCallError('bad gateway', 503, '', 'm'))).toBe(true)
    expect(isTransientLlmError(new LlmCallError('bad request', 400, '', 'm'))).toBe(false)
    expect(isTransientLlmError(new LlmCallError('unauthorized', 401, '', 'm'))).toBe(false)
  })

  it('does NOT retry deterministic failures', () => {
    expect(isTransientLlmError(new SyntaxError('Unexpected token < in JSON'))).toBe(false)
    expect(isTransientLlmError(new Error('response_format json_schema not supported'))).toBe(false)
    expect(isTransientLlmError('not an error')).toBe(false)
    expect(isTransientLlmError(undefined)).toBe(false)
  })

  it('terminates on a self-referential cause chain', () => {
    const err = new Error('boom') as Error & { cause?: unknown }
    err.cause = err
    expect(isTransientLlmError(err)).toBe(false)
  })
})

describe('llm-client — callLlmJson + schema degrade', () => {
  it('parses json_object content', async () => {
    const fetch = mockFetch([
      async () => mkOkResponse({ choices: [{ message: { content: '{"foo": 42}' } }], usage: {} }),
    ])
    const { value } = await callLlmJson<{ foo: number }>(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { fetch },
    )
    expect(value.foo).toBe(42)
  })

  it('degrades json_schema → json_object on 400 schema-reject', async () => {
    const bodies: string[] = []
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string)
      if (bodies.length === 1) {
        return mkErrResponse(400, 'response_format.type json_schema is unavailable for this model')
      }
      return mkOkResponse({ choices: [{ message: { content: '{"ok": true}' } }], usage: {} })
    }) as unknown as typeof globalThis.fetch

    const { value } = await callLlmJson<{ ok: boolean }>(
      {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'x' }],
        jsonSchema: { name: 's', schema: { type: 'object' } },
      },
      { fetch },
    )

    expect(value.ok).toBe(true)
    expect(bodies).toHaveLength(2)
    // First attempt used json_schema; second degraded to json_object.
    const first = JSON.parse(bodies[0]!)
    const second = JSON.parse(bodies[1]!)
    expect(first.response_format?.type).toBe('json_schema')
    expect(second.response_format?.type).toBe('json_object')
  })

  it('uses one json_object request when the caller selects that schema transport', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return mkOkResponse({ choices: [{ message: { content: '{"ok": true}' } }], usage: {} })
    }) as unknown as typeof globalThis.fetch

    const { value } = await callLlmJson<{ ok: boolean }>(
      {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'Return the required JSON.' }],
        jsonSchema: { name: 's', schema: { type: 'object' } },
      },
      { fetch, jsonSchemaTransport: 'json-object' },
    )

    expect(value.ok).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.response_format).toEqual({ type: 'json_object' })
  })

  it('does NOT degrade on non-schema-related 400', async () => {
    const fetch = vi.fn(async () => mkErrResponse(400, 'messages is required'))
    await expect(
      callLlmJson(
        {
          model: 'm',
          messages: [],
          jsonSchema: { name: 's', schema: { type: 'object' } },
        },
        { fetch: fetch as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toBeInstanceOf(LlmCallError)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('throws typed error on unparseable JSON content', async () => {
    const fetch = mockFetch([
      async () =>
        mkOkResponse({ choices: [{ message: { content: 'not json at all' } }], usage: {} }),
    ])
    await expect(
      callLlmJson({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { fetch }),
    ).rejects.toThrow(/non-JSON/)
  })

  it('rejects an incomplete top-level object instead of parsing its nested findings array', async () => {
    const fetch = mockFetch([
      async () =>
        mkOkResponse({
          choices: [{ message: { content: '{"findings":[{"claim":"complete nested item"}]' } }],
          usage: {},
        }),
    ])
    await expect(
      callLlmJson({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { fetch }),
    ).rejects.toThrow(/non-JSON/)
  })

  it('rejects a parsable JSON prefix when the provider reports length truncation', async () => {
    const fetch = mockFetch([
      async () =>
        mkOkResponse({
          choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'length' }],
          usage: {},
        }),
    ])
    await expect(
      callLlmJson({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { fetch }),
    ).rejects.toThrow(/truncated JSON content.*finishReason=length/)
  })

  it('strips fenced JSON before parsing (regression)', async () => {
    const fetch = mockFetch([
      async () =>
        mkOkResponse({
          choices: [{ message: { content: '```json\n{"wrapped": true}\n```' } }],
          usage: {},
        }),
    ])
    const { value } = await callLlmJson<{ wrapped: boolean }>(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { fetch },
    )
    expect(value.wrapped).toBe(true)
  })

  it('parses JSON payloads with leading prose', async () => {
    const fetch = mockFetch([
      async () =>
        mkOkResponse({
          choices: [{ message: { content: 'Reviewing artifact first. {"wrapped": true}' } }],
          usage: {},
        }),
    ])
    const { value } = await callLlmJson<{ wrapped: boolean }>(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { fetch },
    )
    expect(value.wrapped).toBe(true)
  })

  it('requires one complete JSON value in exact payload mode', async () => {
    const exactFetch = mockFetch([
      async () =>
        mkOkResponse({ choices: [{ message: { content: ' \n {"wrapped": true}\t' } }], usage: {} }),
    ])
    const { value } = await callLlmJson<{ wrapped: boolean }>(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { fetch: exactFetch, jsonPayloadMode: 'exact' },
    )
    expect(value.wrapped).toBe(true)

    for (const content of [
      'before {"wrapped":true}',
      '{"wrapped":true} after',
      '```json\n{"wrapped":true}\n```',
      '{"wrapped":true}{"second":true}',
    ]) {
      const fetch = mockFetch([
        async () => mkOkResponse({ choices: [{ message: { content } }], usage: {} }),
      ])
      await expect(
        callLlmJson(
          { model: 'm', messages: [{ role: 'user', content: 'x' }] },
          { fetch, jsonPayloadMode: 'exact' },
        ),
      ).rejects.toBeInstanceOf(LlmResponseError)
    }
  })
})

describe('llm-client — probeLlm', () => {
  it('returns ok=true + latency when LLM responds', async () => {
    const fetch = mockFetch([
      async () => mkOkResponse({ choices: [{ message: { content: 'pong' } }], usage: {} }),
    ])
    const { probeLlm } = await import('./llm-client')
    const r = await probeLlm('m', { fetch })
    expect(r.ok).toBe(true)
    expect(r.error).toBeNull()
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns ok=false with error message on 4xx', async () => {
    const fetch = mockFetch([async () => mkErrResponse(401, 'Invalid Authentication')])
    const { probeLlm } = await import('./llm-client')
    const r = await probeLlm('m', { fetch, maxRetries: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/401|Invalid Authentication/)
  })

  it('returns ok=false on network error', async () => {
    const failingFetch: typeof globalThis.fetch = (async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const { probeLlm } = await import('./llm-client')
    const r = await probeLlm('m', { fetch: failingFetch, maxRetries: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/fetch failed/)
  })
})

describe('llm-client — LlmClient wrapper', () => {
  it('inherits default opts and allows per-call overrides', async () => {
    const fetch = vi.fn(async () =>
      mkOkResponse({ choices: [{ message: { content: 'x' } }], usage: {} }),
    ) as unknown as typeof globalThis.fetch
    const client = new LlmClient({ fetch, apiKey: 'default' })
    await client.call({ model: 'm', messages: [] }, { apiKey: 'override' })
    const call = ((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ??
      []) as unknown as [string, RequestInit]
    const headers = call[1].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer override')
  })
})
