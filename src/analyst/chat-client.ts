/**
 * Provider-neutral chat contract for every model call made by agent-eval.
 *
 * The caller owns model execution. Evaluation code receives canonical requests
 * and results without importing a provider SDK, and agent-eval reads no
 * environment variable to find a provider credential: every transport is bound
 * at the call site.
 *
 * Two ways to bind one. `custom` and `sandbox-sdk` take a `chat` function the
 * caller wrote. `openai-compatible` takes an endpoint and a credential the
 * caller passes as values, and agent-eval issues the HTTP request itself.
 *
 * WHY THE THIRD ONE EXISTS. Every consumer that wanted a plain OpenAI-style
 * endpoint had to hand-write the same fetch loop — retry on 429 and 5xx,
 * `json_schema` degrade, fenced-JSON stripping, and, load-bearing here, the
 * `servedModel` echo that `assertServedModel` and `assertCrossFamilyServed`
 * read. A hand-written transport that omits `servedModel` makes both identity
 * checks read `unreported`, so the two-vendor judge rule they enforce silently
 * measures nothing. Measured motive: agent-eval 0.172.1 exported no such
 * transport, so a two-model judge panel in discovery-lab reached
 * `createChatClient({ transport: 'custom', baseUrl, apiKey })` — fields that
 * exist on no transport option — and every call threw
 * `TypeError: opts.chat is not a function`, which surfaced as
 * `aggregateJudgeVerdicts: all 2 judges failed`.
 *
 * The credential still never comes from agent-eval's environment. `baseUrl`
 * and the bearer are required arguments with no default and no fallback, so a
 * misconfigured caller gets a refusal at construction, never a call to an
 * endpoint it did not name.
 */

import {
  type LlmCallRequest,
  type LlmCallResult,
  LlmClient,
  type LlmClientOptions,
} from '../llm-client'

/**
 * Unified chat interface using the package's canonical LLM request and result.
 */
export interface ChatClient {
  /** Display name of the bound transport, included in telemetry. */
  readonly transport: ChatTransport
  /** Default model when the caller omits one. */
  readonly defaultModel?: string
  /** Total provider attempts this transport can make for one chat call. */
  readonly maximumAttempts?: number

  /** Implementations must enforce `req.maxTokens` when it is present. */
  chat(req: ChatRequest, opts?: ChatCallOpts): Promise<ChatResponse>
}

export type ChatTransport =
  | 'sandbox-sdk' // box.streamPrompt() — chat completion via sandbox SDK
  | 'custom' // caller-adapted SDK or transport
  | 'openai-compatible' // caller-named /v1 endpoint, driven by this package
  | 'mock' // test-time injection

export interface ChatRequest extends Omit<LlmCallRequest, 'model'> {
  /** Optional — falls back to ChatClient.defaultModel. */
  model?: string
}

export type ChatResponse = LlmCallResult

export interface ChatCallOpts {
  /** Cancel the in-flight request. */
  signal?: AbortSignal
  /** Hard USD ceiling for this single call (informational; the underlying transport may not enforce). */
  maxCostUsd?: number
  /** Correlation tag carried into request headers when the transport allows. */
  correlationId?: string
  /** Stable provider idempotency key for retries/redrives of one paid call. */
  idempotencyKey?: string
}

// ── Factory ─────────────────────────────────────────────────────────

export type CreateChatClientOpts =
  | SandboxSdkTransportOpts
  | CustomTransportOpts
  | OpenAiCompatibleTransportOpts
  | MockTransportOpts

interface BaseTransportOpts {
  defaultModel?: string
  /** Total provider attempts. Required for opaque transports used in capped runs. */
  maximumAttempts?: number
}

/**
 * Sandbox-SDK transport. The caller supplies a canonical chat function for an
 * already-configured Sandbox handle, so agent-eval does not import the SDK.
 */
export interface SandboxSdkTransportOpts extends BaseTransportOpts {
  transport: 'sandbox-sdk'
  chat: (req: ChatRequest, opts?: ChatCallOpts) => Promise<ChatResponse>
}

/** Caller-adapted SDK or transport returning the canonical ChatResponse shape. */
export interface CustomTransportOpts extends BaseTransportOpts {
  transport: 'custom'
  chat: (req: ChatRequest, opts?: ChatCallOpts) => Promise<ChatResponse>
}

/**
 * OpenAI-compatible HTTP transport: the caller names a `/v1` endpoint and
 * hands over a bearer, and this package drives `POST {baseUrl}/chat/completions`.
 *
 * Use this instead of hand-rolling a `custom` transport around `fetch`. The
 * result carries `servedModel` — the model id the provider echoed, verbatim —
 * which is the only field `assertServedModel` and `assertCrossFamilyServed`
 * can read to witness a gateway answering from a different model than the one
 * requested.
 *
 * `baseUrl` ends at the `/v1` prefix; the `/chat/completions` path is this
 * package's to append. A `baseUrl` that already carries the path is a
 * construction error, not a request to a doubled URL.
 *
 * Exactly one credential form is required — `apiKey`, `bearer`, or
 * `authHeader`. There is no environment fallback: agent-eval never goes
 * looking for a key.
 */
export interface OpenAiCompatibleTransportOpts
  extends BaseTransportOpts,
    Pick<
      LlmClientOptions,
      | 'assertServedModel'
      | 'customTokenPricing'
      | 'deadlineMs'
      | 'defaultTimeoutMs'
      | 'fetch'
      | 'jsonPayloadMode'
      | 'jsonSchemaTransport'
      | 'provider'
      | 'rawSink'
      | 'signal'
      | 'thinking'
    > {
  transport: 'openai-compatible'
  /** Endpoint ending at the `/v1` prefix. Required — there is no default endpoint. */
  baseUrl: string
  /** Bearer credential. One of `apiKey`, `bearer`, or `authHeader` is required. */
  apiKey?: string
  /** Bearer credential, alternate spelling. */
  bearer?: string
  /** Non-bearer authorization header, for endpoints that want their own scheme. */
  authHeader?: { name: string; value: string }
}

/**
 * Mock transport for tests. The handler receives the request and returns
 * whatever the test wants. No retries, no JSON-schema degrade.
 */
export interface MockTransportOpts extends BaseTransportOpts {
  transport: 'mock'
  handler: (req: ChatRequest, opts?: ChatCallOpts) => Promise<ChatResponse>
}

/**
 * Build a ChatClient bound to a specific transport. The returned client
 * is safe to share across analysts in a single registry run.
 */
export function createChatClient(opts: CreateChatClientOpts): ChatClient {
  switch (opts.transport) {
    case 'sandbox-sdk':
      return {
        transport: 'sandbox-sdk',
        defaultModel: opts.defaultModel,
        maximumAttempts: opts.maximumAttempts,
        chat: async (req, callOpts) => opts.chat(resolveModel(req, opts.defaultModel), callOpts),
      }
    case 'custom':
      return {
        transport: 'custom',
        defaultModel: opts.defaultModel,
        maximumAttempts: opts.maximumAttempts,
        chat: async (req, callOpts) => opts.chat(resolveModel(req, opts.defaultModel), callOpts),
      }
    case 'openai-compatible':
      return openAiCompatibleClient(opts)
    case 'mock':
      return {
        transport: 'mock',
        defaultModel: opts.defaultModel,
        maximumAttempts: 1,
        chat: async (req, callOpts) => opts.handler(resolveModel(req, opts.defaultModel), callOpts),
      }
  }
}

function resolveModel(req: ChatRequest, defaultModel: string | undefined): ChatRequest {
  if (req.model) return req
  if (!defaultModel) {
    throw new Error(
      'ChatClient.chat: no model on request and no defaultModel on the client. ' +
        'Either pass req.model or bind defaultModel at createChatClient().',
    )
  }
  return { ...req, model: defaultModel }
}

/**
 * Build the OpenAI-compatible client, refusing a half-configured one first.
 *
 * Both refusals are construction-time on purpose. A missing credential or a
 * doubled path is a caller mistake that a request would turn into a 401 or a
 * 404 from an endpoint the caller did not intend to reach — the failure then
 * reads as a provider problem instead of a configuration one.
 */
function openAiCompatibleClient(opts: OpenAiCompatibleTransportOpts): ChatClient {
  const baseUrl = opts.baseUrl?.trim().replace(/\/+$/, '') ?? ''
  if (!baseUrl) {
    throw new Error(
      "createChatClient({ transport: 'openai-compatible' }): baseUrl is required and has no default.",
    )
  }
  if (/\/chat\/completions$/.test(baseUrl)) {
    throw new Error(
      "createChatClient({ transport: 'openai-compatible' }): baseUrl ends at the /v1 prefix; " +
        `this package appends /chat/completions. Got ${baseUrl}`,
    )
  }
  if (!opts.apiKey?.trim() && !opts.bearer?.trim() && !opts.authHeader) {
    throw new Error(
      "createChatClient({ transport: 'openai-compatible' }): one of apiKey, bearer, or authHeader " +
        'is required. agent-eval reads no environment variable for a credential.',
    )
  }

  const clientOptions: LlmClientOptions = {
    baseUrl,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.bearer ? { bearer: opts.bearer } : {}),
    ...(opts.authHeader ? { authHeader: opts.authHeader } : {}),
    ...(opts.maximumAttempts === undefined ? {} : { maximumAttempts: opts.maximumAttempts }),
    ...(opts.assertServedModel === undefined ? {} : { assertServedModel: opts.assertServedModel }),
    ...(opts.customTokenPricing === undefined
      ? {}
      : { customTokenPricing: opts.customTokenPricing }),
    ...(opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }),
    ...(opts.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: opts.defaultTimeoutMs }),
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    ...(opts.jsonPayloadMode === undefined ? {} : { jsonPayloadMode: opts.jsonPayloadMode }),
    ...(opts.jsonSchemaTransport === undefined
      ? {}
      : { jsonSchemaTransport: opts.jsonSchemaTransport }),
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.rawSink === undefined ? {} : { rawSink: opts.rawSink }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.thinking === undefined ? {} : { thinking: opts.thinking }),
  }
  const client = new LlmClient(clientOptions)

  return {
    transport: 'openai-compatible',
    ...(opts.defaultModel ? { defaultModel: opts.defaultModel } : {}),
    maximumAttempts: client.maximumAttempts,
    chat: async (req, callOpts) => {
      const resolved = resolveModel(req, opts.defaultModel)
      return client.call(resolved as LlmCallRequest, {
        ...(callOpts?.signal ? { signal: callOpts.signal } : {}),
        ...(callOpts?.idempotencyKey ? { idempotencyKey: callOpts.idempotencyKey } : {}),
      })
    },
  }
}
