import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { ChatResponse } from '../analyst/chat-client'
import type {
  CostChannel,
  CostLedgerHandle,
  CostReceiptInput,
  CustomTokenPricing,
} from '../cost-ledger'
import { costForTokenPricing } from '../cost-ledger'
import {
  assertServedModel,
  assertServedModelPolicy,
  ModelSubstitutionError,
  type ServedModelPolicy,
} from '../integrity/served-model'
import { canonicalJson } from '../verdict-cache'
import {
  assertExternalOptimizerModelBudget,
  assertJsonValue,
  type ExternalOptimizerChatRequest,
  type ExternalOptimizerEndpointFormat,
  type ExternalOptimizerModelBudget,
  type ExternalOptimizerModelCall,
  type ExternalOptimizerModelExecutionObservation,
  type ExternalOptimizerModelProxy,
  isRecord,
} from './external-optimizer-contracts'
import { closeServer, listenLocal, sendJson } from './external-optimizer-http'

const MODEL_PROXY_PATHS = new Set(['/v1/chat/completions', '/v1/responses'])
type ModelProxyPath = '/v1/chat/completions' | '/v1/responses'

type UnsequencedExecutionObservation = ExternalOptimizerModelExecutionObservation extends infer T
  ? T extends ExternalOptimizerModelExecutionObservation
    ? Omit<T, 'sequence'>
    : never
  : never

interface ProviderProxyResponse {
  status: number
  contentType: string
  body: Uint8Array
  receipt: CostReceiptInput
  usageComplete: boolean
  /** A Runtime-owned call failed after returning complete execution evidence. */
  modelCallFailed?: string
  /** Set when the response violated the output or reasoning limit; forces a 502. */
  usageRejected?: string
}

type ExternalOptimizerModelProxyArgs = {
  call: ExternalOptimizerModelCall
  callRef: string
  recordExecution: (observation: ExternalOptimizerModelExecutionObservation) => void
  model: string
  budget: ExternalOptimizerModelBudget
  /** Served-model acceptance for every proxied call. Default `'exact'`. */
  servedModelPolicy?: ServedModelPolicy
  costLedger: CostLedgerHandle
  phase: string
  actor: string
  /** Cost-ledger channel. Defaults to `optimizer`. */
  channel?: CostChannel
  tags?: Record<string, string>
  /** Deterministic ledger identity for a single-request proxy. */
  callId?: string
  initialUsage?: {
    requests: number
    /** Known billed subtotal. Omit when prior billed USD is unknown. */
    costUsd?: number
  }
  signal?: AbortSignal
}

/**
 * Put an OpenAI-compatible optimizer behind the shared cost ledger.
 *
 * The child process receives only a loopback URL and an ephemeral token. The
 * package that owns execution receives a validated immutable request through
 * `call`; Eval receives no provider credential. Every request reserves its
 * conservative byte-count input bound plus the declared output cap before the
 * owner is invoked exactly once.
 */
export async function startExternalOptimizerModelProxy(
  args: ExternalOptimizerModelProxyArgs,
): Promise<ExternalOptimizerModelProxy> {
  assertModelProxyConfig(args)
  args.signal?.throwIfAborted()
  const token = randomLocalToken()
  let requestCount = 0
  let successfulCompletionCount = 0
  let modelCallInvocations = 0
  let executionRecordCount = 0
  let executionSequence = 0
  const failures: Error[] = []
  let totalRequestCount = args.initialUsage?.requests ?? 0
  let committedForBudget = args.initialUsage?.costUsd ?? 0
  let reservedForBudget = 0
  let accepting = true
  let closePromise: Promise<void> | undefined
  const activeControllers = new Set<AbortController>()
  const activeHandlers = new Set<Promise<void>>()

  const server = createServer((request, response) => {
    if (!accepting) {
      sendJsonIfOpen(response, 503, { error: 'external optimizer model proxy is closing' })
      return
    }

    const controller = new AbortController()
    const abortRequest = (): void => {
      request.destroy()
      response.destroy()
    }
    activeControllers.add(controller)
    controller.signal.addEventListener('abort', abortRequest, { once: true })

    let handler!: Promise<void>
    handler = handleModelProxyRequest({
      request,
      response,
      controller,
      token,
      args,
      nextReservation: (maximumCostUsd) => {
        if (totalRequestCount >= args.budget.maxRequests) {
          return { accepted: false as const, reason: 'optimizer model request limit reached' }
        }
        if (
          args.budget.maxCostUsd !== undefined &&
          maximumCostUsd !== undefined &&
          committedForBudget + reservedForBudget + maximumCostUsd >
            args.budget.maxCostUsd + Number.EPSILON
        ) {
          return { accepted: false as const, reason: 'optimizer model cost limit reached' }
        }
        requestCount += 1
        totalRequestCount += 1
        reservedForBudget += maximumCostUsd ?? 0
        return { accepted: true as const }
      },
      settleReservation: (maximumCostUsd, chargedCostUsd) => {
        reservedForBudget = Math.max(0, reservedForBudget - (maximumCostUsd ?? 0))
        committedForBudget += chargedCostUsd ?? 0
      },
      recordSuccessfulCompletion: () => {
        successfulCompletionCount += 1
      },
      recordExecutionReceipt: (observation) => {
        try {
          args.recordExecution({ ...observation, sequence: executionSequence + 1 })
        } catch (error) {
          throw new ModelExecutionPersistenceError(
            `optimizer model execution evidence was not persisted: ${toErrorMessage(error)}`,
          )
        }
        executionSequence += 1
        executionRecordCount += 1
      },
      recordModelCallInvocation: () => {
        modelCallInvocations += 1
      },
      recordFailure: (error) => {
        failures.push(error)
      },
    }).finally(() => {
      controller.signal.removeEventListener('abort', abortRequest)
      activeControllers.delete(controller)
      activeHandlers.delete(handler)
    })
    activeHandlers.add(handler)
    void handler.catch(() => undefined)
  })
  const port = await listenLocal(server)
  const close = (): Promise<void> => {
    closePromise ??= closeModelProxy()
    return closePromise
  }
  const onAbort = (): void => {
    for (const controller of activeControllers) controller.abort(args.signal?.reason)
    void close().catch(() => undefined)
  }
  args.signal?.addEventListener('abort', onAbort, { once: true })
  if (args.signal?.aborted) onAbort()
  const assertExecutionComplete = (): void => {
    if (executionRecordCount !== modelCallInvocations) {
      throw new Error(
        `external optimizer model callback returned ${executionRecordCount} execution records for ${modelCallInvocations} invoked calls`,
      )
    }
  }
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: token,
    requestAttempts: () => requestCount,
    successfulCompletions: () => successfulCompletionCount,
    assertExecutionComplete,
    failures: () => [...failures],
    close,
  }

  async function closeModelProxy(): Promise<void> {
    args.signal?.removeEventListener('abort', onAbort)
    accepting = false
    const closingServer = closeServer(server)
    server.closeIdleConnections?.()
    const [serverResult] = await Promise.allSettled([
      closingServer,
      waitForActiveHandlers(activeHandlers),
    ])
    if (activeControllers.size !== 0 || activeHandlers.size !== 0) {
      throw new Error('external optimizer model proxy closed with active request work')
    }
    let executionError: unknown
    try {
      assertExecutionComplete()
    } catch (error) {
      executionError = error
    }
    if (serverResult?.status === 'rejected' && executionError !== undefined) {
      throw new AggregateError(
        [serverResult.reason, executionError],
        'external optimizer model proxy close and execution evidence both failed',
      )
    }
    if (serverResult?.status === 'rejected') throw serverResult.reason
    if (executionError !== undefined) throw executionError
  }
}

async function handleModelProxyRequest(args: {
  request: IncomingMessage
  response: ServerResponse
  controller: AbortController
  token: string
  args: {
    call: ExternalOptimizerModelCall
    callRef: string
    recordExecution: (observation: ExternalOptimizerModelExecutionObservation) => void
    model: string
    budget: ExternalOptimizerModelBudget
    servedModelPolicy?: ServedModelPolicy
    costLedger: CostLedgerHandle
    phase: string
    actor: string
    channel?: CostChannel
    tags?: Record<string, string>
    callId?: string
  }
  nextReservation: (maximumCostUsd: number | undefined) =>
    | { accepted: true }
    | {
        accepted: false
        reason: 'optimizer model request limit reached' | 'optimizer model cost limit reached'
      }
  settleReservation: (
    maximumCostUsd: number | undefined,
    chargedCostUsd: number | undefined,
  ) => void
  recordSuccessfulCompletion: () => void
  recordExecutionReceipt: (observation: UnsequencedExecutionObservation) => void
  recordModelCallInvocation: () => void
  recordFailure: (error: Error) => void
}): Promise<void> {
  const { controller, request, response } = args
  try {
    const path = request.url ? new URL(request.url, 'http://127.0.0.1').pathname : ''
    if (request.method !== 'POST' || !MODEL_PROXY_PATHS.has(path)) {
      sendJsonIfOpen(response, 404, { error: 'not found' })
      return
    }
    const modelPath = path as ModelProxyPath
    if (request.headers.authorization !== `Bearer ${args.token}`) {
      sendJsonIfOpen(response, 401, { error: 'unauthorized' })
      return
    }

    const body = await readBody(request, args.args.budget.maxRequestBytes)
    const parsed = parseModelProxyRequest(body, modelPath, args.args.model, args.args.budget)
    const maximumUsage = conservativeMaximumUsage(
      body.byteLength,
      parsed.maxOutputTokens + (args.args.budget.maxReasoningTokensPerRequest ?? 0),
      args.args.budget.pricing,
    )
    const maximumCostUsd = args.args.budget.pricing
      ? costForTokenPricing(args.args.budget.pricing, maximumUsage)
      : undefined
    const reservation = args.nextReservation(maximumCostUsd)
    if (!reservation.accepted) {
      sendJsonIfOpen(response, 429, { error: reservation.reason })
      return
    }

    const timeout = setTimeout(
      () => controller.abort(),
      args.args.budget.requestTimeoutMs ?? 300_000,
    )
    let chargedForBudget = maximumCostUsd
    try {
      const paid = await args.args.costLedger.runPaidCall<ProviderProxyResponse>({
        ...(args.args.callId ? { callId: args.args.callId } : {}),
        channel: args.args.channel ?? 'optimizer',
        phase: args.args.phase,
        actor: args.args.actor,
        ...(args.args.tags ? { tags: args.args.tags } : {}),
        model: args.args.model,
        ...(args.args.budget.pricing
          ? {
              maximumCharge: {
                customTokenPricing: args.args.budget.pricing,
                ...maximumUsage,
              },
            }
          : {}),
        signal: controller.signal,
        execute: async (paidCallSignal, paidCallId) =>
          forwardModelProxyRequest({
            call: args.args.call,
            callId: paidCallId,
            callRef: args.args.callRef,
            recordExecutionReceipt: args.recordExecutionReceipt,
            recordModelCallInvocation: args.recordModelCallInvocation,
            path: modelPath,
            request: parsed.request,
            model: args.args.model,
            allowWithinFamily: args.args.servedModelPolicy === 'allow-within-family',
            maxOutputTokens: parsed.maxOutputTokens,
            ...(args.args.budget.maxReasoningTokensPerRequest === undefined
              ? {}
              : { maxReasoningTokens: args.args.budget.maxReasoningTokensPerRequest }),
            maxResponseBytes: args.args.budget.maxResponseBytes,
            signal: paidCallSignal,
          }),
        receipt: (result) => result.receipt,
        receiptFromError: () => ({
          model: args.args.model,
          inputTokens: 0,
          outputTokens: 0,
          costUnknown: true,
          usageUnknown: true,
        }),
      })
      if (!paid.succeeded) {
        args.recordFailure(paid.error)
        chargedForBudget = paid.receipt
          ? paid.receipt.usageUnknown || paid.receipt.costUnknown
            ? maximumCostUsd
            : paid.receipt.costUsd
          : undefined
        sendJsonIfOpen(
          response,
          isAbortError(paid.error)
            ? 504
            : paid.error instanceof ProviderResponseTooLargeError ||
                paid.error instanceof MissingModelExecutionError ||
                paid.error instanceof ModelExecutionPersistenceError ||
                paid.error instanceof OwnerModelContractError ||
                paid.error instanceof ModelSubstitutionError
              ? 502
              : 429,
          { error: paid.error.message },
        )
        return
      }
      if (paid.value.modelCallFailed) {
        sendJsonIfOpen(response, 502, { error: paid.value.modelCallFailed })
        return
      }
      chargedForBudget = paid.value.usageComplete ? paid.receipt.costUsd : maximumCostUsd
      // A response that violated the output or reasoning limit is rejected. A
      // response the provider merely under-reported is forwarded with its cost
      // charged at the reservation maximum, so the analysis keeps its usable
      // completion and the ledger holds an honest upper-bound charge.
      if (paid.value.usageRejected) {
        sendJsonIfOpen(response, 502, { error: paid.value.usageRejected })
        return
      }
      if (paid.value.status >= 200 && paid.value.status < 300) {
        args.recordSuccessfulCompletion()
      }
      if (response.destroyed || response.writableEnded) return
      response.writeHead(paid.value.status, {
        'content-type': paid.value.contentType,
        'content-length': String(paid.value.body.byteLength),
      })
      response.end(paid.value.body)
    } finally {
      clearTimeout(timeout)
      args.settleReservation(maximumCostUsd, chargedForBudget)
    }
  } catch (error) {
    const status =
      error instanceof RequestBodyTooLargeError
        ? 413
        : error instanceof Error && isAbortError(error)
          ? 503
          : 400
    sendJsonIfOpen(response, status, { error: toErrorMessage(error) })
  }
}

async function waitForActiveHandlers(activeHandlers: Set<Promise<void>>): Promise<void> {
  while (activeHandlers.size > 0) {
    await Promise.allSettled([...activeHandlers])
  }
}

function sendJsonIfOpen(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  sendJson(response, status, body)
}

async function forwardModelProxyRequest(args: {
  call: ExternalOptimizerModelCall
  callId: string
  callRef: string
  recordExecutionReceipt: (observation: UnsequencedExecutionObservation) => void
  recordModelCallInvocation: () => void
  path: ModelProxyPath
  request: ExternalOptimizerChatRequest
  model: string
  /** True when the proxy's servedModelPolicy is 'allow-within-family'. */
  allowWithinFamily: boolean
  maxOutputTokens: number
  /** Enforced only when the caller declared a thinking budget. */
  maxReasoningTokens?: number
  maxResponseBytes: number
  signal: AbortSignal
}): Promise<ProviderProxyResponse> {
  args.recordModelCallInvocation()
  let called: Awaited<ReturnType<ExternalOptimizerModelCall>>
  try {
    called = await args.call({
      callId: args.callId,
      request: freezeJsonSnapshot(
        args.request,
        'optimizer model canonical request',
      ) as ExternalOptimizerChatRequest,
      endpointFormat: endpointFormat(args.path),
      signal: args.signal,
    })
  } catch (error) {
    throw new MissingModelExecutionError(
      `optimizer model callback rejected without execution evidence: ${toErrorMessage(error)}`,
    )
  }
  if (!called || typeof called !== 'object' || typeof called.succeeded !== 'boolean') {
    throw new MissingModelExecutionError(
      'optimizer model callback returned no typed success/failure outcome',
    )
  }
  let execution: unknown
  try {
    execution = freezeJsonSnapshot(called.execution, 'optimizer model callback execution evidence')
  } catch (error) {
    throw new MissingModelExecutionError(
      `optimizer model callback returned invalid execution evidence: ${toErrorMessage(error)}`,
    )
  }
  if (called.succeeded) {
    let authoritativeReceipt: CostReceiptInput
    let canonicalResponse: ChatResponse
    try {
      authoritativeReceipt = snapshotModelReceipt(
        called.receipt,
        args.model,
        args.allowWithinFamily,
      )
      canonicalResponse = snapshotChatResponse(called.response, args.model, args.allowWithinFamily)
      assertResponseUsageMatchesReceipt(canonicalResponse, authoritativeReceipt)
    } catch (error) {
      args.recordExecutionReceipt({
        callId: args.callId,
        callRef: args.callRef,
        path: args.path,
        model: args.model,
        succeeded: false,
        error: toErrorMessage(error),
        execution,
      })
      throw error
    }
    args.recordExecutionReceipt({
      callId: args.callId,
      callRef: args.callRef,
      path: args.path,
      model: args.model,
      succeeded: true,
      responseStatus: 200,
      execution,
    })
    // Output tokens include the reasoning subset. The child's requested
    // completion limit governs visible completion tokens, while the separately
    // declared reasoning budget governs thinking tokens.
    const usageKnown = canonicalResponse.usage.captured !== false
    const reasoningTokens = canonicalResponse.usage.reasoningTokens ?? 0
    const completionTokens = canonicalResponse.usage.completionTokens - reasoningTokens
    const usageRejected =
      usageKnown && completionTokens > args.maxOutputTokens
        ? `optimizer model execution reported ${completionTokens} completion tokens, exceeding requested limit ${args.maxOutputTokens}`
        : usageKnown &&
            args.maxReasoningTokens !== undefined &&
            reasoningTokens > args.maxReasoningTokens
          ? `optimizer model execution reported ${reasoningTokens} reasoning tokens, exceeding the declared budget ${args.maxReasoningTokens}`
          : undefined
    const responseBody = encodeCanonicalModelResponse({
      path: args.path,
      callId: args.callId,
      response: canonicalResponse,
      receipt: authoritativeReceipt,
      maxBytes: args.maxResponseBytes,
    })
    return {
      status: 200,
      contentType: 'application/json',
      body: responseBody,
      receipt: authoritativeReceipt,
      usageComplete: authoritativeReceipt.usageUnknown !== true,
      ...(usageRejected ? { usageRejected } : {}),
    }
  } else {
    if (typeof called.error !== 'string' || !called.error.trim()) {
      throw new MissingModelExecutionError(
        'optimizer model callback failure did not return a public error',
      )
    }
    args.recordExecutionReceipt({
      callId: args.callId,
      callRef: args.callRef,
      path: args.path,
      model: args.model,
      succeeded: false,
      error: called.error,
      execution,
    })
    const failedReceipt = snapshotModelReceipt(called.receipt, args.model, args.allowWithinFamily)
    return {
      status: 502,
      contentType: 'application/json',
      body: new TextEncoder().encode(JSON.stringify({ error: called.error })),
      receipt: failedReceipt,
      usageComplete: failedReceipt.usageUnknown !== true,
      modelCallFailed: called.error,
    }
  }
}

function snapshotModelReceipt(
  value: CostReceiptInput,
  expectedModel: string,
  allowWithinFamily: boolean,
): CostReceiptInput {
  let snapshot: CostReceiptInput
  try {
    assertJsonValue(value, 'optimizer model callback receipt')
    snapshot = JSON.parse(canonicalJson(value)) as CostReceiptInput
  } catch (error) {
    throw new OwnerModelContractError(
      `optimizer model callback returned an invalid receipt: ${toErrorMessage(error)}`,
    )
  }
  assertServedModel(expectedModel, snapshot.model, {
    context: 'optimizer model callback receipt',
    allowWithinFamily,
  })
  return snapshot
}

function freezeJsonSnapshot(value: unknown, label: string): unknown {
  assertJsonValue(value, label)
  return deepFreezeJson(JSON.parse(canonicalJson(value)))
}

function deepFreezeJson(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreezeJson(child)
    Object.freeze(value)
  }
  return value
}

function assertResponseUsageMatchesReceipt(
  response: ChatResponse,
  receipt: CostReceiptInput,
): void {
  if (response.model !== receipt.model) {
    throw new OwnerModelContractError(
      'optimizer model response and execution receipt disagree about the served model',
    )
  }
  if (response.usage.captured === false || receipt.usageUnknown === true) {
    if (response.usage.captured !== false || receipt.usageUnknown !== true) {
      throw new OwnerModelContractError(
        'optimizer model response and execution receipt disagree about whether usage was captured',
      )
    }
  } else {
    const cachedTokens = response.usage.cachedPromptTokens ?? 0
    if (receipt.inputTokens + (receipt.cachedTokens ?? 0) !== response.usage.promptTokens) {
      throw new OwnerModelContractError(
        'optimizer model response promptTokens must equal receipt inputTokens plus cachedTokens',
      )
    }
    if (cachedTokens !== (receipt.cachedTokens ?? 0)) {
      throw new OwnerModelContractError(
        'optimizer model response cachedPromptTokens disagrees with the execution receipt',
      )
    }
    if (response.usage.completionTokens !== receipt.outputTokens) {
      throw new OwnerModelContractError(
        'optimizer model response completionTokens disagrees with the execution receipt',
      )
    }
    if ((response.usage.reasoningTokens ?? 0) !== (receipt.reasoningTokens ?? 0)) {
      throw new OwnerModelContractError(
        'optimizer model response reasoningTokens disagrees with the execution receipt',
      )
    }
  }
  const receiptCostUsd =
    receipt.actualCostUsd ??
    receipt.estimatedCostUsd ??
    (receipt.customTokenPricing && receipt.usageUnknown !== true
      ? costForTokenPricing(receipt.customTokenPricing, receipt)
      : null)
  if (response.costUsd !== receiptCostUsd) {
    throw new OwnerModelContractError(
      'optimizer model response billed cost disagrees with the execution receipt',
    )
  }
}

function parseModelProxyRequest(
  body: Uint8Array,
  path: ModelProxyPath,
  expectedModel: string,
  budget: ExternalOptimizerModelBudget,
): { maxOutputTokens: number; request: ExternalOptimizerChatRequest } {
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

function snapshotChatResponse(
  value: unknown,
  expectedModel: string,
  allowWithinFamily: boolean,
): ChatResponse {
  if (!isRecord(value)) {
    throw new OwnerModelContractError('optimizer model callback response must be an object')
  }
  if (typeof value.content !== 'string') {
    throw new OwnerModelContractError('optimizer model callback response content must be a string')
  }
  assertServedModel(expectedModel, typeof value.model === 'string' ? value.model : null, {
    context: 'optimizer model callback response',
    allowWithinFamily,
  })
  if (!isNonnegativeFiniteNumber(value.durationMs)) {
    throw new OwnerModelContractError(
      'optimizer model callback response durationMs must be finite and non-negative',
    )
  }
  if (value.costUsd !== null && !isNonnegativeFiniteNumber(value.costUsd)) {
    throw new OwnerModelContractError(
      'optimizer model callback response costUsd must be null or finite and non-negative',
    )
  }
  if (
    value.finishReason !== undefined &&
    value.finishReason !== null &&
    typeof value.finishReason !== 'string'
  ) {
    throw new OwnerModelContractError(
      'optimizer model callback response finishReason must be a string or null',
    )
  }
  if (
    value.contentEmpty !== undefined &&
    (typeof value.contentEmpty !== 'boolean' ||
      value.contentEmpty !== (value.content.trim().length === 0))
  ) {
    throw new OwnerModelContractError(
      'optimizer model callback response contentEmpty must match content',
    )
  }
  if (!isRecord(value.raw)) {
    throw new OwnerModelContractError('optimizer model callback response raw must be an object')
  }
  if (!isRecord(value.usage)) {
    throw new OwnerModelContractError('optimizer model callback response usage must be an object')
  }
  const usage = value.usage
  for (const field of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
    if (!isNonnegativeSafeInteger(usage[field])) {
      throw new OwnerModelContractError(
        `optimizer model callback response usage.${field} must be a non-negative safe integer`,
      )
    }
  }
  const promptTokens = usage.promptTokens as number
  const completionTokens = usage.completionTokens as number
  const totalTokens = usage.totalTokens as number
  if (totalTokens !== promptTokens + completionTokens) {
    throw new OwnerModelContractError(
      'optimizer model callback response totalTokens must equal promptTokens plus completionTokens',
    )
  }
  if (usage.captured !== undefined && typeof usage.captured !== 'boolean') {
    throw new OwnerModelContractError(
      'optimizer model callback response usage.captured must be a boolean',
    )
  }
  if (
    usage.cachedPromptTokens !== undefined &&
    (!isNonnegativeSafeInteger(usage.cachedPromptTokens) || usage.cachedPromptTokens > promptTokens)
  ) {
    throw new OwnerModelContractError(
      'optimizer model callback response cachedPromptTokens must be a subset of promptTokens',
    )
  }
  if (
    usage.reasoningTokens !== undefined &&
    (!isNonnegativeSafeInteger(usage.reasoningTokens) || usage.reasoningTokens > completionTokens)
  ) {
    throw new OwnerModelContractError(
      'optimizer model callback response reasoningTokens must be a subset of completionTokens',
    )
  }
  let raw: Record<string, unknown>
  try {
    raw = freezeJsonSnapshot(
      value.raw,
      'optimizer model callback canonical response.raw',
    ) as Record<string, unknown>
  } catch (error) {
    throw new OwnerModelContractError(
      `optimizer model callback returned invalid raw response evidence: ${toErrorMessage(error)}`,
    )
  }
  return deepFreezeJson({
    content: value.content,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens,
      ...(usage.captured === undefined ? {} : { captured: usage.captured }),
      ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
      ...(usage.cachedPromptTokens === undefined
        ? {}
        : { cachedPromptTokens: usage.cachedPromptTokens }),
    },
    costUsd: value.costUsd,
    model: value.model,
    durationMs: value.durationMs,
    ...(value.finishReason === undefined ? {} : { finishReason: value.finishReason }),
    ...(value.contentEmpty === undefined ? {} : { contentEmpty: value.contentEmpty }),
    raw,
  }) as ChatResponse
}

function encodeCanonicalModelResponse(args: {
  path: ModelProxyPath
  callId: string
  response: ChatResponse
  receipt: CostReceiptInput
  maxBytes: number
}): Uint8Array {
  const usage = encodeProtocolUsage(args.path, args.response, args.receipt)
  const finishReason =
    args.response.finishReason === undefined ? 'stop' : args.response.finishReason
  const body =
    args.path === '/v1/chat/completions'
      ? {
          id: `chatcmpl-${args.callId}`,
          object: 'chat.completion',
          created: 0,
          model: args.response.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: args.response.content },
              finish_reason: finishReason,
            },
          ],
          ...(usage ? { usage } : {}),
        }
      : {
          id: `resp-${args.callId}`,
          object: 'response',
          created_at: 0,
          model: args.response.model,
          status: finishReason === 'length' ? 'incomplete' : 'completed',
          error: null,
          incomplete_details: finishReason === 'length' ? { reason: 'max_output_tokens' } : null,
          output: [
            {
              id: `msg-${args.callId}`,
              type: 'message',
              status: finishReason === 'length' ? 'incomplete' : 'completed',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: args.response.content,
                  annotations: [],
                },
              ],
            },
          ],
          output_text: args.response.content,
          ...(usage ? { usage } : {}),
        }
  const encoded = new TextEncoder().encode(JSON.stringify(body))
  if (encoded.byteLength > args.maxBytes) throw new ProviderResponseTooLargeError()
  return encoded
}

function endpointFormat(path: ModelProxyPath): ExternalOptimizerEndpointFormat {
  return path === '/v1/responses' ? 'responses' : 'chat-completions'
}

function encodeProtocolUsage(
  path: ModelProxyPath,
  response: ChatResponse,
  receipt: CostReceiptInput,
): Record<string, unknown> | undefined {
  if (response.usage.captured === false) return undefined
  const inputDetails = {
    ...(receipt.cachedTokens === undefined ? {} : { cached_tokens: receipt.cachedTokens }),
    ...(receipt.cacheWriteTokens === undefined
      ? {}
      : path === '/v1/chat/completions'
        ? { cache_creation_tokens: receipt.cacheWriteTokens }
        : { cache_write_tokens: receipt.cacheWriteTokens }),
  }
  const outputDetails = {
    ...(receipt.reasoningTokens === undefined ? {} : { reasoning_tokens: receipt.reasoningTokens }),
  }
  return path === '/v1/chat/completions'
    ? {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        total_tokens: response.usage.totalTokens,
        ...(Object.keys(inputDetails).length > 0 ? { prompt_tokens_details: inputDetails } : {}),
        ...(Object.keys(outputDetails).length > 0
          ? { completion_tokens_details: outputDetails }
          : {}),
        ...(receipt.actualCostUsd === undefined ? {} : { cost: receipt.actualCostUsd }),
      }
    : {
        input_tokens: response.usage.promptTokens,
        output_tokens: response.usage.completionTokens,
        total_tokens: response.usage.totalTokens,
        ...(Object.keys(inputDetails).length > 0 ? { input_tokens_details: inputDetails } : {}),
        ...(Object.keys(outputDetails).length > 0 ? { output_tokens_details: outputDetails } : {}),
        ...(receipt.actualCostUsd === undefined ? {} : { cost: receipt.actualCostUsd }),
      }
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function conservativeMaximumUsage(
  inputTokenUpperBound: number,
  outputTokenUpperBound: number,
  pricing?: CustomTokenPricing,
): Pick<CostReceiptInput, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens'> {
  if (pricing === undefined) {
    return { inputTokens: inputTokenUpperBound, outputTokens: outputTokenUpperBound }
  }
  const inputRates = [
    pricing.inputUsdPerMillion,
    pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion,
  ]
  const mostExpensiveInputClass = inputRates.indexOf(Math.max(...inputRates))
  return {
    inputTokens: mostExpensiveInputClass === 0 ? inputTokenUpperBound : 0,
    ...(mostExpensiveInputClass === 1 ? { cachedTokens: inputTokenUpperBound } : {}),
    // Cache creation is a separately billed class in CostReceipt. Reserve a
    // full request-sized write in addition to the most expensive prompt class;
    // selecting only one class would understate a call that both reads and writes.
    cacheWriteTokens: inputTokenUpperBound,
    outputTokens: outputTokenUpperBound,
  }
}

function assertModelProxyConfig(args: {
  call: ExternalOptimizerModelCall
  callRef: string
  recordExecution: (observation: ExternalOptimizerModelExecutionObservation) => void
  model: string
  budget: ExternalOptimizerModelBudget
  servedModelPolicy?: ServedModelPolicy
  phase: string
  actor: string
  tags?: Record<string, string>
  callId?: string
  initialUsage?: {
    requests: number
    costUsd?: number
  }
}): void {
  assertServedModelPolicy(
    args.servedModelPolicy,
    'external optimizer model proxy: servedModelPolicy',
  )
  for (const [label, value] of [
    ['model', args.model],
    ['phase', args.phase],
    ['actor', args.actor],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
      throw new Error(`external optimizer model proxy: ${label} must be trimmed and non-empty`)
    }
  }
  if (typeof args.call !== 'function') {
    throw new Error('external optimizer model proxy: call must be a function')
  }
  if (
    typeof args.callRef !== 'string' ||
    !args.callRef.trim() ||
    args.callRef.trim() !== args.callRef
  ) {
    throw new Error('external optimizer model proxy: callRef must be trimmed and non-empty')
  }
  if (typeof args.recordExecution !== 'function') {
    throw new Error('external optimizer model proxy: recordExecution must be a function')
  }
  if (args.callId !== undefined) {
    if (
      typeof args.callId !== 'string' ||
      !args.callId.trim() ||
      args.callId !== args.callId.trim()
    ) {
      throw new Error('external optimizer model proxy: callId must be trimmed and non-empty')
    }
    if (args.budget.maxRequests !== 1) {
      throw new Error('external optimizer model proxy: callId requires budget.maxRequests to be 1')
    }
  }
  assertExternalOptimizerModelBudget(args.budget, 'external optimizer model proxy: budget')
  if (args.tags !== undefined) {
    for (const [key, value] of Object.entries(args.tags)) {
      if (!key.trim() || key.trim() !== key || !value.trim() || value.trim() !== value) {
        throw new Error('external optimizer model proxy: tags must be trimmed and non-empty')
      }
    }
  }
  if (args.initialUsage !== undefined) {
    if (
      !Number.isSafeInteger(args.initialUsage.requests) ||
      args.initialUsage.requests < 0 ||
      (args.initialUsage.costUsd !== undefined &&
        (!Number.isFinite(args.initialUsage.costUsd) || args.initialUsage.costUsd < 0))
    ) {
      throw new Error(
        'external optimizer model proxy: initialUsage must contain non-negative requests and cost',
      )
    }
    if (
      args.initialUsage.requests > args.budget.maxRequests ||
      (args.budget.maxCostUsd !== undefined &&
        args.initialUsage.costUsd !== undefined &&
        args.initialUsage.costUsd > args.budget.maxCostUsd + Number.EPSILON)
    ) {
      throw new Error('external optimizer model proxy: initialUsage exceeds the configured budget')
    }
  }
}

class RequestBodyTooLargeError extends Error {}

class ProviderResponseTooLargeError extends Error {
  constructor() {
    super('optimizer model response exceeds maxResponseBytes')
  }
}

class MissingModelExecutionError extends Error {}
class ModelExecutionPersistenceError extends Error {}
class OwnerModelContractError extends Error {}

function readBody(request: IncomingMessage, maximumBytes: number): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.byteLength
      if (size > maximumBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      if (tooLarge) {
        reject(new RequestBodyTooLargeError('optimizer model request body too large'))
        return
      }
      resolvePromise(new Uint8Array(Buffer.concat(chunks)))
    })
  })
}

function randomLocalToken(): string {
  return randomBytes(32).toString('hex')
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError' || error.message.toLowerCase().includes('abort')
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
