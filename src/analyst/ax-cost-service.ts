import type { AxAIService, AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import type { CostLedgerHandle, CostReceiptInput, MaximumCharge } from '../cost-ledger'
import type { AnalystUsageReceipt } from './types'

interface MeterAxChatServiceOptions {
  ledger: CostLedgerHandle
  actor: string
  /** Hard output limit applied to every Ax chat call. */
  maxOutputTokens: number
  /** Model configured on the Ax service when requests omit an override. */
  defaultModel?: string
  phase?: string
  tags?: Record<string, string>
  signal?: AbortSignal
}

interface AxChatCallOptions {
  abortSignal?: AbortSignal
  stream?: boolean
  retry?: { maxRetries?: number; [key: string]: unknown }
  [key: string]: unknown
}

interface AxChatService {
  chat(
    request: Readonly<AxChatRequest>,
    options?: Readonly<AxChatCallOptions>,
  ): Promise<AxChatResponse | ReadableStream<AxChatResponse>>
}

/**
 * Meter every chat call an Ax program makes through the shared paid-call ledger.
 * The wrapper disables provider streaming because a stream has no complete usage
 * receipt until it is consumed, while Ax's analyst output is not streamed to users.
 */
export function meterAxChatService(
  ai: AxAIService,
  options: MeterAxChatServiceOptions,
): AxAIService & AxChatService {
  assertPositiveInteger(options.maxOutputTokens, 'maxOutputTokens')
  const source = ai as AxAIService & Partial<AxChatService>
  if (typeof source.chat !== 'function') {
    throw new TypeError('meterAxChatService: Ax service must implement chat()')
  }
  const providerChat = source.chat.bind(ai)

  const chat: AxChatService['chat'] = async (request, callOptions = {}) => {
    const boundedRequest = boundOutputTokens(request, options.maxOutputTokens)
    const model = modelName(boundedRequest.model) || options.defaultModel || ''
    const signal = combineSignals(options.signal, callOptions.abortSignal)
    const paid = await options.ledger.runPaidCall<AxChatResponse>({
      channel: 'analyst',
      phase: options.phase ?? 'analyst.ax.chat',
      actor: options.actor,
      model,
      tags: options.tags,
      signal,
      maximumCharge: maximumChargeForAxChatRequest(boundedRequest, model),
      execute: async (executionSignal) => {
        const response = await providerChat(boundedRequest, {
          ...callOptions,
          abortSignal: executionSignal,
          retry: { ...callOptions.retry, maxRetries: 0 },
          stream: false,
        })
        if (response instanceof ReadableStream) {
          throw new Error('meterAxChatService: provider returned a stream after stream:false')
        }
        return response
      },
      receipt: (response) => costReceiptFromAxResponse(response, model),
    })
    if (!paid.succeeded) throw paid.error
    return paid.value
  }

  return new Proxy(ai as AxAIService & AxChatService, {
    get(target, property) {
      if (property === 'chat') return chat
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Conservative priced bound for one Ax text chat request. */
export function maximumChargeForAxChatRequest(
  request: Readonly<AxChatRequest<unknown>>,
  defaultModel?: string,
): MaximumCharge | undefined {
  const model = modelName(request.model) || defaultModel || ''
  const maxTokens = request.modelConfig?.maxTokens
  if (!model || maxTokens === undefined) return undefined
  assertPositiveInteger(maxTokens, 'request.modelConfig.maxTokens')
  if (containsUnboundedOrCacheableContent(request)) return undefined
  let inputTokens: number
  try {
    const pricedRequest = request.model === undefined ? { ...request, model } : request
    inputTokens = new TextEncoder().encode(JSON.stringify(pricedRequest)).byteLength
  } catch {
    return undefined
  }
  return { model, inputTokens, outputTokens: maxTokens }
}

/** Convert the ledger's complete call set into one analyst receipt. */
export function analystUsageFromCostLedger(ledger: CostLedgerHandle): AnalystUsageReceipt {
  const summary = ledger.summary({ channel: 'analyst' })
  const receipts = ledger.list({ channel: 'analyst' })
  const cost = !summary.accountingComplete
    ? { kind: 'uncaptured' as const, usd: null }
    : receipts.every((receipt) => receipt.actualCostUsd !== undefined)
      ? { kind: 'observed' as const, usd: summary.totalCostUsd }
      : { kind: 'estimated' as const, usd: summary.totalCostUsd }
  return {
    calls: summary.totalCalls,
    tokens: summary.usageComplete
      ? {
          input: summary.inputTokens,
          output: summary.outputTokens,
          ...(summary.cachedTokens > 0 ? { cached: summary.cachedTokens } : {}),
        }
      : null,
    cost,
    ...(cost.kind === 'uncaptured' ? { knownCostUsd: summary.totalCostUsd } : {}),
  }
}

function boundOutputTokens<TModel>(
  request: Readonly<AxChatRequest<TModel>>,
  limit: number,
): AxChatRequest<TModel> {
  const requested = request.modelConfig?.maxTokens
  const maxTokens = requested === undefined ? limit : Math.min(requested, limit)
  return {
    ...request,
    modelConfig: { ...request.modelConfig, maxTokens },
  }
}

function costReceiptFromAxResponse(
  response: AxChatResponse,
  fallbackModel: string,
): CostReceiptInput {
  const usage = response.modelUsage
  const tokens = usage?.tokens
  const model = usage?.model || fallbackModel
  if (
    !tokens ||
    !validUsage(tokens.promptTokens) ||
    !validUsage(tokens.completionTokens) ||
    !validUsage(tokens.totalTokens)
  ) {
    return {
      model,
      inputTokens: 0,
      outputTokens: 0,
      usageUnknown: true,
    }
  }
  const cacheReadTokens = validUsage(tokens.cacheReadTokens) ? tokens.cacheReadTokens : 0
  const cacheCreationTokens = validUsage(tokens.cacheCreationTokens)
    ? tokens.cacheCreationTokens
    : 0
  const cachedTokens = cacheReadTokens + cacheCreationTokens
  const reasoningTokens = Math.max(
    validUsage(tokens.reasoningTokens) ? tokens.reasoningTokens : 0,
    validUsage(tokens.thoughtsTokens) ? tokens.thoughtsTokens : 0,
  )
  const extraTokens = Math.max(
    0,
    tokens.totalTokens - tokens.promptTokens - tokens.completionTokens,
  )
  const extraReasoningTokens = Math.min(reasoningTokens, extraTokens)
  const extraCacheTokens = Math.min(cachedTokens, extraTokens - extraReasoningTokens)
  const cacheTokensIncludedInPrompt = cachedTokens - extraCacheTokens
  const unclassifiedExtraTokens = extraTokens - extraReasoningTokens - extraCacheTokens
  return {
    model,
    inputTokens: Math.max(0, tokens.promptTokens - cacheTokensIncludedInPrompt),
    outputTokens: tokens.completionTokens + extraReasoningTokens + unclassifiedExtraTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
  }
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) return second
  if (!second || first === second) return first
  return AbortSignal.any([first, second])
}

function containsUnboundedOrCacheableContent(request: Readonly<AxChatRequest<unknown>>): boolean {
  if (request.functions?.some((fn) => fn.cache === true)) return true
  return request.chatPrompt.some((message) => {
    if (message.cache === true) return true
    return (
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === 'url' || (part.type === 'file' && 'fileUri' in part),
      )
    )
  })
}

function modelName(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function validUsage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`meterAxChatService: ${field} must be a positive integer`)
  }
}
