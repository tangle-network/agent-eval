import type { ChatResponse } from '../analyst/chat-client'
import type { LlmToolCall, LlmToolChoice, LlmToolDefinition } from '../llm-client'
import { isRecord } from './external-optimizer-contracts'

/**
 * Translate between the Anthropic Messages API and the canonical owner-call
 * contract used by the metered optimizer model proxy.
 *
 * The `claude` CLI driven by GEPA agent engines speaks `POST /v1/messages`.
 * Each request becomes one canonical `ExternalOptimizerChatRequest`, so the
 * shared reservation, receipt, and execution-evidence pipeline applies
 * unchanged. Tool use translates in both directions: Anthropic `tools`,
 * `tool_choice`, `tool_use`, and `tool_result` map onto the canonical
 * function-tool contract, and a tool-calling response is synthesized back as
 * the Anthropic stream shape the CLI expects.
 *
 * Anything without a full-fidelity mapping onto the canonical contract is
 * refused with a loud Anthropic error envelope, with two exceptions:
 *
 * - `metadata` and `cache_control` are dropped silently: the CLI always sends
 *   both, neither has a canonical slot, and dropping them changes no content.
 * - Claude-specific control fields (`thinking`, `context_management`,
 *   `output_config`, replayed reasoning blocks, and unknown tool-entry keys)
 *   are STRIPPED AND RECORDED. They carry no token-billing semantics on the
 *   owner wire, and the real CLI sends them on every request — refusing them
 *   makes every real CLI call impossible. The dropped names are returned in
 *   `strippedFields` so accounting discloses exactly what the shim removed.
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

interface TranslatedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: LlmToolCall[]
  toolCallId?: string
}

export interface TranslatedAnthropicRequest {
  request: {
    model: string
    messages: TranslatedMessage[]
    maxTokens: number
    temperature?: number
    tools?: LlmToolDefinition[]
    toolChoice?: LlmToolChoice
  }
  maxOutputTokens: number
  /** SSE was requested; the stream is synthesized from the completed call. */
  stream: boolean
  /** Sorted names of control fields dropped from the canonical request. */
  strippedFields: readonly string[]
}

const REQUEST_FIELDS = new Set([
  'model',
  'max_tokens',
  'messages',
  'system',
  'temperature',
  'stream',
  'metadata',
  'tools',
  'tool_choice',
])

// Claude-specific control fields with no token-billing semantics on the owner
// wire. The CLI sends `thinking` even under CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING,
// and `output_config` leaks from user settings through the engine sandbox.
const STRIPPED_REQUEST_FIELDS = new Set(['thinking', 'context_management', 'output_config'])

const REFUSED_REQUEST_FIELDS: Record<string, string> = {
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
  const stripped = new Set<string>()
  for (const key of Object.keys(parsed)) {
    if (REQUEST_FIELDS.has(key)) continue
    if (STRIPPED_REQUEST_FIELDS.has(key)) {
      stripped.add(key)
      continue
    }
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

  const messages: TranslatedMessage[] = []
  const systemText = translateSystem(parsed.system)
  if (systemText !== undefined) messages.push({ role: 'system', content: systemText })
  messages.push(...translateConversation(parsed.messages, stripped))
  const tools = translateTools(parsed.tools, stripped)
  const toolChoice = translateToolChoice(parsed.tool_choice, stripped)

  return {
    request: {
      model: expectedModel,
      messages,
      maxTokens: maxTokens as number,
      ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
      ...(tools === undefined ? {} : { tools }),
      ...(toolChoice === undefined ? {} : { toolChoice }),
    },
    maxOutputTokens: maxTokens as number,
    stream: parsed.stream === true,
    strippedFields: [...stripped].sort(),
  }
}

const TOOL_ENTRY_FIELDS = new Set(['name', 'description', 'input_schema', 'type', 'cache_control'])

function translateTools(value: unknown, stripped: Set<string>): LlmToolDefinition[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw refuse('tools must be a non-empty array of tool definitions')
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw refuse(`tools[${index}] must be an object`)
    // Server tools carry versioned `type` values and execute on Anthropic
    // infrastructure; they have no metered translation onto the owner wire.
    if (entry.type !== undefined && entry.type !== 'custom') {
      throw refuse(
        `tools[${index}] type '${String(entry.type)}' has no metered translation; only client function tools are served`,
      )
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      throw refuse(`tools[${index}] requires a non-empty name`)
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      throw refuse(`tools[${index}] description must be a string`)
    }
    if (!isRecord(entry.input_schema)) {
      throw refuse(`tools[${index}] requires an input_schema object`)
    }
    // `cache_control` alters no tool content and is dropped like elsewhere.
    // Any other unknown key is Claude control surface with no canonical slot:
    // dropped and disclosed instead of failing every real CLI call.
    for (const key of Object.keys(entry)) {
      if (TOOL_ENTRY_FIELDS.has(key)) continue
      stripped.add(`tools.${key}`)
    }
    return {
      type: 'function' as const,
      function: {
        name: entry.name,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        parameters: entry.input_schema as Record<string, unknown>,
      },
    }
  })
}

function translateToolChoice(value: unknown, stripped: Set<string>): LlmToolChoice | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw refuse('tool_choice must be an object with a type')
  }
  for (const key of Object.keys(value)) {
    if (key === 'type') continue
    if (key === 'name' && value.type === 'tool') continue
    if (key === 'disable_parallel_tool_use') {
      // No canonical slot; the owner wire decides its own parallelism.
      stripped.add('tool_choice.disable_parallel_tool_use')
      continue
    }
    throw refuse(`tool_choice field '${key}' has no metered translation`)
  }
  if (value.type === 'auto') return 'auto'
  if (value.type === 'none') return 'none'
  if (value.type === 'any') return 'required'
  if (value.type === 'tool') {
    if (typeof value.name !== 'string' || !value.name.trim()) {
      throw refuse('tool_choice type tool requires a tool name')
    }
    return { type: 'function', function: { name: value.name } }
  }
  throw refuse(`tool_choice type '${String(value.type)}' has no metered translation`)
}

function translateSystem(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) throw refuse('system must be a string or an array of text blocks')
  return joinTextBlocks(value, 'system')
}

function translateConversation(value: unknown, stripped: Set<string>): TranslatedMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw refuse('request requires a non-empty messages array')
  }
  const out: TranslatedMessage[] = []
  for (const entry of value) {
    if (!isRecord(entry)) throw refuse('each message must be an object')
    // The claude CLI injects `system`-role turns mid-conversation (budget
    // status lines, session listings, task reminders); the canonical contract
    // allows the system role at any position, so they translate in place.
    if (entry.role !== 'system' && entry.role !== 'user' && entry.role !== 'assistant') {
      throw refuse(`message role must be 'system', 'user', or 'assistant'`)
    }
    if (typeof entry.content === 'string') {
      out.push({ role: entry.role, content: entry.content })
      continue
    }
    if (!Array.isArray(entry.content) || entry.content.length === 0) {
      throw refuse(`${entry.role} message content must be a string or a non-empty block array`)
    }
    if (entry.role === 'system') {
      out.push({ role: 'system', content: joinTextBlocks(entry.content, 'system') })
    } else if (entry.role === 'assistant') {
      out.push(translateAssistantBlocks(entry.content, stripped))
    } else {
      out.push(...translateUserBlocks(entry.content, stripped))
    }
  }
  return out
}

function translateAssistantBlocks(
  blocks: readonly unknown[],
  stripped: Set<string>,
): TranslatedMessage {
  const parts: string[] = []
  const toolCalls: LlmToolCall[] = []
  for (const block of blocks) {
    if (!isRecord(block)) throw refuse('assistant message content blocks must be objects')
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        throw refuse('assistant message text blocks require string text')
      }
      parts.push(block.text)
      continue
    }
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id.trim()) {
        throw refuse('assistant tool_use blocks require a string id')
      }
      if (typeof block.name !== 'string' || !block.name.trim()) {
        throw refuse('assistant tool_use blocks require a string name')
      }
      if (!isRecord(block.input)) throw refuse('assistant tool_use blocks require an input object')
      toolCalls.push({ id: block.id, name: block.name, argumentsJson: JSON.stringify(block.input) })
      continue
    }
    // Replayed reasoning blocks have no canonical slot and no billing effect
    // on the owner wire: dropped and disclosed instead of failing every
    // thinking-enabled CLI conversation.
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      stripped.add(`messages.${String(block.type)}`)
      continue
    }
    throw refuse(
      `assistant message content block type '${String(block.type)}' has no metered translation`,
    )
  }
  return {
    role: 'assistant',
    content: parts.join('\n\n'),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  }
}

function translateUserBlocks(
  blocks: readonly unknown[],
  stripped: Set<string>,
): TranslatedMessage[] {
  const out: TranslatedMessage[] = []
  const textParts: string[] = []
  const flushText = () => {
    if (textParts.length === 0) return
    out.push({ role: 'user', content: textParts.join('\n\n') })
    textParts.length = 0
  }
  for (const block of blocks) {
    if (!isRecord(block)) throw refuse('user message content blocks must be objects')
    if (block.type === 'text') {
      if (typeof block.text !== 'string')
        throw refuse('user message text blocks require string text')
      textParts.push(block.text)
      continue
    }
    if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id.trim()) {
        throw refuse('user tool_result blocks require a string tool_use_id')
      }
      // `is_error` has no canonical slot; the failure text already lives in
      // the result content, so only the flag itself is dropped and disclosed.
      if (block.is_error === true) stripped.add('messages.tool_result.is_error')
      flushText()
      out.push({
        role: 'tool',
        content: toolResultText(block.content),
        toolCallId: block.tool_use_id,
      })
      continue
    }
    throw refuse(
      `user message content block type '${String(block.type)}' has no metered translation`,
    )
  }
  flushText()
  return out
}

function toolResultText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    throw refuse('user tool_result content must be a string or a block array')
  }
  const parts: string[] = []
  for (const block of value) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      throw refuse('user tool_result content blocks must be text blocks')
    }
    parts.push(block.text)
  }
  return parts.join('\n\n')
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
    throw refuse(`${label} content block type '${String(block.type)}' has no metered translation`)
  }
  return parts.join('\n\n')
}

const STOP_REASON_BY_FINISH_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
  // 'tool_calls' is the OpenAI wire echo; 'tool_use' is the canonical
  // normalization the execution owner applies. Both denote the same stop.
  tool_calls: 'tool_use',
  tool_use: 'tool_use',
}

/**
 * Encode one canonical owner response as an Anthropic message.
 *
 * Usage fields are display-level for the CLI; the ledger receipt reads the
 * same canonical response through the proxy's strict receipt checks. An
 * uncaptured usage renders as zeros here while the receipt keeps the honest
 * unknown-cost maximum. Canonical tool calls become `tool_use` content blocks
 * after the text block, matching Anthropic block ordering.
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
  const content: Record<string, unknown>[] = []
  if (response.content.length > 0) content.push({ type: 'text', text: response.content })
  for (const call of response.toolCalls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolInput(call) })
  }
  return {
    id: `msg_${callId}`,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
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

function parseToolInput(call: LlmToolCall): Record<string, unknown> {
  const text = call.argumentsJson.trim()
  if (text === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AnthropicRequestRefusal(
      502,
      'api_error',
      `optimizer model tool call '${call.name}' returned arguments that are not valid JSON`,
    )
  }
  if (!isRecord(parsed)) {
    throw new AnthropicRequestRefusal(
      502,
      'api_error',
      `optimizer model tool call '${call.name}' arguments must encode a JSON object`,
    )
  }
  return parsed
}

/**
 * Render one completed Anthropic message as the SSE stream the CLI expects.
 *
 * The whole stream is synthesized after the owner call completes, so the
 * event burst is exact: usage is final and a cap-violating response is
 * rejected with a real status instead of a half-delivered stream. A
 * `tool_use` block streams as an empty-input `content_block_start` plus one
 * `input_json_delta` carrying the complete arguments JSON.
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
    if (!isRecord(block)) continue
    if (block.type === 'text') {
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
      continue
    }
    if (block.type === 'tool_use') {
      events.push(
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          },
        },
        {
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index },
        },
      )
    }
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
