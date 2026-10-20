import type {
  LlmCallRequest,
  LlmClientOptions,
  LlmMessage,
  LlmThinkingMode,
  LlmTokenLogprob,
  LlmToolCall,
} from './contract'

export function providerTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function buildHeaders(opts: LlmClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (opts.authHeader) {
    headers[opts.authHeader.name] = opts.authHeader.value
  } else if (opts.bearer || opts.apiKey) {
    headers.Authorization = `Bearer ${opts.bearer ?? opts.apiKey}`
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  return headers
}

export function isSchemaRejection(status: number, body: string): boolean {
  if (status !== 400) return false
  const lower = body.toLowerCase()
  return (
    lower.includes('response_format') ||
    lower.includes('json_schema') ||
    lower.includes('is unavailable') ||
    lower.includes('not supported')
  )
}

export function isTemperatureOneRejection(status: number, body: string): boolean {
  if (status !== 400 || !/temperature/i.test(body)) return false
  return (
    /temperature[^.\n]{0,120}\b(?:only|must|should|required|requires?)\b[^.\n]{0,40}\b1(?:\.0+)?\b/i.test(
      body,
    ) || /\bonly\s+1(?:\.0+)?\s+is\s+allowed\b[^.\n]{0,120}\btemperature\b/i.test(body)
  )
}

export function buildBody(
  req: LlmCallRequest,
  forceJsonObject: boolean,
  defaultThinking?: LlmThinkingMode,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(encodeWireMessage),
    temperature: req.temperature ?? 0,
  }
  if (req.maxTokens != null) {
    if (usesMaxCompletionTokens(req.model)) body.max_completion_tokens = req.maxTokens
    else body.max_tokens = req.maxTokens
  }
  if (req.logprobs !== undefined) {
    body.logprobs = true
    body.top_logprobs = req.logprobs.topLogprobs
  }
  if (req.tools !== undefined) body.tools = req.tools
  if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice
  const thinking = req.thinking ?? defaultThinking
  if (thinking !== undefined) {
    body.thinking = { type: thinking }
  }

  if (req.jsonSchema && !forceJsonObject) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
    }
  } else if (req.jsonMode || req.jsonSchema) {
    body.response_format = { type: 'json_object' }
  }

  return body
}

function usesMaxCompletionTokens(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model)
}

/** Encode one canonical message as its OpenAI chat-completions wire shape. */
function encodeWireMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  if (message.toolCalls === undefined) {
    return { role: message.role, content: message.content }
  }
  return {
    role: message.role,
    content: message.content,
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.argumentsJson },
    })),
  }
}

/**
 * Parse `choices[0].logprobs.content` into the canonical per-token shape.
 * `null` when the provider returned nothing for a request that asked: a
 * provider that ignores `logprobs` is a fact the caller must be able to read,
 * not an error. A malformed entry is a contract violation and throws.
 */
export function parseWireLogprobs(
  value: unknown,
  model: string,
): ReadonlyArray<LlmTokenLogprob> | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) {
    throw new Error(`LLM response logprobs.content must be an array (model=${model})`)
  }
  return value.map((entry, index) => {
    const record = entry as { token?: unknown; logprob?: unknown; top_logprobs?: unknown } | null
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.token !== 'string' ||
      typeof record.logprob !== 'number' ||
      !Number.isFinite(record.logprob)
    ) {
      throw new Error(
        `LLM response logprobs.content[${index}] is not a token with a finite logprob (model=${model})`,
      )
    }
    const top = record.top_logprobs
    if (top !== undefined && top !== null && !Array.isArray(top)) {
      throw new Error(
        `LLM response logprobs.content[${index}].top_logprobs must be an array (model=${model})`,
      )
    }
    return {
      token: record.token,
      logprob: record.logprob,
      top: (Array.isArray(top) ? top : []).map((alternative, position) => {
        const candidate = alternative as { token?: unknown; logprob?: unknown } | null
        if (
          !candidate ||
          typeof candidate !== 'object' ||
          typeof candidate.token !== 'string' ||
          typeof candidate.logprob !== 'number' ||
          !Number.isFinite(candidate.logprob)
        ) {
          throw new Error(
            `LLM response logprobs.content[${index}].top_logprobs[${position}] is not a token with a finite logprob (model=${model})`,
          )
        }
        return { token: candidate.token, logprob: candidate.logprob }
      }),
    }
  })
}

/** Parse provider tool_calls into the canonical shape. A malformed entry is a
 * provider-contract violation and throws rather than degrading silently. */
export function parseWireToolCalls(value: unknown, model: string): LlmToolCall[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`LLM response tool_calls must be an array (model=${model})`)
  }
  if (value.length === 0) return undefined
  return value.map((entry, index) => {
    const record = entry as {
      id?: unknown
      type?: unknown
      function?: { name?: unknown; arguments?: unknown } | null
    } | null
    const fn = record && typeof record === 'object' ? record.function : undefined
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.id !== 'string' ||
      record.id.length === 0 ||
      (record.type !== undefined && record.type !== 'function') ||
      !fn ||
      typeof fn !== 'object' ||
      typeof fn.name !== 'string' ||
      fn.name.length === 0 ||
      typeof fn.arguments !== 'string'
    ) {
      throw new Error(
        `LLM response tool_calls[${index}] is not a function call with string arguments (model=${model})`,
      )
    }
    return { id: record.id, name: fn.name, argumentsJson: fn.arguments }
  })
}
