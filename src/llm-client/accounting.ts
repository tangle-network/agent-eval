import type { CostReceiptInput, CustomTokenPricing, MaximumCharge } from '../cost-ledger'
import type { LlmCallRequest, LlmCallResult, LlmChargeBounds } from './contract'
import { LlmResponseError } from './errors'
import { resolveMaximumAttempts } from './resilience'
import { buildBody } from './wire'

export function maximumChargeForLlmRequest(
  request: Pick<
    LlmCallRequest,
    'model' | 'messages' | 'jsonSchema' | 'tools' | 'toolChoice' | 'maxTokens' | 'thinking'
  >,
  options: LlmChargeBounds = {},
): MaximumCharge | undefined {
  if (request.maxTokens === undefined) return undefined
  if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
    throw new RangeError(`maximumChargeForLlmRequest: maxTokens must be a positive integer`)
  }
  if (
    request.messages.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'),
    )
  ) {
    return undefined
  }

  const attempts = resolveMaximumAttempts(options.maximumAttempts)
  const forceJsonObject = options.jsonSchemaTransport === 'json-object'
  // A byte-level tokenizer cannot emit more input tokens than request bytes.
  // Pricing the complete body also covers role/schema framing omitted from content-only estimates.
  const requestBytes = new TextEncoder().encode(
    JSON.stringify(buildBody(request, forceJsonObject, options.thinking)),
  ).byteLength
  // Schema fallback shares the same physical-attempt budget; it cannot buy a second batch.
  const usage = {
    inputTokens: requestBytes * attempts,
    outputTokens: request.maxTokens * attempts,
  }
  return options.customTokenPricing
    ? { customTokenPricing: options.customTokenPricing, ...usage }
    : { model: request.model, ...usage }
}

/** Convert a provider result into the canonical paid-call receipt input.
 * The receipt is JSON-clean: absent optional fields are omitted, never carried
 * as explicit-undefined keys. Receipts cross JSON boundaries (the external
 * optimizer's loopback proxy validates them with `assertJsonValue`), where an
 * explicit-undefined value is rejected as non-serializable. */
export function costReceiptFromLlm(
  result: LlmCallResult,
  customTokenPricing?: CustomTokenPricing,
): CostReceiptInput {
  const cachedTokens = result.usage.cachedPromptTokens ?? 0
  const inputTokens = Math.max(0, result.usage.promptTokens - cachedTokens)
  const providerCostUsd = providerReportedCost(result.raw)
  return {
    model: result.model,
    inputTokens,
    outputTokens: result.usage.completionTokens,
    ...(result.usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: result.usage.reasoningTokens }),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(providerCostUsd === undefined
      ? customTokenPricing && result.usage.captured !== false
        ? { customTokenPricing }
        : result.costUsd === null
          ? {}
          : { estimatedCostUsd: result.costUsd }
      : { actualCostUsd: providerCostUsd }),
    usageUnknown: result.usage.captured === false,
  }
}

export function providerReportedCost(raw: Record<string, unknown>): number | undefined {
  const value = raw._response_cost ?? raw.cost_usd
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Structured-response failures retain their completed provider receipt. */
export function costReceiptFromLlmError(
  error: Error,
  customTokenPricing?: CustomTokenPricing,
): CostReceiptInput | undefined {
  return error instanceof LlmResponseError
    ? costReceiptFromLlm(error.result, customTokenPricing)
    : undefined
}
