/**
 * One paid JSON model call through a caller-owned `ChatClient`, metered by the
 * cost ledger.
 *
 * agent-eval executes no paid model: the transport is supplied by the caller
 * and the credential never enters this package. What stays here is the
 * accounting around the call — the priced maximum reserved before it runs, the
 * stable call id forwarded as the provider idempotency key, the receipt
 * settled from the response, and an honest unknown-usage receipt when the
 * transport failed.
 *
 * The judges and the wire judge endpoint all make the same call in the same
 * order; this is the one copy of that sequence.
 */

import type { ChatClient, ChatResponse } from './analyst/chat-client'
import type { CostChannel, CostLedgerHandle, CostReceipt, CustomTokenPricing } from './cost-ledger'
import {
  costReceiptFromLlm,
  costReceiptFromLlmError,
  extractJsonPayload,
  type LlmCallRequest,
  maximumChargeForLlmRequest,
} from './llm-client'

export interface PaidJsonChatInput {
  /** Caller-owned transport. One `chat()` call. */
  chat: ChatClient
  /** The exact canonical request, including its JSON-mode or schema fields. */
  request: LlmCallRequest
  ledger: CostLedgerHandle
  channel: CostChannel
  phase: string
  actor: string
  tags?: Record<string, string>
  signal?: AbortSignal
  /** Endpoint rates used when the transport reports no billed amount. */
  pricing?: CustomTokenPricing
}

export type PaidJsonChatResult<T> =
  | { succeeded: true; value: T; response: ChatResponse; receipt: CostReceipt }
  | { succeeded: false; error: Error; receipt?: CostReceipt }

/** Parse a JSON answer out of a model response. The transport may fence it. */
export function parseJsonAnswer<T>(response: ChatResponse, actor: string): T {
  try {
    return JSON.parse(extractJsonPayload(response.content)) as T
  } catch (error) {
    throw new Error(
      `${actor}: model answer was not JSON — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function paidJsonChat<T>(input: PaidJsonChatInput): Promise<PaidJsonChatResult<T>> {
  const paid = await input.ledger.runPaidCall({
    channel: input.channel,
    phase: input.phase,
    actor: input.actor,
    model: input.request.model,
    ...(input.tags && Object.keys(input.tags).length > 0 ? { tags: input.tags } : {}),
    maximumCharge: maximumChargeForLlmRequest(input.request, {
      ...(input.chat.maximumAttempts === undefined
        ? {}
        : { maximumAttempts: input.chat.maximumAttempts }),
      ...(input.pricing ? { customTokenPricing: input.pricing } : {}),
    }),
    ...(input.signal ? { signal: input.signal } : {}),
    execute: (signal, callId) => input.chat.chat(input.request, { signal, idempotencyKey: callId }),
    receipt: (response) => costReceiptFromLlm(response, input.pricing),
    receiptFromError: (error) => costReceiptFromLlmError(error, input.pricing),
  })
  if (!paid.succeeded) {
    return {
      succeeded: false,
      error: paid.error,
      ...(paid.receipt ? { receipt: paid.receipt } : {}),
    }
  }
  // The call completed and was billed. A malformed answer is a contract
  // failure AFTER the money was spent, so it keeps the settled receipt instead
  // of reporting the spend as unknown.
  try {
    return {
      succeeded: true,
      value: parseJsonAnswer<T>(paid.value, input.actor),
      response: paid.value,
      receipt: paid.receipt,
    }
  } catch (error) {
    return {
      succeeded: false,
      error: error instanceof Error ? error : new Error(String(error)),
      receipt: paid.receipt,
    }
  }
}
