import type { CustomTokenPricing } from '../cost-ledger'
import type { AssertServedModelOptions } from '../integrity/served-model'
import type { ProviderRedactor, RawProviderSink } from '../trace/raw-provider-sink'

// ─── Types ──────────────────────────────────────────────────────────────

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * Either a plain text content string OR a multimodal content array
   * (text + image_url parts) for vision-capable models.
   */
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
      >
  /** Tool invocations made by an `assistant` message earlier in the turn. */
  toolCalls?: LlmToolCall[]
  /** The invocation a `tool` message answers. Required when role is `tool`. */
  toolCallId?: string
}

export type LlmThinkingMode = 'enabled' | 'disabled'

/** Canonical function-tool definition offered to the model. */
export interface LlmToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

/** Canonical tool-choice policy; meaningful only when `tools` is present. */
export type LlmToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

/** One tool invocation on a response or an assistant history message. */
export interface LlmToolCall {
  id: string
  name: string
  /** JSON-encoded arguments, exactly as the provider produced them. */
  argumentsJson: string
}

export interface LlmCallRequest {
  model: string
  messages: LlmMessage[]
  /** Optional JSON-mode response format (response_format: json_object). */
  jsonMode?: boolean
  /** Optional structured output via JSON Schema. Falls back to json_object on 400. */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  /** Function tools offered to the model for this call. */
  tools?: LlmToolDefinition[]
  /** Tool-choice policy for `tools`. */
  toolChoice?: LlmToolChoice
  temperature?: number
  maxTokens?: number
  /** Ask the provider for the log-probability of each sampled token and its
   *  `topLogprobs` most likely alternatives. Sends `logprobs: true` with
   *  `top_logprobs`. A provider that ignores the field returns
   *  `LlmCallResult.logprobs === null`; nothing is inferred from its absence. */
  logprobs?: { topLogprobs: number }
  /** OpenAI-compatible reasoning mode. Omitted when the provider default should apply. */
  thinking?: LlmThinkingMode
  /** Per-call timeout, default 300s. */
  timeoutMs?: number
}

/** Conservative priced bound for the exact text request sent to a provider.
 * Returns undefined when output or multimodal input is not bounded, causing a
 * capped CostLedger to reject the call before execution. Pass
 * `customTokenPricing` when package pricing does not cover the model or endpoint. */
export interface LlmChargeBounds {
  /** Total physical requests, including retries and schema/temperature fallback. Default 6. */
  maximumAttempts?: number
  /** The transport sends JSON mode instead of a response schema. */
  jsonSchemaTransport?: 'native' | 'json-object'
  /** Default provider reasoning mode the transport applies. */
  thinking?: LlmThinkingMode
  /** Token rates used when the provider omits cost or package pricing does not cover the model. */
  customTokenPricing?: CustomTokenPricing
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** False when the provider omitted or malformed prompt/completion usage. */
  captured?: boolean
  /** Reasoning-token subset of completionTokens, when reported. */
  reasoningTokens?: number
  /** Proxies populate this when prompt caching is on. */
  cachedPromptTokens?: number
}

/** One sampled token with its own log probability and the alternatives the
 *  provider ranked at that position. */
export interface LlmTokenLogprob {
  token: string
  logprob: number
  top: ReadonlyArray<{ token: string; logprob: number }>
}

export interface LlmCallResult {
  /** The text content of the first choice. Empty string if none. */
  content: string
  /** Tool invocations from the first choice, when the model called tools. */
  toolCalls?: LlmToolCall[]
  usage: LlmUsage
  /**
   * Cost in USD. Uses the provider's reported cost when present, otherwise
   * caller-supplied token pricing. `null` when neither is available.
   */
  costUsd: number | null
  /**
   * Model id used for attribution (cost, pricing, log lines). The response's
   * echoed id when the provider sent one, else the requested id.
   *
   * NOT evidence of which model answered — read `servedModel` for that. A
   * provider that omits `model` makes this equal to the request, which is
   * exactly the case an identity check must be able to distinguish.
   */
  model: string
  /**
   * The model id the provider echoed on the response, verbatim; `null` when
   * the body carried none. This is the only field that can witness a gateway
   * substituting a different model for the one requested — compare it with
   * `assertServedModel` / `checkServedModel` (src/integrity/served-model.ts).
   *
   * Optional so hand-built results (mock/custom transports) still typecheck,
   * but omitting it is not a pass: the identity checks read `undefined` as
   * `unreported` and reject it by default. A transport that knows which model
   * answered should say so.
   */
  servedModel?: string | null
  /** Wall-clock duration of the HTTP call (last attempt, if retried). */
  durationMs: number
  /**
   * `finish_reason` echoed from the first choice (`stop`, `length`,
   * `content_filter`, `tool_calls`, ...). `null` when the provider omits it.
   * Exposed so a free-form `callLlm` caller CAN detect a truncated answer
   * (`length`) instead of treating a cut-off completion as complete. Note:
   * `callLlm` does not itself reject on it — acting on this signal is the
   * caller's responsibility (in-repo free-form drivers do not yet enforce it).
   */
  finishReason?: string | null
  /**
   * True when `content.trim()` is empty. An empty completion is a silent zero
   * for free-form `callLlm` callers; this flag is the signal a caller can
   * inspect to fail loud rather than proceed on an empty string. `callLlm`
   * surfaces it but does not throw on it.
   */
  contentEmpty?: boolean
  /**
   * Per-token log probabilities for the first choice, in emission order, when
   * the request asked for them and the provider returned
   * `choices[0].logprobs.content`. `null` when the provider returned none, so a
   * caller can tell "not requested or not supported" from "requested and
   * empty". Absent when the request did not ask for logprobs.
   */
  logprobs?: ReadonlyArray<LlmTokenLogprob> | null
  /** Raw response body. */
  raw: Record<string, unknown>
}

export type LlmCallMetadata = Pick<LlmCallResult, 'usage' | 'costUsd' | 'model' | 'durationMs'>

export interface LlmClientOptions extends LlmChargeBounds {
  /** Base URL (without trailing slash), ending at the `/v1` prefix. Required: there is no default endpoint. */
  baseUrl?: string
  /** Bearer token — either `apiKey` or `bearer` populates `Authorization: Bearer ...`. */
  apiKey?: string
  bearer?: string
  /** Override for the `Authorization` header (e.g. `X-Auth: ...`). Takes precedence over apiKey/bearer. */
  authHeader?: { name: string; value: string }
  /** Stable provider idempotency key, reused across retries of this logical call. */
  idempotencyKey?: string
  /** Default timeout in ms. Per-call can override. */
  defaultTimeoutMs?: number
  /**
   * Minimum milliseconds between physical request starts, including retries.
   * Default 0 (disabled). Share one LlmClient per key, or reuse the same options
   * object with callLlm/callLlmJson, to pace concurrent and sequential calls.
   * Independent options objects and processes do not share a quota.
   */
  minIntervalMs?: number
  /**
   * Caller-supplied abort signal — e.g. a campaign-wide cancel. Linked to
   * each attempt's per-attempt timeout controller, so aborting it cancels
   * the in-flight fetch. A caller abort is FATAL: it is not retried even
   * though an AbortError otherwise matches the transient patterns.
   */
  signal?: AbortSignal
  /**
   * Cross-attempt wall-clock budget in ms, measured from the first attempt.
   * Before launching each attempt the loop checks the remaining budget and
   * stops retrying once it is exhausted, rather than waiting the full
   * per-attempt timeout on every retry. Bounds total time independent of
   * total attempts × `timeoutMs`.
   */
  deadlineMs?: number
  /**
   * JSON payload parsing policy. `extract` accepts fenced or prose-prefixed JSON.
   * `exact` requires the complete response content to be one JSON value.
   * Default: `extract`.
   */
  jsonPayloadMode?: 'extract' | 'exact'
  /** Fetch implementation — defaults to global `fetch`. Override for custom transport (e.g. tests). */
  fetch?: typeof fetch
  /**
   * Optional raw HTTP capture sink. When provided, every request, response,
   * and error (across all retry attempts) is recorded to the sink, with auth
   * headers and credential-shaped body fields redacted by default. This is
   * the layer-1 forensics primitive: structured `LlmSpan`s record intent,
   * raw events record what actually crossed the wire.
   */
  rawSink?: RawProviderSink
  /**
   * Logical provider id attached to raw events. When omitted, derived from
   * `baseUrl` via `providerFromBaseUrl`.
   */
  provider?: string
  /** Trace context attached to raw events; populated by emitter-aware callers. */
  traceContext?: { runId?: string; spanId?: string }
  /** Override the redaction strategy for this call. Defaults to `defaultProviderRedactor`. */
  redactor?: ProviderRedactor
  /**
   * Reject a response whose echoed model is not the model that was requested.
   * A routing gateway can accept one id and answer from another, which
   * silently invalidates every per-model and per-family claim downstream.
   * `true` uses the strict default (aliases pass, substitutions and
   * unidentified responses throw `ModelSubstitutionError`); pass an options
   * object to relax a specific case. Off by default — turning it on for a
   * measurement run is the point.
   */
  assertServedModel?: boolean | AssertServedModelOptions
}
