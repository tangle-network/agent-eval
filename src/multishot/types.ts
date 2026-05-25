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
