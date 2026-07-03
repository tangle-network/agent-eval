// Public types for the multishot substrate.

export interface MultishotMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
}

export interface MultishotArtifact {
  type: string
  turn: number
  invocation: { name: string; args: Record<string, unknown> }
  content: string
}

export interface MultishotResult {
  transcript: MultishotMessage[]
  artifacts: MultishotArtifact[]
  toolCalls: number
  durationMs: number
  costUsd: number
}

export interface MultishotToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One chat-completion request the multishot loop issues for a single agent
 *  (or driver) inference step. Mirrors the OpenAI-compat body the loop would
 *  otherwise POST to the Tangle router. */
export interface MultishotTransportRequest {
  model: string
  messages: Array<Record<string, unknown>>
  tools?: MultishotToolDefinition[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface MultishotTransportToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface MultishotTransportResponse {
  message: { content?: string | null; tool_calls?: MultishotTransportToolCall[] }
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  /** Actual spend for this call. When omitted, the loop meters cost from
   *  `usage` via the per-model router estimator (estimateRouterCost). */
  costUsd?: number
}

/** Execution seam for one leg of the multishot loop. When provided, it
 *  replaces the internal router HTTP call for that leg — the loop still owns
 *  turn scheduling, tool dispatch, transcript capture, and cost metering.
 *  agent-eval has no dependency on agent-runtime; adapt agent-runtime's
 *  resolveAgentBackend (or any sandbox/cli-bridge/router client) into this
 *  signature product-side. */
export type MultishotTransport = (
  req: MultishotTransportRequest,
) => Promise<MultishotTransportResponse>

export type MultishotToolExecutor = (
  args: Record<string, unknown>,
  ctx: { apiKey: string; baseUrl: string; signal?: AbortSignal },
) => Promise<{ content: string; costUsd: number }>

export interface MultishotPersona {
  /** Stable identifier — used for per-cell artifact paths + matrix axis keys. */
  id: string
  /** Per-domain payload (income/profile/voice/etc.) shaped by the consumer. */
  [k: string]: unknown
}

export interface MultishotShape<TPersona extends MultishotPersona> {
  /** Opening user message (turn 0) — the persona's first ask. */
  buildOpener: (persona: TPersona) => string
  /** System prompt the driver LLM uses to roleplay the persona. Should set
   *  voice, goals, constraints, time-pressure, and the "never go silent" rule. */
  buildDriverSystemPrompt: (persona: TPersona) => string
}

export class MultishotDriverEmptyError extends Error {
  constructor(public readonly turn: number) {
    super(`multishot: driver returned empty content twice at turn ${turn} — failing loud`)
    this.name = 'MultishotDriverEmptyError'
  }
}

export class MultishotFatalToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultishotFatalToolError'
  }
}
