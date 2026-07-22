import type { AxAIService, AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import type { CostLedgerHandle, CostReceiptInput, MaximumCharge } from '../cost-ledger'

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
  showThoughts?: boolean
  thinkingTokenBudget?: 'minimal' | 'low' | 'medium' | 'high' | 'highest' | 'none'
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
    const canTurnOffThinking = canDisableThinking(ai, model)
    const combined = combineSignals(options.signal, callOptions.abortSignal)
    try {
      const paid = await options.ledger.runPaidCall<AxChatResponse>({
        channel: 'analyst',
        phase: options.phase ?? 'analyst.ax.chat',
        actor: options.actor,
        model,
        tags: options.tags,
        signal: combined.signal,
        maximumCharge: maximumChargeForAxChatRequest(boundedRequest, model),
        execute: async (executionSignal) => {
          const providerOptions: AxChatCallOptions = {
            ...callOptions,
            abortSignal: executionSignal,
            retry: { ...callOptions.retry, maxRetries: 0 },
            stream: false,
            showThoughts: false,
          }
          if (canTurnOffThinking) providerOptions.thinkingTokenBudget = 'none'
          else Reflect.deleteProperty(providerOptions, 'thinkingTokenBudget')
          const response = await providerChat(boundedRequest, providerOptions)
          if (response instanceof ReadableStream) {
            throw new Error('meterAxChatService: provider returned a stream after stream:false')
          }
          return response
        },
        receipt: (response) => costReceiptFromAxResponse(response, model),
      })
      if (!paid.succeeded) throw paid.error
      return paid.value
    } finally {
      combined.dispose()
    }
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
  const completions = request.modelConfig?.n
  if (!model || maxTokens === undefined || completions === undefined) return undefined
  assertPositiveInteger(maxTokens, 'request.modelConfig.maxTokens')
  assertPositiveInteger(completions, 'request.modelConfig.n')
  const maximumOutputTokens = maxTokens * completions
  assertPositiveInteger(maximumOutputTokens, 'maximum output tokens')
  if (containsUnboundedOrCacheableContent(request)) return undefined
  let inputTokens: number
  try {
    const pricedRequest = request.model === undefined ? { ...request, model } : request
    inputTokens = new TextEncoder().encode(JSON.stringify(pricedRequest)).byteLength * completions
  } catch {
    return undefined
  }
  assertPositiveInteger(inputTokens, 'maximum input tokens')
  return { model, inputTokens, outputTokens: maximumOutputTokens }
}

function boundOutputTokens<TModel>(
  request: Readonly<AxChatRequest<TModel>>,
  limit: number,
): AxChatRequest<TModel> {
  const requested = request.modelConfig?.maxTokens
  if (requested !== undefined) {
    assertPositiveInteger(requested, 'request.modelConfig.maxTokens')
  }
  const completions = request.modelConfig?.n ?? 1
  assertPositiveInteger(completions, 'request.modelConfig.n')
  const maxTokens = requested === undefined ? limit : Math.min(requested, limit)
  return {
    ...request,
    modelConfig: { ...request.modelConfig, maxTokens, n: completions },
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
    !validUsage(tokens.totalTokens) ||
    tokens.totalTokens < tokens.promptTokens + tokens.completionTokens ||
    !validOptionalUsage(tokens.cacheReadTokens) ||
    !validOptionalUsage(tokens.cacheCreationTokens) ||
    !validOptionalUsage(tokens.reasoningTokens) ||
    !validOptionalUsage(tokens.thoughtsTokens)
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
  const totalCacheTokens = cacheReadTokens + cacheCreationTokens
  const thoughtsTokens = validUsage(tokens.thoughtsTokens) ? tokens.thoughtsTokens : 0
  const reasoningTokens = Math.max(
    validUsage(tokens.reasoningTokens) ? tokens.reasoningTokens : 0,
    thoughtsTokens,
  )
  // OpenAI includes reasoning in completionTokens, while other Ax providers may
  // report hidden output separately. Only add reasoning when it cannot be a
  // subset of completionTokens; thoughts are always separately billed output.
  const separateReasoningTokens = reasoningTokens > tokens.completionTokens ? reasoningTokens : 0
  const additionalOutputTokens = Math.max(thoughtsTokens, separateReasoningTokens)
  const outputTokens = tokens.completionTokens + additionalOutputTokens
  const directTotal = tokens.promptTokens + tokens.completionTokens
  const validTotals = new Set([
    directTotal,
    directTotal + totalCacheTokens,
    directTotal + additionalOutputTokens,
    directTotal + totalCacheTokens + additionalOutputTokens,
  ])
  if (!validTotals.has(tokens.totalTokens)) {
    return {
      model,
      inputTokens: 0,
      outputTokens: 0,
      usageUnknown: true,
    }
  }
  return {
    model,
    inputTokens: tokens.promptTokens,
    outputTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cacheReadTokens > 0 ? { cachedTokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cacheWriteTokens: cacheCreationTokens } : {}),
  }
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): { signal: AbortSignal | undefined; dispose(): void } {
  if (!first) return { signal: second, dispose: () => {} }
  if (!second || first === second) return { signal: first, dispose: () => {} }
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([first, second]), dispose: () => {} }
  }

  const controller = new AbortController()
  const dispose = (): void => {
    first.removeEventListener('abort', abortFromFirst)
    second.removeEventListener('abort', abortFromSecond)
  }
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason)
    dispose()
  }
  const abortFromFirst = (): void => abortFrom(first)
  const abortFromSecond = (): void => abortFrom(second)
  if (first.aborted) abortFrom(first)
  else if (second.aborted) abortFrom(second)
  else {
    first.addEventListener('abort', abortFromFirst, { once: true })
    second.addEventListener('abort', abortFromSecond, { once: true })
  }
  return { signal: controller.signal, dispose }
}

function containsUnboundedOrCacheableContent(request: Readonly<AxChatRequest<unknown>>): boolean {
  if (request.functions?.some((fn) => fn.cache === true)) return true
  return request.chatPrompt.some((message) => {
    if (message.cache === true) return true
    if (!('content' in message) || !Array.isArray(message.content)) return false
    return message.content.some((part) => part.cache === true || part.type !== 'text')
  })
}

function modelName(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function canDisableThinking(ai: AxAIService, model: string): boolean {
  // Ax maps "none" to a Gemini 3 thinking level, which cannot coexist with maxTokens.
  const namedAi = ai as { getName?: () => string }
  const serviceName = typeof namedAi.getName === 'function' ? namedAi.getName() : ''
  const modelId = model.slice(model.lastIndexOf('/') + 1)
  return serviceName !== 'GoogleGeminiAI' || !/^gemini-3(?:[.-]|$)/i.test(modelId)
}

function validUsage(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validOptionalUsage(value: unknown): boolean {
  return value === undefined || validUsage(value)
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`meterAxChatService: ${field} must be a positive integer`)
  }
}
