import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type CostChannel,
  type CostLedgerHandle,
  type CostReceiptInput,
  type CustomTokenPricing,
  costForTokenPricing,
} from '../cost-ledger'
import { errorMessage as toErrorMessage } from '../errors'
import { ModelSubstitutionError, type ServedModelPolicy } from '../integrity/served-model'
import {
  AnthropicRequestRefusal,
  anthropicErrorEnvelope,
  anthropicErrorTypeForStatus,
} from './external-optimizer-anthropic'
import type {
  ExternalOptimizerModelBudget,
  ExternalOptimizerModelCall,
  ExternalOptimizerModelExecutionObservation,
} from './external-optimizer-contracts'
import { sendJsonIfOpen } from './external-optimizer-http'
import {
  MissingModelExecutionError,
  ModelExecutionPersistenceError,
  type ModelProxyPath,
  type ModelProxyWire,
  OwnerModelContractError,
  type ProviderProxyResponse,
  ProviderResponseTooLargeError,
  RequestBodyTooLargeError,
  type UnsequencedExecutionObservation,
} from './external-optimizer-model-contract'
import { forwardModelProxyRequest } from './external-optimizer-model-execution'
import { parseModelProxyRequest } from './external-optimizer-model-request'

const MODEL_PROXY_PATHS = new Set(['/v1/chat/completions', '/v1/responses'])

export async function handleModelProxyRequest(args: {
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
    anthropicEndpoint?: boolean
  }
  nextReservation: (
    maximumCostUsd: number | undefined,
    wire: ModelProxyWire,
  ) =>
    | { accepted: true }
    | {
        accepted: false
        reason: 'optimizer model request limit reached' | 'optimizer model cost limit reached'
      }
  settleReservation: (
    maximumCostUsd: number | undefined,
    chargedCostUsd: number | undefined,
  ) => void
  recordSuccessfulCompletion: (wire: ModelProxyWire) => void
  recordExecutionReceipt: (observation: UnsequencedExecutionObservation) => void
  recordModelCallInvocation: () => void
  recordFailure: (error: Error) => void
}): Promise<void> {
  const { controller, request, response } = args
  let wire: ModelProxyWire = 'openai'
  // The `claude` CLI retries only 408/409/429/5xx. A budget or ledger refusal
  // must therefore surface as 402 on the Anthropic wire: retrying an exhausted
  // budget burns wall clock with no possible recovery.
  const respondError = (status: number, message: string, errorType?: string): void => {
    if (wire === 'anthropic') {
      const mapped = status === 429 ? 402 : status
      sendJsonIfOpen(
        response,
        mapped,
        anthropicErrorEnvelope(errorType ?? anthropicErrorTypeForStatus(mapped), message),
      )
      return
    }
    sendJsonIfOpen(response, status, { error: message })
  }
  try {
    const path = request.url ? new URL(request.url, 'http://127.0.0.1').pathname : ''
    const anthropicPath = path === '/v1/messages' && args.args.anthropicEndpoint === true
    if (request.method !== 'POST' || !(MODEL_PROXY_PATHS.has(path) || anthropicPath)) {
      sendJsonIfOpen(response, 404, { error: 'not found' })
      return
    }
    if (anthropicPath) wire = 'anthropic'
    const modelPath = path as ModelProxyPath
    const bearerAuthorized = request.headers.authorization === `Bearer ${args.token}`
    // The Anthropic SDK spells ANTHROPIC_AUTH_TOKEN as a bearer and
    // ANTHROPIC_API_KEY as x-api-key; both carry the same ephemeral token.
    const authorized =
      bearerAuthorized || (wire === 'anthropic' && request.headers['x-api-key'] === args.token)
    if (!authorized) {
      respondError(401, 'unauthorized')
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
    const reservation = args.nextReservation(maximumCostUsd, wire)
    if (!reservation.accepted) {
      respondError(429, reservation.reason)
      return
    }

    const timeout = setTimeout(
      () => controller.abort(),
      args.args.budget.requestTimeoutMs ?? 300_000,
    )
    let chargedForBudget = maximumCostUsd
    try {
      // `strippedFields` discloses the Anthropic control fields the shim
      // removed before metering, so accounting shows the exact served request.
      const requestTags =
        wire === 'anthropic'
          ? {
              ...(args.args.tags ?? {}),
              wire: 'anthropic',
              ...(parsed.strippedFields === undefined
                ? {}
                : { strippedFields: parsed.strippedFields.join(',') }),
            }
          : args.args.tags
      const paid = await args.args.costLedger.runPaidCall<ProviderProxyResponse>({
        ...(args.args.callId ? { callId: args.args.callId } : {}),
        channel: args.args.channel ?? 'optimizer',
        phase: args.args.phase,
        actor: args.args.actor,
        ...(requestTags ? { tags: requestTags } : {}),
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
            ...(parsed.stream === undefined ? {} : { anthropicStream: parsed.stream }),
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
        respondError(
          isAbortError(paid.error)
            ? 504
            : paid.error instanceof AnthropicRequestRefusal
              ? paid.error.status
              : paid.error instanceof ProviderResponseTooLargeError ||
                  paid.error instanceof MissingModelExecutionError ||
                  paid.error instanceof ModelExecutionPersistenceError ||
                  paid.error instanceof OwnerModelContractError ||
                  paid.error instanceof ModelSubstitutionError
                ? 502
                : 429,
          paid.error.message,
          paid.error instanceof AnthropicRequestRefusal ? paid.error.errorType : undefined,
        )
        return
      }
      if (paid.value.modelCallFailed) {
        respondError(502, paid.value.modelCallFailed)
        return
      }
      chargedForBudget = paid.value.usageComplete ? paid.receipt.costUsd : maximumCostUsd
      // A response that violated the output or reasoning limit is rejected. A
      // response the provider merely under-reported is forwarded with its cost
      // charged at the reservation maximum, so the analysis keeps its usable
      // completion and the ledger holds an honest upper-bound charge.
      if (paid.value.usageRejected) {
        respondError(502, paid.value.usageRejected)
        return
      }
      if (paid.value.status >= 200 && paid.value.status < 300) {
        args.recordSuccessfulCompletion(wire)
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
      error instanceof AnthropicRequestRefusal
        ? error.status
        : error instanceof RequestBodyTooLargeError
          ? 413
          : error instanceof Error && isAbortError(error)
            ? 503
            : 400
    respondError(
      status,
      toErrorMessage(error),
      error instanceof AnthropicRequestRefusal ? error.errorType : undefined,
    )
  }
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

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError' || error.message.toLowerCase().includes('abort')
}
