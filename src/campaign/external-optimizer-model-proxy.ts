import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { CostLedgerHandle, CostReceiptInput, CustomTokenPricing } from '../cost-ledger'
import { costForTokenPricing } from '../cost-ledger'
import {
  assertExternalOptimizerModelBudget,
  type ExternalOptimizerModelBudget,
  type ExternalOptimizerModelProxy,
  isRecord,
} from './external-optimizer-contracts'
import { closeServer, listenLocal, sendJson } from './external-optimizer-http'

const MODEL_PROXY_PATHS = new Set(['/v1/chat/completions', '/v1/responses'])

interface ProviderProxyResponse {
  status: number
  contentType: string
  body: Uint8Array
  receipt: CostReceiptInput
  usageComplete: boolean
}

/**
 * Put an OpenAI-compatible optimizer behind the shared cost ledger.
 *
 * The child process receives only a loopback URL and an ephemeral token.
 * Provider credentials stay in this process. Every request reserves its
 * conservative byte-count input bound plus the provider-enforced output cap
 * before it leaves the machine.
 */
export async function startExternalOptimizerModelProxy(args: {
  upstreamBaseUrl: string
  upstreamApiKey: string
  model: string
  budget: ExternalOptimizerModelBudget
  costLedger: CostLedgerHandle
  phase: string
  actor: string
  tags?: Record<string, string>
  initialUsage?: {
    requests: number
    costUsd: number
  }
  fetchImpl?: typeof fetch
}): Promise<ExternalOptimizerModelProxy> {
  assertModelProxyConfig(args)
  const token = randomLocalToken()
  const fetchImpl = args.fetchImpl ?? fetch
  let requestCount = 0
  let successfulCompletionCount = 0
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
      fetchImpl,
      nextReservation: (maximumCostUsd) => {
        if (totalRequestCount >= args.budget.maxRequests) {
          return { accepted: false as const, reason: 'optimizer model request limit reached' }
        }
        if (
          committedForBudget + reservedForBudget + maximumCostUsd >
          args.budget.maxCostUsd + Number.EPSILON
        ) {
          return { accepted: false as const, reason: 'optimizer model cost limit reached' }
        }
        requestCount += 1
        totalRequestCount += 1
        reservedForBudget += maximumCostUsd
        return { accepted: true as const }
      },
      settleReservation: (maximumCostUsd, chargedCostUsd) => {
        reservedForBudget = Math.max(0, reservedForBudget - maximumCostUsd)
        committedForBudget += chargedCostUsd
      },
      recordSuccessfulCompletion: () => {
        successfulCompletionCount += 1
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
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: token,
    requestAttempts: () => requestCount,
    successfulCompletions: () => successfulCompletionCount,
    close: () => {
      closePromise ??= closeModelProxy()
      return closePromise
    },
  }

  async function closeModelProxy(): Promise<void> {
    accepting = false
    const closingServer = closeServer(server)
    server.closeIdleConnections?.()
    for (const controller of activeControllers) controller.abort()
    const [serverResult] = await Promise.allSettled([
      closingServer,
      waitForActiveHandlers(activeHandlers),
    ])
    if (activeControllers.size !== 0 || activeHandlers.size !== 0) {
      throw new Error('external optimizer model proxy closed with active request work')
    }
    if (serverResult?.status === 'rejected') throw serverResult.reason
  }
}

async function handleModelProxyRequest(args: {
  request: IncomingMessage
  response: ServerResponse
  controller: AbortController
  token: string
  args: {
    upstreamBaseUrl: string
    upstreamApiKey: string
    model: string
    budget: ExternalOptimizerModelBudget
    costLedger: CostLedgerHandle
    phase: string
    actor: string
    tags?: Record<string, string>
  }
  fetchImpl: typeof fetch
  nextReservation: (maximumCostUsd: number) =>
    | { accepted: true }
    | {
        accepted: false
        reason: 'optimizer model request limit reached' | 'optimizer model cost limit reached'
      }
  settleReservation: (maximumCostUsd: number, chargedCostUsd: number) => void
  recordSuccessfulCompletion: () => void
}): Promise<void> {
  const { controller, request, response } = args
  try {
    const path = request.url ? new URL(request.url, 'http://127.0.0.1').pathname : ''
    if (request.method !== 'POST' || !MODEL_PROXY_PATHS.has(path)) {
      sendJsonIfOpen(response, 404, { error: 'not found' })
      return
    }
    if (request.headers.authorization !== `Bearer ${args.token}`) {
      sendJsonIfOpen(response, 401, { error: 'unauthorized' })
      return
    }

    const body = await readBody(request, args.args.budget.maxRequestBytes)
    const parsed = parseModelProxyRequest(body, args.args.model, args.args.budget)
    const maximumUsage = conservativeMaximumUsage(
      body.byteLength,
      parsed.maxOutputTokens,
      args.args.budget.pricing,
    )
    const maximumCostUsd = costForTokenPricing(args.args.budget.pricing, maximumUsage)
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
        channel: 'optimizer',
        phase: args.args.phase,
        actor: args.args.actor,
        ...(args.args.tags ? { tags: args.args.tags } : {}),
        model: args.args.model,
        maximumCharge: {
          customTokenPricing: args.args.budget.pricing,
          ...maximumUsage,
        },
        execute: async () =>
          forwardModelProxyRequest({
            fetchImpl: args.fetchImpl,
            upstreamBaseUrl: args.args.upstreamBaseUrl,
            upstreamApiKey: args.args.upstreamApiKey,
            path,
            body,
            model: args.args.model,
            pricing: args.args.budget.pricing,
            maxResponseBytes: args.args.budget.maxResponseBytes,
            signal: controller.signal,
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
        chargedForBudget = paid.receipt
          ? paid.receipt.usageUnknown || paid.receipt.costUnknown
            ? maximumCostUsd
            : paid.receipt.costUsd
          : 0
        sendJsonIfOpen(
          response,
          isAbortError(paid.error)
            ? 504
            : paid.error instanceof ProviderResponseTooLargeError
              ? 502
              : 429,
          { error: paid.error.message },
        )
        return
      }
      chargedForBudget = paid.value.usageComplete ? paid.receipt.costUsd : maximumCostUsd
      if (!paid.value.usageComplete) {
        sendJsonIfOpen(response, 502, {
          error: 'optimizer model response omitted complete token usage',
        })
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
  fetchImpl: typeof fetch
  upstreamBaseUrl: string
  upstreamApiKey: string
  path: string
  body: Uint8Array
  model: string
  pricing: CustomTokenPricing
  maxResponseBytes: number
  signal: AbortSignal
}): Promise<ProviderProxyResponse> {
  const upstream = modelProxyUpstreamUrl(args.upstreamBaseUrl, args.path)
  const response = await args.fetchImpl(upstream, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.upstreamApiKey}`,
      'content-type': 'application/json',
    },
    body: args.body.buffer.slice(
      args.body.byteOffset,
      args.body.byteOffset + args.body.byteLength,
    ) as ArrayBuffer,
    signal: args.signal,
    redirect: 'error',
  })
  const body = await readProviderResponseBody(response, args.maxResponseBytes)
  const usage = parseProviderUsage(body)
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? 'application/json',
    body,
    receipt: usage
      ? {
          model: args.model,
          ...usage,
          ...(usage.actualCostUsd === undefined ? { customTokenPricing: args.pricing } : {}),
        }
      : {
          model: args.model,
          inputTokens: 0,
          outputTokens: 0,
          costUnknown: true,
          usageUnknown: true,
        },
    usageComplete: usage !== undefined,
  }
}

function parseModelProxyRequest(
  body: Uint8Array,
  expectedModel: string,
  budget: ExternalOptimizerModelBudget,
): { maxOutputTokens: number } {
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
  const suppliedMaximums = [
    value.max_output_tokens,
    value.max_completion_tokens,
    value.max_tokens,
  ].filter((maximum) => maximum !== undefined)
  if (
    suppliedMaximums.length === 0 ||
    suppliedMaximums.some((maximum) => !Number.isSafeInteger(maximum) || (maximum as number) <= 0)
  ) {
    throw new Error('optimizer model request requires a positive output-token limit')
  }
  const maxOutputTokens = Math.max(...(suppliedMaximums as number[]))
  if (maxOutputTokens > budget.maxOutputTokensPerRequest) {
    throw new Error('optimizer model request exceeds maxOutputTokensPerRequest')
  }
  return { maxOutputTokens }
}

function modelProxyUpstreamUrl(baseUrl: string, requestPath: string): string {
  const upstream = new URL(baseUrl)
  const basePath = upstream.pathname.replace(/\/+$/, '')
  const suffix = basePath.endsWith('/v1') ? requestPath.replace(/^\/v1/, '') : requestPath
  upstream.pathname = `${basePath}${suffix}`
  return upstream.toString()
}

function parseProviderUsage(
  body: Uint8Array,
):
  | Omit<CostReceiptInput, 'model' | 'customTokenPricing' | 'costUnknown' | 'usageUnknown'>
  | undefined {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(body).toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(value) || !isRecord(value.usage)) return undefined
  const usage = value.usage
  const totalInputTokens = usage.input_tokens ?? usage.prompt_tokens
  const outputTokens = usage.output_tokens ?? usage.completion_tokens
  if (
    !Number.isSafeInteger(totalInputTokens) ||
    (totalInputTokens as number) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens as number) < 0
  ) {
    return undefined
  }
  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : {}
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : isRecord(usage.completion_tokens_details)
      ? usage.completion_tokens_details
      : {}
  const cachedTokens = optionalTokenCount(inputDetails, [
    'cached_tokens',
    'cache_read_tokens',
    'cache_read_input_tokens',
  ])
  const cacheWriteTokens = optionalTokenCount(inputDetails, [
    'cache_write_tokens',
    'cache_creation_tokens',
    'cache_creation_input_tokens',
  ])
  const reasoningTokens = optionalTokenCount(outputDetails, ['reasoning_tokens'])
  const actualCostUsd =
    typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0
      ? usage.cost
      : undefined
  if (
    cachedTokens === INVALID_TOKEN_COUNT ||
    cacheWriteTokens === INVALID_TOKEN_COUNT ||
    reasoningTokens === INVALID_TOKEN_COUNT
  ) {
    return undefined
  }
  const classifiedInputTokens = (cachedTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (
    classifiedInputTokens > (totalInputTokens as number) ||
    (reasoningTokens ?? 0) > (outputTokens as number)
  ) {
    return undefined
  }
  return {
    inputTokens: (totalInputTokens as number) - classifiedInputTokens,
    outputTokens: outputTokens as number,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
  }
}

const INVALID_TOKEN_COUNT = Symbol('invalid-token-count')

function optionalTokenCount(
  details: Record<string, unknown>,
  fields: readonly string[],
): number | undefined | typeof INVALID_TOKEN_COUNT {
  let found: number | undefined
  for (const field of fields) {
    const value = details[field]
    if (value === undefined || value === null) continue
    if (!Number.isSafeInteger(value) || (value as number) < 0) return INVALID_TOKEN_COUNT
    if (found !== undefined && found !== value) return INVALID_TOKEN_COUNT
    found = value as number
  }
  return found
}

function conservativeMaximumUsage(
  inputTokenUpperBound: number,
  outputTokenUpperBound: number,
  pricing: CustomTokenPricing,
): Pick<CostReceiptInput, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens'> {
  const inputRates = [
    pricing.inputUsdPerMillion,
    pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion,
    pricing.cacheWriteUsdPerMillion ?? pricing.inputUsdPerMillion,
  ]
  const mostExpensiveInputClass = inputRates.indexOf(Math.max(...inputRates))
  return {
    inputTokens: mostExpensiveInputClass === 0 ? inputTokenUpperBound : 0,
    ...(mostExpensiveInputClass === 1 ? { cachedTokens: inputTokenUpperBound } : {}),
    ...(mostExpensiveInputClass === 2 ? { cacheWriteTokens: inputTokenUpperBound } : {}),
    outputTokens: outputTokenUpperBound,
  }
}

async function readProviderResponseBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new ProviderResponseTooLargeError()
    }
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      totalBytes += next.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new ProviderResponseTooLargeError()
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function assertModelProxyConfig(args: {
  upstreamBaseUrl: string
  upstreamApiKey: string
  model: string
  budget: ExternalOptimizerModelBudget
  phase: string
  actor: string
  tags?: Record<string, string>
  initialUsage?: {
    requests: number
    costUsd: number
  }
}): void {
  for (const [label, value] of [
    ['upstreamBaseUrl', args.upstreamBaseUrl],
    ['upstreamApiKey', args.upstreamApiKey],
    ['model', args.model],
    ['phase', args.phase],
    ['actor', args.actor],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
      throw new Error(`external optimizer model proxy: ${label} must be trimmed and non-empty`)
    }
  }
  let parsed: URL
  try {
    parsed = new URL(args.upstreamBaseUrl)
  } catch {
    throw new Error('external optimizer model proxy: upstreamBaseUrl must be an HTTP(S) URL')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'external optimizer model proxy: upstreamBaseUrl must be an HTTP(S) URL without credentials, query, or fragment',
    )
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
      !Number.isFinite(args.initialUsage.costUsd) ||
      args.initialUsage.costUsd < 0
    ) {
      throw new Error(
        'external optimizer model proxy: initialUsage must contain non-negative requests and cost',
      )
    }
    if (
      args.initialUsage.requests > args.budget.maxRequests ||
      args.initialUsage.costUsd > args.budget.maxCostUsd + Number.EPSILON
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
