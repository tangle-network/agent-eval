import { translateAnthropicMessagesRequest } from './external-optimizer-anthropic'
import {
  type ExternalOptimizerChatRequest,
  type ExternalOptimizerModelBudget,
  freezeJsonSnapshot,
  isRecord,
} from './external-optimizer-contracts'
import type { ModelProxyPath } from './external-optimizer-model-contract'

export function parseModelProxyRequest(
  body: Uint8Array,
  path: ModelProxyPath,
  expectedModel: string,
  budget: ExternalOptimizerModelBudget,
): {
  maxOutputTokens: number
  request: ExternalOptimizerChatRequest
  stream?: boolean
  /** Anthropic control fields the translation dropped, disclosed in ledger tags. */
  strippedFields?: readonly string[]
} {
  if (path === '/v1/messages') {
    const translated = translateAnthropicMessagesRequest(
      body,
      expectedModel,
      budget.maxOutputTokensPerRequest,
    )
    return {
      maxOutputTokens: translated.maxOutputTokens,
      stream: translated.stream,
      ...(translated.strippedFields.length > 0
        ? { strippedFields: translated.strippedFields }
        : {}),
      request: freezeJsonSnapshot(
        translated.request,
        'optimizer model canonical request',
      ) as ExternalOptimizerChatRequest,
    }
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(body).toString('utf8'))
  } catch {
    throw new Error('optimizer model request must be valid JSON')
  }
  if (!isRecord(value)) throw new Error('optimizer model request must be a JSON object')
  if (value.model !== expectedModel) {
    throw new Error(`optimizer model request must use configured model '${expectedModel}'`)
  }
  if (value.stream !== undefined && value.stream !== false) {
    throw new Error('streaming optimizer model requests are not supported')
  }
  for (const field of ['n', 'best_of', 'candidate_count', 'num_candidates'] as const) {
    if (value[field] !== undefined && value[field] !== 1) {
      throw new Error(`optimizer model request ${field} must be 1 when supplied`)
    }
  }
  if (value.reasoning !== undefined || value.reasoning_effort !== undefined) {
    throw new Error('optimizer model reasoning settings belong to the execution AgentProfile')
  }
  const maxOutputTokens = parseOutputMaximum(
    value,
    path === '/v1/responses'
      ? ['max_output_tokens']
      : ['max_tokens', 'max_completion_tokens', 'max_output_tokens'],
  )
  if (maxOutputTokens > budget.maxOutputTokensPerRequest) {
    throw new Error('optimizer model request exceeds maxOutputTokensPerRequest')
  }
  const request =
    path === '/v1/chat/completions'
      ? parseChatCompletionsRequest(value, expectedModel, maxOutputTokens)
      : parseResponsesRequest(value, expectedModel, maxOutputTokens)
  return {
    maxOutputTokens,
    request: freezeJsonSnapshot(
      request,
      'optimizer model canonical request',
    ) as ExternalOptimizerChatRequest,
  }
}

function parseChatCompletionsRequest(
  body: Record<string, unknown>,
  model: string,
  maxTokens: number,
): Omit<ExternalOptimizerChatRequest, never> {
  assertAllowedKeys(body, [
    'model',
    'messages',
    'max_tokens',
    'max_completion_tokens',
    'max_output_tokens',
    'temperature',
    'thinking',
    'response_format',
    'stream',
    'n',
    'best_of',
    'candidate_count',
    'num_candidates',
  ])
  return {
    model,
    messages: parseChatMessages(body.messages),
    maxTokens,
    ...parseTemperature(body.temperature),
    ...parseThinking(body.thinking),
    ...parseChatResponseFormat(body.response_format),
  }
}

function parseResponsesRequest(
  body: Record<string, unknown>,
  model: string,
  maxTokens: number,
): Omit<ExternalOptimizerChatRequest, never> {
  assertAllowedKeys(body, [
    'model',
    'input',
    'instructions',
    'max_output_tokens',
    'temperature',
    'thinking',
    'text',
    'stream',
    'n',
    'best_of',
    'candidate_count',
    'num_candidates',
  ])
  const instructions = body.instructions
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('optimizer Responses instructions must be a string')
  }
  return {
    model,
    messages: [
      ...(instructions === undefined ? [] : [{ role: 'system' as const, content: instructions }]),
      ...parseResponsesInput(body.input),
    ],
    maxTokens,
    ...parseTemperature(body.temperature),
    ...parseThinking(body.thinking),
    ...parseResponsesTextFormat(body.text),
  }
}

function parseOutputMaximum(body: Record<string, unknown>, fields: readonly string[]): number {
  const supplied = fields.flatMap((field) =>
    body[field] === undefined ? [] : [{ field, value: body[field] }],
  )
  if (
    supplied.length === 0 ||
    supplied.some(({ value }) => !Number.isSafeInteger(value) || (value as number) <= 0)
  ) {
    throw new Error('optimizer model request requires a positive output-token limit')
  }
  const values = new Set(supplied.map(({ value }) => value as number))
  if (values.size !== 1) {
    throw new Error('optimizer model request supplied conflicting output-token limits')
  }
  return supplied[0]!.value as number
}

function parseTemperature(value: unknown): { temperature?: number } {
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('optimizer model request temperature must be finite')
  }
  return { temperature: value }
}

function parseThinking(value: unknown): { thinking?: 'enabled' | 'disabled' } {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new Error('optimizer model request thinking must be an object')
  }
  assertAllowedKeys(value, ['type'], 'optimizer model request thinking')
  if (value.type !== 'enabled' && value.type !== 'disabled') {
    throw new Error('optimizer model request thinking.type must be enabled or disabled')
  }
  return { thinking: value.type }
}

function parseChatMessages(value: unknown): ExternalOptimizerChatRequest['messages'] {
  if (!Array.isArray(value)) throw new Error('optimizer chat request messages must be an array')
  return value.map((message, index) => parseMessage(message, `optimizer chat message ${index}`))
}

function parseResponsesInput(value: unknown): ExternalOptimizerChatRequest['messages'] {
  if (typeof value === 'string') return [{ role: 'user', content: value }]
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('optimizer Responses request requires non-empty input')
  }
  return value.map((message, index) => {
    if (!isRecord(message)) {
      throw new Error(`optimizer Responses input ${index} must be a message object`)
    }
    assertAllowedKeys(message, ['type', 'role', 'content'], `optimizer Responses input ${index}`)
    if (message.type !== undefined && message.type !== 'message') {
      throw new Error(`optimizer Responses input ${index} type must be message`)
    }
    return parseMessage(message, `optimizer Responses input ${index}`, true)
  })
}

function parseMessage(
  value: unknown,
  label: string,
  responsesContent = false,
): ExternalOptimizerChatRequest['messages'][number] {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertAllowedKeys(
    value,
    responsesContent ? ['type', 'role', 'content'] : ['role', 'content'],
    label,
  )
  if (value.role !== 'system' && value.role !== 'user' && value.role !== 'assistant') {
    throw new Error(`${label} role must be system, user, or assistant`)
  }
  return {
    role: value.role,
    content: parseMessageContent(value.content, label, responsesContent),
  }
}

function parseMessageContent(
  value: unknown,
  label: string,
  responsesContent: boolean,
): ExternalOptimizerChatRequest['messages'][number]['content'] {
  if (typeof value === 'string') return value
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} content must be text or a non-empty content array`)
  }
  return value.map((part, partIndex) => {
    if (!isRecord(part)) throw new Error(`${label} content ${partIndex} must be an object`)
    const partLabel = `${label} content ${partIndex}`
    if (part.type === 'text' || (responsesContent && part.type === 'input_text')) {
      assertAllowedKeys(part, ['type', 'text'], partLabel)
      if (typeof part.text !== 'string') throw new Error(`${partLabel} text must be a string`)
      return { type: 'text' as const, text: part.text }
    }
    if (responsesContent && part.type === 'output_text') {
      assertAllowedKeys(part, ['type', 'text'], partLabel)
      if (typeof part.text !== 'string') throw new Error(`${partLabel} text must be a string`)
      return { type: 'text' as const, text: part.text }
    }
    if (part.type === 'image_url') {
      assertAllowedKeys(part, ['type', 'image_url'], partLabel)
      if (!isRecord(part.image_url) || typeof part.image_url.url !== 'string') {
        throw new Error(`${partLabel} image_url must contain a URL string`)
      }
      assertAllowedKeys(part.image_url, ['url', 'detail'], `${partLabel} image_url`)
      const detail = parseImageDetail(part.image_url.detail, partLabel)
      return { type: 'image_url' as const, image_url: { url: part.image_url.url, ...detail } }
    }
    if (responsesContent && part.type === 'input_image') {
      assertAllowedKeys(part, ['type', 'image_url', 'detail'], partLabel)
      if (typeof part.image_url !== 'string') {
        throw new Error(`${partLabel} image_url must be a URL string`)
      }
      const detail = parseImageDetail(part.detail, partLabel)
      return { type: 'image_url' as const, image_url: { url: part.image_url, ...detail } }
    }
    throw new Error(`${partLabel} uses an unsupported content type`)
  })
}

function parseImageDetail(value: unknown, label: string): { detail?: 'auto' | 'low' | 'high' } {
  if (value === undefined) return {}
  if (value !== 'auto' && value !== 'low' && value !== 'high') {
    throw new Error(`${label} image detail must be auto, low, or high`)
  }
  return { detail: value }
}

function parseChatResponseFormat(
  value: unknown,
): Pick<ExternalOptimizerChatRequest, 'jsonMode' | 'jsonSchema'> {
  if (value === undefined) return {}
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('optimizer chat response_format must be an object with a type')
  }
  if (value.type === 'text') {
    assertAllowedKeys(value, ['type'], 'optimizer chat response_format')
    return {}
  }
  if (value.type === 'json_object') {
    assertAllowedKeys(value, ['type'], 'optimizer chat response_format')
    return { jsonMode: true }
  }
  if (value.type !== 'json_schema') {
    throw new Error('optimizer chat response_format type is unsupported')
  }
  assertAllowedKeys(value, ['type', 'json_schema'], 'optimizer chat response_format')
  return { jsonSchema: parseJsonSchema(value.json_schema, 'optimizer chat response_format') }
}

function parseResponsesTextFormat(
  value: unknown,
): Pick<ExternalOptimizerChatRequest, 'jsonMode' | 'jsonSchema'> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('optimizer Responses text must be an object')
  assertAllowedKeys(value, ['format'], 'optimizer Responses text')
  if (value.format === undefined) return {}
  if (!isRecord(value.format) || typeof value.format.type !== 'string') {
    throw new Error('optimizer Responses text.format must be an object with a type')
  }
  const format = value.format
  if (format.type === 'text') {
    assertAllowedKeys(format, ['type'], 'optimizer Responses text.format')
    return {}
  }
  if (format.type === 'json_object') {
    assertAllowedKeys(format, ['type'], 'optimizer Responses text.format')
    return { jsonMode: true }
  }
  if (format.type !== 'json_schema') {
    throw new Error('optimizer Responses text.format type is unsupported')
  }
  return { jsonSchema: parseJsonSchema(format, 'optimizer Responses text.format', true) }
}

function parseJsonSchema(
  value: unknown,
  label: string,
  flat = false,
): { name: string; schema: Record<string, unknown> } {
  if (!isRecord(value)) throw new Error(`${label} JSON schema must be an object`)
  assertAllowedKeys(value, ['name', 'schema', 'strict', ...(flat ? ['type'] : [])], label)
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error(`${label} JSON schema name must be non-empty`)
  }
  if (!isRecord(value.schema)) throw new Error(`${label} JSON schema body must be an object`)
  if (value.strict !== undefined && value.strict !== true) {
    throw new Error(`${label} JSON schema strict must be true when supplied`)
  }
  return {
    name: value.name,
    schema: freezeJsonSnapshot(value.schema, `${label} schema`) as Record<string, unknown>,
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label = 'optimizer model request',
): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key))
  if (unknown.length > 0)
    throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`)
}
