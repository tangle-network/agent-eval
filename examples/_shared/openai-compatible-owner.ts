/**
 * Caller-owned execution for the metered optimizer-model path.
 *
 * Agent Eval never executes a paid model. Its loopback proxy owns admission,
 * budgets, identity checks, response bounds, and cost-ledger recording, then
 * hands the exact admitted request to the package that owns execution. A
 * product built on agent-runtime supplies `profileOptimizerModelCall`, which
 * runs one exact `AgentProfile` and reports profile-digest evidence.
 *
 * This file is the minimal transport for a caller who has only an
 * OpenAI-compatible `/chat/completions` endpoint. It is example code on
 * purpose: the credential lives with the caller, not inside the package.
 * Copy it into your own project and replace the transport with whatever
 * client you already use. It exposes the same endpoint two ways — as the
 * `ChatClient` every Agent Eval judge and worker takes, and as the
 * `ExternalOptimizerModelCall` the optimizer surface takes.
 */

import type { ChatClient, ChatRequest, ChatResponse } from '../../src/analyst/chat-client'
import type {
  ExternalOptimizerChatRequest,
  ExternalOptimizerModelCall,
  ExternalOptimizerModelCallResult,
} from '../../src/campaign'
import type { CostReceiptInput, CustomTokenPricing } from '../../src/cost-ledger'
import { costForTokenPricing } from '../../src/cost-ledger'

export interface OpenAiCompatibleOwnerOptions {
  /** OpenAI-compatible base URL, ending at the `/v1` prefix. Always explicit. */
  baseUrl: string
  /** Bearer credential. It stays in this process and never reaches the optimizer child. */
  apiKey: string
  /** Model id recorded on a failure receipt when no provider response exists. */
  model: string
  /** Exact endpoint rates, used when the provider omits a billed amount. */
  pricing?: CustomTokenPricing
  /** Per-request deadline in milliseconds. Default 300,000. */
  timeoutMs?: number
  /** Total provider attempts per admitted call. Default 2. */
  maximumAttempts?: number
  /** Transport override for offline tests. */
  fetch?: typeof fetch
}

interface WireUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
  prompt_tokens_details?: { cached_tokens?: unknown }
  completion_tokens_details?: { reasoning_tokens?: unknown }
}

interface WireResponse {
  model?: unknown
  usage?: WireUsage
  _response_cost?: unknown
  cost_usd?: unknown
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: unknown }
    finish_reason?: string | null
  }>
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpStatusError'
  }
}

/** Retry a rate limit, a server fault, and a bare network failure. Any other
 *  answer is the provider's real answer and must not be paid for twice. */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500
  return error instanceof Error && error.name !== 'AbortError'
}

/**
 * The same endpoint as the `ChatClient` every judge, worker, and driver takes.
 *
 * `maximumAttempts` is declared so a capped cost account can price the worst
 * case before dispatching, which is what Agent Eval requires of an opaque
 * transport.
 */
export function openAiCompatibleChatClient(
  options: OpenAiCompatibleOwnerOptions & { defaultModel?: string },
): ChatClient {
  const post = endpoint(options)
  const defaultModel = options.defaultModel ?? options.model
  return {
    transport: 'custom',
    defaultModel,
    maximumAttempts: options.maximumAttempts ?? 2,
    chat: async (request, callOpts) =>
      post(
        { ...request, model: request.model ?? defaultModel },
        callOpts?.signal,
        callOpts?.idempotencyKey,
      ),
  }
}

/**
 * Build the `ExternalOptimizerModelCall` Agent Eval's optimizer surface takes.
 *
 * The callback resolves with one success or failure result and never rejects:
 * a rejection loses the execution record, which fails the optimizer attempt.
 */
export function openAiCompatibleExecutionOwner(
  options: OpenAiCompatibleOwnerOptions,
): ExternalOptimizerModelCall {
  const post = endpoint(options)
  return async ({ callId, request, signal }): Promise<ExternalOptimizerModelCallResult> => {
    try {
      const response = await post(request, signal, callId)
      return {
        succeeded: true,
        response,
        receipt: receiptFor(response, options.pricing),
        execution: {
          owner: 'openai-compatible',
          endpoint: options.baseUrl,
          model: response.model,
          callId,
          durationMs: response.durationMs,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        succeeded: false,
        error: message,
        // No provider response arrived, so usage and cost stay UNKNOWN. A
        // guessed zero would read downstream as a free call.
        receipt: {
          model: options.model,
          inputTokens: 0,
          outputTokens: 0,
          usageUnknown: true,
          costUnknown: true,
        },
        execution: {
          owner: 'openai-compatible',
          endpoint: options.baseUrl,
          model: options.model,
          callId,
          failed: true,
          error: message,
        },
      }
    }
  }
}

/**
 * One admitted request against the endpoint, retried only on a rate limit, a
 * server fault, or a bare network failure. A caller cancel is final: retrying a
 * cancelled intent spends money the caller already refused.
 */
function endpoint(
  options: OpenAiCompatibleOwnerOptions,
): (
  request: ChatRequest | ExternalOptimizerChatRequest,
  signal: AbortSignal | undefined,
  idempotencyKey: string | undefined,
) => Promise<ChatResponse> {
  for (const field of ['baseUrl', 'apiKey', 'model'] as const) {
    const value = options[field]
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
      throw new Error(
        `openAiCompatibleExecutionOwner: ${field} must be a trimmed, non-empty string`,
      )
    }
  }
  const timeoutMs = options.timeoutMs ?? 300_000
  const maximumAttempts = options.maximumAttempts ?? 2
  const transport = options.fetch ?? fetch
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`

  return async (request, signal, idempotencyKey) => {
    const startedAt = Date.now()
    let lastError: unknown = new Error('no attempt was made')
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), timeoutMs)
      try {
        const res = await transport(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            // Stable per-call id, reused across attempts so the provider can
            // deduplicate a redriven paid call.
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
          body: JSON.stringify(wireBody(request)),
          signal: signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal,
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new HttpStatusError(res.status, `${res.status} ${text.slice(0, 400)}`)
        }
        return canonicalResponse(
          (await res.json()) as WireResponse,
          request.model ?? options.model,
          Date.now() - startedAt,
          options.pricing,
        )
      } catch (error) {
        lastError = error
        if (signal?.aborted) break
        if (attempt + 1 >= maximumAttempts || !isRetryable(error)) break
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

function wireBody(request: ChatRequest | ExternalOptimizerChatRequest): Record<string, unknown> {
  if (!request.model) throw new Error('openAiCompatibleExecutionOwner: request.model is required')
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) =>
      message.role === 'tool'
        ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
        : message.toolCalls === undefined
          ? { role: message.role, content: message.content }
          : {
              role: message.role,
              content: message.content,
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            },
    ),
    temperature: request.temperature ?? 0,
  }
  if (request.maxTokens != null) body.max_tokens = request.maxTokens
  if (request.tools !== undefined) body.tools = request.tools
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice
  if (request.thinking !== undefined) body.thinking = { type: request.thinking }
  if (request.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: request.jsonSchema.name,
        schema: request.jsonSchema.schema,
        strict: true,
      },
    }
  } else if (request.jsonMode) {
    body.response_format = { type: 'json_object' }
  }
  return body
}

function canonicalResponse(
  body: WireResponse,
  requestedModel: string,
  durationMs: number,
  pricing: CustomTokenPricing | undefined,
): ChatResponse {
  const choice = body.choices?.[0]
  const content = choice?.message?.content ?? ''
  const promptTokens = tokenCount(body.usage?.prompt_tokens)
  const completionTokens = tokenCount(body.usage?.completion_tokens)
  const totalTokens = tokenCount(body.usage?.total_tokens)
  const cachedPromptTokens = tokenCount(body.usage?.prompt_tokens_details?.cached_tokens)
  const reasoningTokens = tokenCount(body.usage?.completion_tokens_details?.reasoning_tokens)
  const captured = promptTokens !== undefined && completionTokens !== undefined
  const billedCostUsd = finiteCost(body._response_cost ?? body.cost_usd)
  // The echoed id, kept apart from the attribution id: a provider that omits
  // it reads as unproven, never as "the model I asked for".
  const servedModel = typeof body.model === 'string' && body.model.trim() !== '' ? body.model : null
  const estimated =
    billedCostUsd === undefined && captured && pricing
      ? costForTokenPricing(pricing, {
          inputTokens: (promptTokens ?? 0) - (cachedPromptTokens ?? 0),
          ...(cachedPromptTokens ? { cachedTokens: cachedPromptTokens } : {}),
          outputTokens: completionTokens ?? 0,
        })
      : undefined
  return {
    content,
    ...(parseToolCalls(choice?.message?.tool_calls) ?? {}),
    // 'tool_calls' is the OpenAI wire echo for a tool-calling stop; the
    // canonical contract names the same stop cause 'tool_use'.
    finishReason:
      choice?.finish_reason === 'tool_calls' ? 'tool_use' : (choice?.finish_reason ?? null),
    contentEmpty: content.trim().length === 0,
    usage: {
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
      captured,
      reasoningTokens,
      cachedPromptTokens,
    },
    costUsd: billedCostUsd ?? estimated ?? null,
    model: servedModel ?? requestedModel,
    servedModel,
    durationMs,
    raw: body as unknown as Record<string, unknown>,
  }
}

function receiptFor(
  response: ChatResponse,
  pricing: CustomTokenPricing | undefined,
): CostReceiptInput {
  const cachedTokens = response.usage.cachedPromptTokens ?? 0
  const raw = response.raw as WireResponse
  const billedCostUsd = finiteCost(raw._response_cost ?? raw.cost_usd)
  return {
    model: response.model,
    inputTokens: Math.max(0, response.usage.promptTokens - cachedTokens),
    outputTokens: response.usage.completionTokens,
    ...(response.usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: response.usage.reasoningTokens }),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(billedCostUsd !== undefined
      ? { actualCostUsd: billedCostUsd }
      : pricing && response.usage.captured !== false
        ? { customTokenPricing: pricing }
        : response.costUsd === null
          ? { costUnknown: true }
          : { estimatedCostUsd: response.costUsd }),
    usageUnknown: response.usage.captured === false,
  }
}

function parseToolCalls(value: unknown): { toolCalls: ChatResponse['toolCalls'] } | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return {
    toolCalls: value.map((entry, index) => {
      const record = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
      const fn = record?.function
      if (
        typeof record?.id !== 'string' ||
        typeof fn?.name !== 'string' ||
        typeof fn?.arguments !== 'string'
      ) {
        throw new Error(`tool_calls[${index}] is not a function call with string arguments`)
      }
      return { id: record.id, name: fn.name, argumentsJson: fn.arguments }
    }),
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finiteCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
