import { describe, expect, it } from 'vitest'
import type { CostReceiptInput } from '../cost-ledger'
import { assertJsonValue, type ExternalOptimizerChatRequest } from './external-optimizer-contracts'
import { createOpenAiCompatibleExecutionOwner } from './openai-compatible-execution-owner'

const REQUEST = Object.freeze({
  model: 'router/optimizer-model',
  messages: Object.freeze([Object.freeze({ role: 'user' as const, content: 'reflect' })]),
  maxTokens: 64,
}) as unknown as ExternalOptimizerChatRequest

function okBody(): object {
  return {
    model: 'router/optimizer-model',
    choices: [
      { message: { role: 'assistant', content: 'improved prompt' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  }
}

function assertNoUndefinedValues(receipt: CostReceiptInput): void {
  expect(() => assertJsonValue(receipt, 'receipt')).not.toThrow()
  expect(Object.values(receipt)).not.toContain(undefined)
}

describe('createOpenAiCompatibleExecutionOwner', () => {
  it('executes the exact admitted request and returns a JSON-clean receipt', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const call = createOpenAiCompatibleExecutionOwner({
      baseUrl: 'https://endpoint.test/v1',
      apiKey: 'secret-key',
      model: 'router/optimizer-model',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init })
        return new Response(JSON.stringify(okBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    const result = await call({
      callId: 'call-1',
      request: REQUEST,
      signal: new AbortController().signal,
    })

    expect(result.succeeded).toBe(true)
    if (!result.succeeded) throw new Error(result.error)
    expect(result.response.content).toBe('improved prompt')
    expect(result.receipt).toMatchObject({
      model: 'router/optimizer-model',
      inputTokens: 120,
      outputTokens: 40,
      usageUnknown: false,
    })
    assertNoUndefinedValues(result.receipt)
    expect(() => assertJsonValue(result.execution, 'execution')).not.toThrow()
    expect(result.execution).toMatchObject({
      owner: 'openai-compatible',
      endpoint: 'https://endpoint.test/v1',
      callId: 'call-1',
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://endpoint.test/v1/chat/completions')
    const headers = seen[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret-key')
    expect(headers['Idempotency-Key']).toBe('call-1')
    const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>
    expect(body.model).toBe('router/optimizer-model')
    expect(body.messages).toEqual([{ role: 'user', content: 'reflect' }])
  })

  it('passes canonical tools to the wire and returns canonical tool calls', async () => {
    const seen: Array<{ init: RequestInit }> = []
    const call = createOpenAiCompatibleExecutionOwner({
      baseUrl: 'https://endpoint.test/v1',
      apiKey: 'secret-key',
      model: 'router/optimizer-model',
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push({ init })
        return new Response(
          JSON.stringify({
            model: 'router/optimizer-model',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'Bash', arguments: '{"command":"ls"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch,
    })

    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'Bash',
          description: 'Run a command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
    ]
    const request = Object.freeze({
      ...REQUEST,
      tools: Object.freeze(tools),
      toolChoice: 'auto',
    }) as unknown as ExternalOptimizerChatRequest

    const result = await call({
      callId: 'call-tools',
      request,
      signal: new AbortController().signal,
    })

    expect(result.succeeded).toBe(true)
    if (!result.succeeded) throw new Error(result.error)
    expect(result.response.content).toBe('')
    expect(result.response.toolCalls).toEqual([
      { id: 'call_1', name: 'Bash', argumentsJson: '{"command":"ls"}' },
    ])
    expect(result.response.finishReason).toBe('tool_use')
    assertNoUndefinedValues(result.receipt)

    const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>
    expect(body.tools).toEqual(tools)
    expect(body.tool_choice).toBe('auto')
  })

  it('treats a tool-free answer to a tool-carrying request as a valid answer', async () => {
    const call = createOpenAiCompatibleExecutionOwner({
      baseUrl: 'https://endpoint.test/v1',
      apiKey: 'secret-key',
      model: 'router/optimizer-model',
      fetch: (async () =>
        new Response(JSON.stringify(okBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })

    const request = Object.freeze({
      ...REQUEST,
      tools: Object.freeze([
        {
          type: 'function' as const,
          function: { name: 'Bash', parameters: { type: 'object' } },
        },
      ]),
    }) as unknown as ExternalOptimizerChatRequest

    const result = await call({
      callId: 'call-no-tools-used',
      request,
      signal: new AbortController().signal,
    })

    expect(result.succeeded).toBe(true)
    if (!result.succeeded) throw new Error(result.error)
    expect(result.response.content).toBe('improved prompt')
    expect(result.response.toolCalls).toBeUndefined()
    expect(result.response.finishReason).toBe('stop')
  })

  it('estimates cost from the configured pricing when the provider omits billed cost', async () => {
    const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }
    const call = createOpenAiCompatibleExecutionOwner({
      baseUrl: 'https://endpoint.test/v1',
      apiKey: 'secret-key',
      model: 'router/optimizer-model',
      pricing,
      fetch: (async () =>
        new Response(JSON.stringify(okBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })

    const result = await call({
      callId: 'call-2',
      request: REQUEST,
      signal: new AbortController().signal,
    })

    expect(result.succeeded).toBe(true)
    if (!result.succeeded) throw new Error(result.error)
    expect(result.receipt.customTokenPricing).toEqual(pricing)
    expect(result.receipt.actualCostUsd).toBeUndefined()
    assertNoUndefinedValues(result.receipt)
  })

  it('returns a typed failure with an unknown-usage receipt on a provider error', async () => {
    const call = createOpenAiCompatibleExecutionOwner({
      baseUrl: 'https://endpoint.test/v1',
      apiKey: 'secret-key',
      model: 'router/optimizer-model',
      fetch: (async () =>
        new Response('{"error":"invalid api key"}', { status: 401 })) as unknown as typeof fetch,
    })

    const result = await call({
      callId: 'call-3',
      request: REQUEST,
      signal: new AbortController().signal,
    })

    expect(result.succeeded).toBe(false)
    if (result.succeeded) throw new Error('expected a typed failure')
    expect(result.error).toContain('401')
    expect(result.receipt).toEqual({
      model: 'router/optimizer-model',
      inputTokens: 0,
      outputTokens: 0,
      costUnknown: true,
      usageUnknown: true,
    })
    assertNoUndefinedValues(result.receipt)
    expect(result.execution).toMatchObject({ failed: true, callId: 'call-3' })
    expect(() => assertJsonValue(result.execution, 'execution')).not.toThrow()
  })

  it('rejects a blank credential before any call executes', () => {
    expect(() =>
      createOpenAiCompatibleExecutionOwner({
        baseUrl: 'https://endpoint.test/v1',
        apiKey: '  ',
        model: 'router/optimizer-model',
      }),
    ).toThrow(/apiKey/)
  })
})
