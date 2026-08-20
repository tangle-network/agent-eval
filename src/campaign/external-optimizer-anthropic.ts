import type { ChatResponse } from '../analyst/chat-client'
import { isRecord } from './external-optimizer-contracts'

/**
 * Translate between the Anthropic Messages API and the canonical owner-call
 * contract used by the metered optimizer model proxy.
 *
 * The `claude` CLI driven by GEPA agent engines speaks `POST /v1/messages`.
 * Each request becomes one canonical `ExternalOptimizerChatRequest`, so the
 * shared reservation, receipt, and execution-evidence pipeline applies
 * unchanged. Anything without a full-fidelity mapping onto that contract is
 * refused with a loud Anthropic error envelope. The only silent strips are
 * `metadata` and `cache_control`: the CLI always sends both, neither has a
 * canonical slot, and dropping them changes no message content.
 *
 * Tool use is refused because the canonical contract carries text-only
 * messages. Metering CLI tool calls requires a tool extension of
 * `ExternalOptimizerChatRequest` and the execution-owner result.
 */

export class AnthropicRequestRefusal extends Error {
  readonly status: number
  readonly errorType: string

  constructor(status: number, errorType: string, message: string) {
    super(message)
    this.status = status
    this.errorType = errorType
  }
}

export interface TranslatedAnthropicRequest {
  request: {
    model: string
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
    maxTokens: number
    temperature?: number
  }
  maxOutputTokens: number
  /** SSE was requested; the stream is synthesized from the completed call. */
  stream: boolean
}

const REQUEST_FIELDS = new Set([
  'model',
  'max_tokens',
  'messages',
  'system',
  'temperature',
  'stream',
  'metadata',
])

const REFUSED_REQUEST_FIELDS: Record<string, string> = {
  tools: 'tools require a tool-call extension of the canonical execution-owner contract',
  tool_choice:
    'tool_choice requires a tool-call extension of the canonical execution-owner contract',
  thinking: 'thinking has no canonical mapping; the injected CLI environment disables it',
  top_p: 'top_p has no canonical execution-owner slot',
  top_k: 'top_k has no canonical execution-owner slot',
  stop_sequences: 'stop_sequences has no canonical execution-owner slot',
}

export function translateAnthropicMessagesRequest(
  raw: Uint8Array,
  expectedModel: string,
  maxOutputTokensPerRequest: number,
): TranslatedAnthropicRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
  } catch {
    throw refuse('request must be valid JSON')
  }
  if (!isRecord(parsed)) throw refuse('request must be a JSON object')
  for (const key of Object.keys(parsed)) {
    if (REQUEST_FIELDS.has(key)) continue
    const reason = REFUSED_REQUEST_FIELDS[key]
    throw refuse(reason ?? `request field '${key}' has no metered translation and is not supported`)
  }
  if (parsed.model !== expectedModel) {
    throw refuse(`request must use configured model '${expectedModel}'`)
  }
  const maxTokens = parsed.max_tokens
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0) {
    throw refuse('request requires a positive integer max_tokens')
  }
  if ((maxTokens as number) > maxOutputTokensPerRequest) {
    throw refuse('request max_tokens exceeds maxOutputTokensPerRequest')
  }
  if (parsed.stream !== undefined && typeof parsed.stream !== 'boolean') {
    throw refuse('request stream must be a boolean')
  }
  if (
    parsed.temperature !== undefined &&
    (typeof parsed.temperature !== 'number' || !Number.isFinite(parsed.temperature))
  ) {
    throw refuse('request temperature must be a finite number')
  }

  const messages: TranslatedAnthropicRequest['request']['messages'] = []
  const systemText = translateSystem(parsed.system)
  if (systemText !== undefined) messages.push({ role: 'system', content: systemText })
  messages.push(...translateConversation(parsed.messages))

  return {
    request: {
      model: expectedModel,
      messages,
      maxTokens: maxTokens as number,
      ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    },
    maxOutputTokens: maxTokens as number,
    stream: parsed.stream === true,
  }
}

function translateSystem(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) throw refuse('system must be a string or an array of text blocks')
  return joinTextBlocks(value, 'system')
}

function translateConversation(value: unknown): TranslatedAnthropicRequest['request']['messages'] {
  if (!Array.isArray(value) || value.length === 0) {
    throw refuse('request requires a non-empty messages array')
  }
  return value.map((entry) => {
    if (!isRecord(entry)) throw refuse('each message must be an object')
    if (entry.role !== 'user' && entry.role !== 'assistant') {
      throw refuse(`message role must be 'user' or 'assistant'`)
    }
    const content =
      typeof entry.content === 'string'
        ? entry.content
        : Array.isArray(entry.content) && entry.content.length > 0
          ? joinTextBlocks(entry.content, `${entry.role} message`)
          : refuseValue(`${entry.role} message content must be a string or a non-empty block array`)
    return { role: entry.role, content }
  })
}

function joinTextBlocks(blocks: readonly unknown[], label: string): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block)) throw refuse(`${label} content blocks must be objects`)
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw refuse(`${label} text blocks require string text`)
      // `cache_control` and `citations` markers on text blocks are dropped;
      // they alter no message content and have no canonical slot.
      parts.push(block.text)
      continue
    }
    if (block.type === 'tool_use' || block.type === 'tool_result') {
      throw refuse(
        `${label} ${String(block.type)} blocks require a tool-call extension of the canonical execution-owner contract`,
      )
    }
    throw refuse(`${label} content block type '${String(block.type)}' has no metered translation`)
  }
  return parts.join('\n\n')
}

const STOP_REASON_BY_FINISH_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
}

/**
 * Encode one canonical owner response as an Anthropic message.
 *
 * Usage fields are display-level for the CLI; the ledger receipt reads the
 * same canonical response through the proxy's strict receipt checks. An
 * uncaptured usage renders as zeros here while the receipt keeps the honest
 * unknown-cost maximum.
 */
export function encodeAnthropicMessage(
  response: ChatResponse,
  callId: string,
): Record<string, unknown> {
  const finishReason = response.finishReason ?? 'stop'
  const stopReason = finishReason === null ? 'end_turn' : STOP_REASON_BY_FINISH_REASON[finishReason]
  if (stopReason === undefined) {
    throw new AnthropicRequestRefusal(
      502,
      'api_error',
      `optimizer model finish reason '${String(finishReason)}' has no Anthropic translation`,
    )
  }
  const captured = response.usage.captured !== false
  const cachedTokens = response.usage.cachedPromptTokens ?? 0
  return {
    id: `msg_${callId}`,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: response.content.length > 0 ? [{ type: 'text', text: response.content }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: captured
      ? {
          input_tokens: response.usage.promptTokens - cachedTokens,
          cache_read_input_tokens: cachedTokens,
          cache_creation_input_tokens: 0,
          output_tokens: response.usage.completionTokens,
        }
      : { input_tokens: 0, output_tokens: 0 },
  }
}

/**
 * Render one completed Anthropic message as the SSE stream the CLI expects.
 *
 * The whole stream is synthesized after the owner call completes, so the
 * event burst is exact: usage is final and a cap-violating response is
 * rejected with a real status instead of a half-delivered stream.
 */
export function renderAnthropicSseStream(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : []
  const usage = isRecord(message.usage) ? message.usage : { input_tokens: 0, output_tokens: 0 }
  const events: { event: string; data: Record<string, unknown> }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { ...message, content: [], stop_reason: null, stop_sequence: null },
      },
    },
  ]
  for (const [index, block] of content.entries()) {
    if (!isRecord(block) || block.type !== 'text') continue
    events.push(
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        },
      },
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index },
      },
    )
  }
  events.push(
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  )
  return events
    .map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`)
    .join('')
}

export function anthropicErrorEnvelope(
  errorType: string,
  message: string,
): { type: 'error'; error: { type: string; message: string } } {
  return { type: 'error', error: { type: errorType, message } }
}

export function anthropicErrorTypeForStatus(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

function refuse(message: string): AnthropicRequestRefusal {
  return new AnthropicRequestRefusal(400, 'invalid_request_error', message)
}

function refuseValue(message: string): never {
  throw refuse(message)
}
