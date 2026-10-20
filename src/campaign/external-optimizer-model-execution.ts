import type { ChatResponse } from '../analyst/chat-client'
import { type CostReceiptInput, costForTokenPricing } from '../cost-ledger'
import { errorMessage as toErrorMessage } from '../errors'
import { assertServedModel } from '../integrity/served-model'
import { deepFreezeCanonicalJson as deepFreezeJson } from '../ledger-core/deep-freeze'
import { isNonnegativeFiniteNumber } from '../math/nonnegative-number'
import { canonicalJson } from '../verdict-cache'
import {
  assertJsonValue,
  type ExternalOptimizerChatRequest,
  type ExternalOptimizerModelCall,
  freezeJsonSnapshot,
  isRecord,
} from './external-optimizer-contracts'
import {
  MissingModelExecutionError,
  type ModelProxyPath,
  OwnerModelContractError,
  type ProviderProxyResponse,
  type UnsequencedExecutionObservation,
} from './external-optimizer-model-contract'
import {
  encodeAnthropicResponseBody,
  encodeCanonicalModelResponse,
  endpointFormat,
} from './external-optimizer-model-response'

export async function forwardModelProxyRequest(args: {
  call: ExternalOptimizerModelCall
  callId: string
  callRef: string
  recordExecutionReceipt: (observation: UnsequencedExecutionObservation) => void
  recordModelCallInvocation: () => void
  path: ModelProxyPath
  request: ExternalOptimizerChatRequest
  /** Anthropic-wire SSE request; the stream is synthesized after completion. */
  anthropicStream?: boolean
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
    const encoded =
      args.path === '/v1/messages'
        ? encodeAnthropicResponseBody({
            callId: args.callId,
            response: canonicalResponse,
            stream: args.anthropicStream === true,
            maxBytes: args.maxResponseBytes,
          })
        : {
            contentType: 'application/json',
            body: encodeCanonicalModelResponse({
              path: args.path,
              callId: args.callId,
              response: canonicalResponse,
              receipt: authoritativeReceipt,
              maxBytes: args.maxResponseBytes,
            }),
          }
    return {
      status: 200,
      contentType: encoded.contentType,
      body: encoded.body,
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
  const toolCalls = snapshotResponseToolCalls(value.toolCalls)
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
    ...(toolCalls === undefined ? {} : { toolCalls }),
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

/** Snapshot the owner's canonical tool calls onto the allowlisted response. */
function snapshotResponseToolCalls(
  value: unknown,
): Array<{ id: string; name: string; argumentsJson: string }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new OwnerModelContractError(
      'optimizer model callback response toolCalls must be a non-empty array when present',
    )
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.name !== 'string' ||
      !entry.name ||
      typeof entry.argumentsJson !== 'string'
    ) {
      throw new OwnerModelContractError(
        'optimizer model callback response toolCalls entries require string id, name, and argumentsJson',
      )
    }
    return { id: entry.id, name: entry.name, argumentsJson: entry.argumentsJson }
  })
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
