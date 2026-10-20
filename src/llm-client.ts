/**
 * OpenAI-compatible client. The CLASS is internal; one transport now drives it
 * for public callers.
 *
 * agent-eval never goes looking for a credential — it reads no environment
 * variable to find one — and this module is still not reachable through any
 * export subpath. What reaches a consumer is `createChatClient({ transport:
 * 'openai-compatible', baseUrl, apiKey })`, the sanctioned public route, which
 * constructs this client from an endpoint and a credential the caller passed as
 * values. Anything richer than that transport's options stays in-repo.
 *
 * Three in-repo callers hold the class directly:
 *   - `src/analyst/chat-client.ts`, the public transport above;
 *   - the `agent-eval` binary (`src/cli-config.ts`), a deployed server whose
 *     caller is a JSON-RPC client in another language and which therefore
 *     configures its own endpoint from its own environment;
 *   - the loopback optimizer proxy path (`src/analyst/benchmark-public-model.ts`,
 *     `src/analyst/dspy-rlm-engine.ts`), which targets `http://127.0.0.1:<port>/v1`
 *     with an ephemeral token and executes nothing itself.
 *
 * The canonical request/result TYPES it defines ARE public — they are the
 * contract every caller-owned transport speaks.
 *
 * OpenAI-compatible `/v1/chat/completions` client with:
 *   - Exponential-backoff retry on 429 + 5xx gateway errors (502/503/504).
 *   - Retry on transient network errors (fetch failed, AbortError, ECONNRESET).
 *   - One retry at temperature 1 when a model explicitly requires it.
 *   - Graceful json_schema → json_object degrade on 400 with schema-reject body.
 *   - Fenced-JSON stripping (```json ... ```) for models that wrap structured output.
 *   - Configurable base URL + api key / bearer, works with LiteLLM proxies, OpenAI
 *     directly, cli-bridge subscriptions, and any router that speaks the spec.
 *
 * Usage:
 *   const { value, result } = await callLlmJson<MyType>(
 *     { model: 'gpt-4o', messages: [...], jsonSchema: { name: 'x', schema: {...} } },
 *     { baseUrl: process.env.AGENT_EVAL_LLM_BASE_URL, apiKey: process.env.AGENT_EVAL_LLM_API_KEY },
 *   )
 *
 */

import type { LlmCallRequest, LlmCallResult, LlmClientOptions } from './llm-client/contract'
import { parseJsonResult } from './llm-client/json'
import { callLlm, callLlmStructured } from './llm-client/request'
import {
  pacingStateFor,
  pacingStates,
  resolveMaximumAttempts,
  resolveMinIntervalMs,
} from './llm-client/resilience'

export {
  costReceiptFromLlm,
  costReceiptFromLlmError,
  maximumChargeForLlmRequest,
} from './llm-client/accounting'
export type {
  LlmCallMetadata,
  LlmCallRequest,
  LlmCallResult,
  LlmChargeBounds,
  LlmClientOptions,
  LlmMessage,
  LlmThinkingMode,
  LlmTokenLogprob,
  LlmToolCall,
  LlmToolChoice,
  LlmToolDefinition,
  LlmUsage,
} from './llm-client/contract'
export { LlmCallError, LlmResponseError } from './llm-client/errors'
export { extractJsonPayload, stripFencedJson } from './llm-client/json'
export { callLlm } from './llm-client/request'
export { backoffMs, isTransientLlmError } from './llm-client/resilience'

/**
 * Structured-output call. Returns parsed JSON plus the raw result envelope.
 * Degrades `jsonSchema` → `jsonMode` on a 400 that names the schema param —
 * critical for deepseek-v3/v4, kimi-k2.6, and other models that don't accept
 * the `response_format.json_schema` shape but DO accept `json_object`.
 */
export async function callLlmJson<T = unknown>(
  req: LlmCallRequest,
  opts: LlmClientOptions = {},
): Promise<{ value: T; result: LlmCallResult }> {
  const result = await callLlmStructured(req, opts)
  const value = parseJsonResult<T>(result, opts.jsonPayloadMode ?? 'extract')
  return { value, result }
}

/**
 * Stateful client — construct once with defaults, call many times.
 * Thin wrapper around the free functions; exists for callers that want
 * to inject a single configured instance into multiple primitives.
 */
export class LlmClient {
  readonly maximumAttempts: number
  private readonly opts: LlmClientOptions

  constructor(opts: LlmClientOptions = {}) {
    this.opts = opts
    this.maximumAttempts = resolveMaximumAttempts(opts.maximumAttempts)
    resolveMinIntervalMs(opts.minIntervalMs)
  }

  private callOptions(per?: LlmClientOptions): LlmClientOptions {
    const options = { ...this.opts, ...per }
    pacingStates.set(options, pacingStateFor(this.opts))
    return options
  }

  call(req: LlmCallRequest, per?: LlmClientOptions): Promise<LlmCallResult> {
    const options = this.callOptions(per)
    return req.jsonSchema ? callLlmStructured(req, options) : callLlm(req, options)
  }

  callJson<T = unknown>(
    req: LlmCallRequest,
    per?: LlmClientOptions,
  ): Promise<{ value: T; result: LlmCallResult }> {
    return callLlmJson<T>(req, this.callOptions(per))
  }
}
