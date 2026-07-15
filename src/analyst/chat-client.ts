/**
 * ChatClient — the single LLM abstraction analysts call.
 *
 * agent-eval already ships an `LlmClient` (OpenAI-compatible, retry,
 * graceful JSON-schema degrade) and judges that talk to `TCloud`. Two
 * mixed patterns force every analyst author to pick a transport, which
 * couples analyst code to runtime concerns (cli-bridge vs router vs
 * sandbox-sdk) it shouldn't know about.
 *
 * `ChatClient` is one interface every analyst takes via `AnalystContext.chat`.
 * The operator decides at the registry boundary which transport binds
 * to it. Analyst code stays transport-agnostic; swapping production
 * (sandbox-sdk) for local dev (cli-bridge) or tests (mock) is a one-
 * line factory call.
 *
 * Designed to coexist: existing `LlmClient` callers and existing
 * `TCloud`-based judges keep working untouched. New analyst code uses
 * `ChatClient`. When old call sites migrate, they pick up budgeting,
 * cancellation, and unified telemetry for free.
 */

import {
  type LlmCallRequest,
  type LlmCallResult,
  LlmClient,
  type LlmClientOptions,
} from '../llm-client'

/**
 * Unified chat interface. Mirrors LlmCallRequest/Result so the OpenAI-
 * compatible mental model stays. Two methods: a one-shot `chat()` and
 * an `streamChat()` for future agentic loops (not yet exposed).
 */
export interface ChatClient {
  /** Display name of the bound transport — included in telemetry. */
  readonly transport: ChatTransport
  /** Default model when caller omits — operators bind this per environment. */
  readonly defaultModel?: string
  /** Total provider attempts this transport can make for one chat call. */
  readonly maximumAttempts?: number

  /** Implementations must enforce `req.maxTokens` when it is present. */
  chat(req: ChatRequest, opts?: ChatCallOpts): Promise<ChatResponse>
}

export type ChatTransport =
  | 'router' // router.tangle.tools — production paid models
  | 'sandbox-sdk' // box.streamPrompt() — chat completion via sandbox SDK
  | 'cli-bridge' // local cli-bridge for dev / local-only runs
  | 'direct-provider' // direct OpenAI / Anthropic / etc. — bypass router
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
  | RouterTransportOpts
  | CliBridgeTransportOpts
  | DirectProviderTransportOpts
  | SandboxSdkTransportOpts
  | MockTransportOpts

interface BaseTransportOpts {
  defaultModel?: string
  /** Total provider attempts. Required for opaque transports used in capped runs. */
  maximumAttempts?: number
}

export interface RouterTransportOpts extends BaseTransportOpts {
  transport: 'router'
  baseUrl?: string
  apiKey: string
}

export interface CliBridgeTransportOpts extends BaseTransportOpts {
  transport: 'cli-bridge'
  baseUrl?: string
  bearer?: string
}

export interface DirectProviderTransportOpts extends BaseTransportOpts {
  transport: 'direct-provider'
  baseUrl: string
  apiKey: string
}

/**
 * Sandbox-SDK transport. Provided as a thin pass-through: the caller
 * supplies a callable that mimics LlmClient.chat() against an already-
 * configured Sandbox handle. We don't import the SDK here to keep
 * agent-eval dep-free of @tangle-network/sandbox.
 */
export interface SandboxSdkTransportOpts extends BaseTransportOpts {
  transport: 'sandbox-sdk'
  chat: (req: ChatRequest, opts?: ChatCallOpts) => Promise<ChatResponse>
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
    case 'router':
      return wrapLlmClient(
        opts.transport,
        opts.defaultModel,
        new LlmClient({
          baseUrl: opts.baseUrl ?? 'https://router.tangle.tools/v1',
          apiKey: opts.apiKey,
          maxRetries: opts.maximumAttempts,
        } as LlmClientOptions),
      )
    case 'cli-bridge':
      return wrapLlmClient(
        opts.transport,
        opts.defaultModel,
        new LlmClient({
          baseUrl: opts.baseUrl ?? 'http://127.0.0.1:3344/v1',
          apiKey: opts.bearer ?? '',
          maxRetries: opts.maximumAttempts,
        } as LlmClientOptions),
      )
    case 'direct-provider':
      return wrapLlmClient(
        opts.transport,
        opts.defaultModel,
        new LlmClient({
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          maxRetries: opts.maximumAttempts,
        } as LlmClientOptions),
      )
    case 'sandbox-sdk':
      return {
        transport: 'sandbox-sdk',
        defaultModel: opts.defaultModel,
        maximumAttempts: opts.maximumAttempts,
        chat: async (req, callOpts) => opts.chat(resolveModel(req, opts.defaultModel), callOpts),
      }
    case 'mock':
      return {
        transport: 'mock',
        defaultModel: opts.defaultModel,
        maximumAttempts: 1,
        chat: async (req, callOpts) => opts.handler(resolveModel(req, opts.defaultModel), callOpts),
      }
  }
}

function wrapLlmClient(
  transport: ChatTransport,
  defaultModel: string | undefined,
  inner: LlmClient,
): ChatClient {
  return {
    transport,
    defaultModel,
    maximumAttempts: inner.maximumAttempts,
    chat: (req, callOpts) => {
      const resolved = resolveModel(req, defaultModel)
      const request: LlmCallRequest = {
        model: resolved.model!,
        messages: req.messages,
        jsonMode: req.jsonMode,
        jsonSchema: req.jsonSchema,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        timeoutMs: req.timeoutMs,
      }
      return inner.call(request, {
        signal: callOpts?.signal,
        idempotencyKey: callOpts?.idempotencyKey,
      })
    },
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
