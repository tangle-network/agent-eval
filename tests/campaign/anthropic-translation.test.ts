import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
      strippedFields: [],
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
    ['top_p', 0.9],
    ['top_k', 40],
    ['stop_sequences', ['END']],
  ])('refuses %s loudly', (field, value) => {
    expect(() => translate(baseRequest({ [field]: value }))).toThrow(AnthropicRequestRefusal)
  })

  it('translates tools into canonical function definitions', () => {
    const translated = translate(
      baseRequest({
        tools: [
          {
            name: 'Bash',
            description: 'Run a command',
            input_schema: { type: 'object', properties: { command: { type: 'string' } } },
            cache_control: { type: 'ephemeral' },
          },
          { type: 'custom', name: 'Read', input_schema: { type: 'object' } },
        ],
      }),
    )
    expect(translated.request.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'Bash',
          description: 'Run a command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
      { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } },
    ])
    expect(translated.strippedFields).toEqual([])
  })

  it('records unknown tool-entry keys instead of refusing them', () => {
    const translated = translate(
      baseRequest({
        tools: [{ name: 'Bash', input_schema: { type: 'object' }, defer_loading: true }],
      }),
    )
    expect(translated.request.tools).toHaveLength(1)
    expect(translated.strippedFields).toEqual(['tools.defer_loading'])
  })

  it('refuses server tool types loudly', () => {
    expect(() =>
      translate(baseRequest({ tools: [{ type: 'web_search_20260209', name: 'web_search' }] })),
    ).toThrow("type 'web_search_20260209' has no metered translation")
  })

  it.each([
    [{ type: 'auto' }, 'auto'],
    [{ type: 'none' }, 'none'],
    [{ type: 'any' }, 'required'],
    [
      { type: 'tool', name: 'Bash' },
      { type: 'function', function: { name: 'Bash' } },
    ],
  ])('maps tool_choice %j to %j', (toolChoice, expected) => {
    const translated = translate(baseRequest({ tool_choice: toolChoice }))
    expect(translated.request.toolChoice).toEqual(expected)
  })

  it('strips and records disable_parallel_tool_use on tool_choice', () => {
    const translated = translate(
      baseRequest({ tool_choice: { type: 'auto', disable_parallel_tool_use: true } }),
    )
    expect(translated.request.toolChoice).toBe('auto')
    expect(translated.strippedFields).toEqual(['tool_choice.disable_parallel_tool_use'])
  })

  it('strips and records thinking, context_management, and output_config', () => {
    const translated = translate(
      baseRequest({
        thinking: { type: 'adaptive', display: 'omitted' },
        context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
        output_config: { effort: 'xhigh' },
      }),
    )
    expect(translated.strippedFields).toEqual(['context_management', 'output_config', 'thinking'])
    expect(translated.request.messages).toEqual([
      { role: 'user', content: 'improve the candidate' },
    ])
  })

  it('translates assistant tool_use blocks into canonical tool calls', () => {
    const translated = translate(
      baseRequest({
        messages: [
          { role: 'user', content: 'improve' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'running the eval' },
              { type: 'thinking', thinking: '', signature: 'sig' },
              { type: 'tool_use', id: 'toolu_1', name: 'run_eval', input: { case: 'a' } },
            ],
          },
        ],
      }),
    )
    expect(translated.request.messages).toEqual([
      { role: 'user', content: 'improve' },
      {
        role: 'assistant',
        content: 'running the eval',
        toolCalls: [{ id: 'toolu_1', name: 'run_eval', argumentsJson: '{"case":"a"}' }],
      },
    ])
    expect(translated.strippedFields).toEqual(['messages.thinking'])
  })

  it('translates user tool_result blocks into canonical tool messages in block order', () => {
    const translated = translate(
      baseRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'score 1' },
              {
                type: 'tool_result',
                tool_use_id: 'toolu_2',
                content: [{ type: 'text', text: 'exit 1' }],
                is_error: true,
              },
              { type: 'text', text: 'keep going' },
            ],
          },
        ],
      }),
    )
    expect(translated.request.messages).toEqual([
      { role: 'tool', content: 'score 1', toolCallId: 'toolu_1' },
      { role: 'tool', content: 'exit 1', toolCallId: 'toolu_2' },
      { role: 'user', content: 'keep going' },
    ])
    expect(translated.strippedFields).toEqual(['messages.tool_result.is_error'])
  })

  it('translates the captured claude CLI wire request instead of refusing it', () => {
    // Ground truth: the wire capture of claude CLI 2.1.232 POSTing the shim
    // (scratchpad proof against published 0.150.0). The capture retains the
    // exact top-level keys and control-field values; message and tool bodies
    // are reconstructed minimally.
    const capture = JSON.parse(
      readFileSync(join(__dirname, '../fixtures/claude-cli-messages-request.json'), 'utf8'),
    ) as {
      keys: string[]
      thinking: Record<string, unknown>
      context_management: Record<string, unknown>
      output_config: Record<string, unknown>
      stream: boolean
      max_tokens: number
      model: string
      toolNames: string[]
    }
    const body: Record<string, unknown> = {
      model: capture.model,
      messages: [{ role: 'user', content: 'improve the candidate' }],
      system: [{ type: 'text', text: 'You are Claude Code.' }],
      tools: capture.toolNames.map((name) => ({
        name,
        description: `${name} tool`,
        input_schema: { type: 'object', properties: {} },
      })),
      metadata: { user_id: 'session-1' },
      max_tokens: capture.max_tokens,
      thinking: capture.thinking,
      context_management: capture.context_management,
      output_config: capture.output_config,
      stream: capture.stream,
    }
    // The reconstructed body carries exactly the captured key set.
    expect(Object.keys(body).sort()).toEqual([...capture.keys].sort())

    const translated = translateAnthropicMessagesRequest(
      new TextEncoder().encode(JSON.stringify(body)),
      capture.model,
      capture.max_tokens,
    )
    expect(translated.stream).toBe(true)
    expect(translated.maxOutputTokens).toBe(capture.max_tokens)
    expect(translated.strippedFields).toEqual(['context_management', 'output_config', 'thinking'])
    expect(translated.request.tools).toHaveLength(capture.toolNames.length)
    expect(translated.request.tools?.map((tool) => tool.function.name)).toEqual(capture.toolNames)
    expect(translated.request.tools?.every((tool) => tool.type === 'function')).toBe(true)
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
    ['tool_calls', 'tool_use'],
    ['tool_use', 'tool_use'],
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
      encodeAnthropicMessage(chatResponse({ finishReason: 'weird' }), 'call-4')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AnthropicRequestRefusal)
    expect((caught as AnthropicRequestRefusal).status).toBe(502)
    expect((caught as AnthropicRequestRefusal).errorType).toBe('api_error')
  })

  it('encodes tool calls as tool_use blocks after the text block', () => {
    const message = encodeAnthropicMessage(
      chatResponse({
        finishReason: 'tool_use',
        toolCalls: [
          { id: 'call_1', name: 'Bash', argumentsJson: '{"command":"ls"}' },
          { id: 'call_2', name: 'Read', argumentsJson: '' },
        ],
      }),
      'call-6',
    )
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toEqual([
      { type: 'text', text: 'better' },
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'call_2', name: 'Read', input: {} },
    ])
  })

  it('rejects tool-call arguments that do not encode a JSON object', () => {
    for (const argumentsJson of ['not json', '[1,2]']) {
      let caught: unknown
      try {
        encodeAnthropicMessage(
          chatResponse({
            finishReason: 'tool_use',
            toolCalls: [{ id: 'call_1', name: 'Bash', argumentsJson }],
          }),
          'call-7',
        )
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AnthropicRequestRefusal)
      expect((caught as AnthropicRequestRefusal).status).toBe(502)
    }
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

  it('streams tool_use blocks as start, input_json_delta, and stop events', () => {
    const message = encodeAnthropicMessage(
      chatResponse({
        finishReason: 'tool_use',
        toolCalls: [{ id: 'call_1', name: 'Bash', argumentsJson: '{"command":"ls"}' }],
      }),
      'call-8',
    )
    const stream = renderAnthropicSseStream(message)
    const events = [...stream.matchAll(/^event: (.+)$/gm)].map((match) => match[1])
    expect(events).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(stream).toContain(
      '"content_block":{"type":"tool_use","id":"call_1","name":"Bash","input":{}}',
    )
    expect(stream).toContain(
      '"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}',
    )
    const delta = /event: message_delta\ndata: (.+)\n/.exec(stream)
    expect(JSON.parse(delta![1]!)).toMatchObject({
      delta: { stop_reason: 'tool_use', stop_sequence: null },
    })
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
