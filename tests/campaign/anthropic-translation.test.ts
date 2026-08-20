import { describe, expect, it } from 'vitest'
import type { ChatResponse } from '../../src/analyst/chat-client'
import {
  AnthropicRequestRefusal,
  anthropicErrorEnvelope,
  anthropicErrorTypeForStatus,
  encodeAnthropicMessage,
  renderAnthropicSseStream,
  translateAnthropicMessagesRequest,
} from '../../src/campaign/external-optimizer-anthropic'

const MODEL = 'model'
const MAX_OUTPUT_TOKENS = 100

function translate(body: Record<string, unknown>) {
  return translateAnthropicMessagesRequest(
    new TextEncoder().encode(JSON.stringify(body)),
    MODEL,
    MAX_OUTPUT_TOKENS,
  )
}

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 20,
    messages: [{ role: 'user', content: 'improve the candidate' }],
    ...overrides,
  }
}

function chatResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: 'better',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    costUsd: 0.00002,
    model: MODEL,
    durationMs: 12,
    finishReason: 'stop',
    raw: {},
    ...overrides,
  }
}

describe('translateAnthropicMessagesRequest', () => {
  it('translates system, turns, max_tokens, temperature, and stream', () => {
    const translated = translate(
      baseRequest({
        system: 'You improve candidates.',
        temperature: 0.5,
        stream: true,
        metadata: { user_id: 'session-1' },
        messages: [
          { role: 'user', content: 'improve the candidate' },
          { role: 'assistant', content: [{ type: 'text', text: 'draft one' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'go further', cache_control: { type: 'ephemeral' } },
              { type: 'text', text: 'and keep it short' },
            ],
          },
        ],
      }),
    )
    expect(translated).toEqual({
      request: {
        model: MODEL,
        maxTokens: 20,
        temperature: 0.5,
        messages: [
          { role: 'system', content: 'You improve candidates.' },
          { role: 'user', content: 'improve the candidate' },
          { role: 'assistant', content: 'draft one' },
          { role: 'user', content: 'go further\n\nand keep it short' },
        ],
      },
      maxOutputTokens: 20,
      stream: true,
    })
  })

  it('joins system text blocks and strips their cache_control', () => {
    const translated = translate(
      baseRequest({
        system: [
          { type: 'text', text: 'part one', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'part two' },
        ],
      }),
    )
    expect(translated.request.messages[0]).toEqual({
      role: 'system',
      content: 'part one\n\npart two',
    })
  })

  it.each([
    ['tools', [{ name: 'run_eval', input_schema: { type: 'object' } }]],
    ['tool_choice', { type: 'auto' }],
    ['thinking', { type: 'enabled', budget_tokens: 1024 }],
    ['top_p', 0.9],
    ['top_k', 40],
    ['stop_sequences', ['END']],
  ])('refuses %s loudly', (field, value) => {
    expect(() => translate(baseRequest({ [field]: value }))).toThrow(AnthropicRequestRefusal)
  })

  it('names the owner-contract gap when refusing tools', () => {
    expect(() =>
      translate(baseRequest({ tools: [{ name: 'run_eval', input_schema: {} }] })),
    ).toThrow('tools require a tool-call extension of the canonical execution-owner contract')
  })

  it('refuses tool_use and tool_result content blocks', () => {
    expect(() =>
      translate(
        baseRequest({
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'toolu_1', name: 'run_eval', input: {} }],
            },
          ],
        }),
      ),
    ).toThrow('tool-call extension')
    expect(() =>
      translate(
        baseRequest({
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'score 1' }],
            },
          ],
        }),
      ),
    ).toThrow('tool-call extension')
  })

  it('refuses image blocks, unknown fields, and unknown roles', () => {
    expect(() =>
      translate(
        baseRequest({
          messages: [
            { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: '' } }] },
          ],
        }),
      ),
    ).toThrow("content block type 'image' has no metered translation")
    expect(() => translate(baseRequest({ service_tier: 'auto' }))).toThrow(
      "request field 'service_tier' has no metered translation",
    )
    expect(() =>
      translate(baseRequest({ messages: [{ role: 'system', content: 'no system turns' }] })),
    ).toThrow("message role must be 'user' or 'assistant'")
  })

  it('requires the configured model and a bounded max_tokens', () => {
    expect(() => translate(baseRequest({ model: 'claude-sonnet-4-6' }))).toThrow(
      `request must use configured model '${MODEL}'`,
    )
    expect(() => translate(baseRequest({ max_tokens: undefined }))).toThrow(
      'request requires a positive integer max_tokens',
    )
    expect(() => translate(baseRequest({ max_tokens: MAX_OUTPUT_TOKENS + 1 }))).toThrow(
      'request max_tokens exceeds maxOutputTokensPerRequest',
    )
  })

  it('refuses non-JSON bodies with a 400 refusal', () => {
    const error = (() => {
      try {
        translateAnthropicMessagesRequest(
          new TextEncoder().encode('not json'),
          MODEL,
          MAX_OUTPUT_TOKENS,
        )
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(AnthropicRequestRefusal)
    expect((error as AnthropicRequestRefusal).status).toBe(400)
    expect((error as AnthropicRequestRefusal).errorType).toBe('invalid_request_error')
  })
})

describe('encodeAnthropicMessage', () => {
  it('encodes text, stop_reason, and usage with cache reads separated', () => {
    const message = encodeAnthropicMessage(
      chatResponse({
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 4 },
      }),
      'call-1',
    )
    expect(message).toEqual({
      id: 'msg_call-1',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'better' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 6,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
        output_tokens: 5,
      },
    })
  })

  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
    [null, 'end_turn'],
  ])('maps finish reason %s to %s', (finishReason, stopReason) => {
    const message = encodeAnthropicMessage(chatResponse({ finishReason }), 'call-2')
    expect(message.stop_reason).toBe(stopReason)
  })

  it('treats an omitted finish reason as a completed turn', () => {
    const response = chatResponse()
    delete (response as { finishReason?: string | null }).finishReason
    expect(encodeAnthropicMessage(response, 'call-3').stop_reason).toBe('end_turn')
  })

  it('rejects finish reasons without an Anthropic translation', () => {
    let caught: unknown
    try {
      encodeAnthropicMessage(chatResponse({ finishReason: 'tool_calls' }), 'call-4')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AnthropicRequestRefusal)
    expect((caught as AnthropicRequestRefusal).status).toBe(502)
    expect((caught as AnthropicRequestRefusal).errorType).toBe('api_error')
  })

  it('renders zero display usage when the owner did not capture usage', () => {
    const message = encodeAnthropicMessage(
      chatResponse({
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, captured: false },
      }),
      'call-5',
    )
    expect(message.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })
})

describe('renderAnthropicSseStream', () => {
  it('renders the exact event sequence with final usage', () => {
    const message = encodeAnthropicMessage(chatResponse(), 'call-6')
    const stream = renderAnthropicSseStream(message)
    const events = [...stream.matchAll(/^event: (.+)$/gm)].map((match) => match[1])
    expect(events).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(stream).toContain('"type":"text_delta","text":"better"')
    const delta = /event: message_delta\ndata: (.+)\n/.exec(stream)
    expect(JSON.parse(delta![1]!)).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    })
    expect(stream.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true)
  })
})

describe('anthropic error surfaces', () => {
  it('wraps messages in the Anthropic error envelope', () => {
    expect(anthropicErrorEnvelope('invalid_request_error', 'nope')).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'nope' },
    })
  })

  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [402, 'invalid_request_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [413, 'request_too_large'],
    [429, 'rate_limit_error'],
    [502, 'api_error'],
    [504, 'api_error'],
  ])('maps status %i to %s', (status, errorType) => {
    expect(anthropicErrorTypeForStatus(status)).toBe(errorType)
  })
})
