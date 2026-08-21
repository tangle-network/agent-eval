/**
 * Provider-neutral chat contract for every model call made by agent-eval.
 *
 * The caller owns model execution. agent-eval issues no provider request and
 * holds no provider credential: `createChatClient` binds a transport the
 * caller supplies, and evaluation code receives canonical requests and results
 * without importing a provider SDK.
 */

import type { LlmCallRequest, LlmCallResult } from '../llm-client'

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

export type CreateChatClientOpts = SandboxSdkTransportOpts | CustomTransportOpts | MockTransportOpts

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
