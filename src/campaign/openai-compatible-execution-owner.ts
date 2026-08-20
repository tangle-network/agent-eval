import type { CustomTokenPricing } from '../cost-ledger'
import {
  callLlm,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type LlmCallRequest,
} from '../llm-client'
import type {
  ExternalOptimizerModelCall,
  ExternalOptimizerModelCallResult,
} from './external-optimizer-contracts'

export interface OpenAiCompatibleExecutionOwnerOptions {
  /** OpenAI-compatible base URL, ending at the `/v1` prefix. No default: the paid endpoint is always explicit. */
  baseUrl: string
  /** Bearer credential sent as `Authorization`. It stays inside this owner and never reaches the optimizer process. */
  apiKey: string
  /** Model id recorded on a failure receipt when no provider response exists. */
  model: string
  /** Exact endpoint rates, used to estimate cost when the provider omits billed cost. */
  pricing?: CustomTokenPricing
  /** Per-request deadline in milliseconds. Default: the transport default (300,000 ms). */
  timeoutMs?: number
  /** Total provider attempts per admitted call. Default: 2. */
  maximumAttempts?: number
  /** Fetch implementation override for tests. */
  fetch?: typeof fetch
}

/**
 * Execution owner for the metered optimizer-model path, backed by any
 * OpenAI-compatible `/chat/completions` endpoint.
 *
 * The loopback proxy owns admission, budgets, identity checks, and
 * cost-ledger recording. This owner only executes the exact admitted
 * request and resolves with a typed outcome: a canonical response plus a
 * JSON-clean receipt on success, or a public error plus an honest receipt
 * on failure. It never rejects, because a rejection loses the execution
 * record and fails the optimizer attempt.
 *
 * Canonical `tools`/`toolChoice` pass through to the wire as
 * `tools`/`tool_choice`; response `tool_calls` come back as canonical
 * `toolCalls`. A response that carries none when tools were sent is a valid
 * model answer, not an error.
 */
export function createOpenAiCompatibleExecutionOwner(
  options: OpenAiCompatibleExecutionOwnerOptions,
): ExternalOptimizerModelCall {
  for (const field of ['baseUrl', 'apiKey', 'model'] as const) {
    const value = options[field]
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
      throw new Error(
        `createOpenAiCompatibleExecutionOwner: ${field} must be a trimmed, non-empty string`,
      )
    }
  }
  const { baseUrl, apiKey, model, pricing, timeoutMs, maximumAttempts, fetch: fetchImpl } = options
  return async ({ callId, request, signal }): Promise<ExternalOptimizerModelCallResult> => {
    // The proxy freezes the canonical request; the transport needs a mutable copy.
    const transportRequest = structuredClone(request) as unknown as LlmCallRequest
    try {
      const wireResponse = await callLlm(transportRequest, {
        baseUrl,
        apiKey,
        signal,
        idempotencyKey: callId,
        maximumAttempts: maximumAttempts ?? 2,
        ...(timeoutMs === undefined ? {} : { defaultTimeoutMs: timeoutMs }),
        ...(pricing ? { customTokenPricing: pricing } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      })
      // 'tool_calls' is the OpenAI wire echo for a tool-calling stop; the
      // canonical contract names the same stop cause 'tool_use'.
      const response =
        wireResponse.finishReason === 'tool_calls'
          ? { ...wireResponse, finishReason: 'tool_use' }
          : wireResponse
      return {
        succeeded: true,
        response,
        receipt: costReceiptFromLlm(response, pricing),
        execution: {
          owner: 'openai-compatible',
          endpoint: baseUrl,
          model: response.model,
          callId,
          durationMs: response.durationMs,
        },
      }
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      // A structured-response failure keeps its completed provider receipt.
      // A transport fault carries none, so usage and cost stay unknown
      // rather than becoming a guessed zero.
      const receipt = costReceiptFromLlmError(cause, pricing) ?? {
        model,
        inputTokens: 0,
        outputTokens: 0,
        costUnknown: true,
        usageUnknown: true,
      }
      return {
        succeeded: false,
        error: cause.message,
        receipt,
        execution: {
          owner: 'openai-compatible',
          endpoint: baseUrl,
          model,
          callId,
          failed: true,
        },
      }
    }
  }
}
