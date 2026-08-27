import type { TCloud } from '@tangle-network/tcloud'
import type { CostReceiptInput, MaximumCharge } from './cost-ledger'
import { type LlmCallRequest, maximumChargeForLlmRequest } from './llm-client'

export type MeteredTCloudRequest = Pick<
  LlmCallRequest,
  'model' | 'messages' | 'maxTokens' | 'temperature'
>

/**
 * TCloud does not expose its configured retry count. Capped callers must pass
 * the exact maximum number of provider attempts; otherwise the ledger rejects
 * before dispatch. The request's maxTokens is enforced by the provider.
 */
export function maximumChargeForTCloudRequest(
  request: MeteredTCloudRequest,
  maximumAttempts: number | undefined,
): MaximumCharge | undefined {
  if (maximumAttempts === undefined) return undefined
  return maximumChargeForLlmRequest(request, { maxRetries: maximumAttempts })
}

export function costReceiptFromTCloud(
  response: Awaited<ReturnType<TCloud['chat']>>,
  requestedModel: string,
): CostReceiptInput {
  const usage = response.usage
  const inputTokens = tokenCount(usage?.prompt_tokens)
  const outputTokens = tokenCount(usage?.completion_tokens)
  const totalTokens = tokenCount(usage?.total_tokens)
  const usageUnknown =
    inputTokens === undefined ||
    outputTokens === undefined ||
    (totalTokens !== undefined && totalTokens !== inputTokens + outputTokens)
  return {
    model: response.model || requestedModel,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    costUnknown: usageUnknown,
    usageUnknown,
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
