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

/**
 * Persona-shaping callbacks. Both are OPTIONAL: when omitted, the loop derives
 * them from the `AgentProfile` + persona payload (see `defaultShapeFromProfile`)
 * so a pure-profile call — `runMultishot({ profile, persona })` — works with no
 * role-builder functions. Provide callbacks only to override the derived shape.
 */
export interface MultishotShape<TPersona extends MultishotPersona> {
  /** Opening user message (turn 0) — the persona's first ask. */
  buildOpener?: (persona: TPersona) => string
  /** System prompt the driver LLM uses to roleplay the persona. Should set
   *  voice, goals, constraints, time-pressure, and the "never go silent" rule. */
  buildDriverSystemPrompt?: (persona: TPersona) => string
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

export class MultishotShotResultError extends Error {
  constructor(reason: string) {
    super(`multishot: shot returned an invalid MultishotResult — ${reason}`)
    this.name = 'MultishotShotResultError'
  }
}

const MULTISHOT_ROLES = new Set(['user', 'assistant', 'tool'])

/** Contract guard for the value a caller-supplied shot resolves with. The
 *  matrix writes per-cell artifacts, builds judge inputs, and meters cost from
 *  this value, so a malformed result must stop the cell instead of scoring a
 *  degraded one. Two silent degradations this closes: an artifact with no
 *  `type` matches neither the code nor the content artifact set, so the cell
 *  scores as though the artifact was never produced; a non-finite `costUsd`
 *  reaches `summary.totalCostUsd` and makes every cost number NaN.
 *
 *  It does NOT protect spend. A rejected cell records `costUsd: 0`, so a shot
 *  that spends before it returns a malformed result leaves that spend out of
 *  the cumulative sum the cost ceiling reads. That is how the matrix records
 *  every failed cell, not something this guard changes.
 *
 *  Every required field of `MultishotMessage` and `MultishotArtifact` is
 *  checked, including `toolCalls` elements and `invocation.args`. Optional
 *  fields are checked only when present. */
export function assertMultishotShotResult(value: unknown): asserts value is MultishotResult {
  if (typeof value !== 'object' || value === null) {
    throw new MultishotShotResultError(`expected an object, received ${describeValue(value)}`)
  }
  const result = value as Record<string, unknown>
  if (!Array.isArray(result.transcript)) {
    throw new MultishotShotResultError(
      `transcript must be an array, received ${describeValue(result.transcript)}`,
    )
  }
  if (!Array.isArray(result.artifacts)) {
    throw new MultishotShotResultError(
      `artifacts must be an array, received ${describeValue(result.artifacts)}`,
    )
  }
  result.transcript.forEach(assertMessage)
  result.artifacts.forEach(assertArtifact)
  assertFiniteCount(result.toolCalls, 'toolCalls')
  assertFiniteCount(result.durationMs, 'durationMs')
  assertFiniteCount(result.costUsd, 'costUsd')
}

function assertMessage(value: unknown, index: number): void {
  const row = requireRow(value, `transcript[${index}]`)
  if (typeof row.role !== 'string' || !MULTISHOT_ROLES.has(row.role)) {
    throw new MultishotShotResultError(
      `transcript[${index}].role must be user, assistant or tool, received ${describeValue(row.role)}`,
    )
  }
  assertString(row.content, `transcript[${index}].content`)
  if (row.toolCallId !== undefined) {
    assertString(row.toolCallId, `transcript[${index}].toolCallId`)
  }
  if (row.toolCalls === undefined) return
  if (!Array.isArray(row.toolCalls)) {
    throw new MultishotShotResultError(
      `transcript[${index}].toolCalls must be an array when present, received ${describeValue(row.toolCalls)}`,
    )
  }
  row.toolCalls.forEach((call, callIndex) => {
    const field = `transcript[${index}].toolCalls[${callIndex}]`
    const row = requireRow(call, field)
    assertString(row.id, `${field}.id`)
    assertString(row.name, `${field}.name`)
    requireRow(row.args, `${field}.args`)
  })
}

function assertArtifact(value: unknown, index: number): void {
  const row = requireRow(value, `artifacts[${index}]`)
  assertString(row.type, `artifacts[${index}].type`)
  assertString(row.content, `artifacts[${index}].content`)
  assertFiniteCount(row.turn, `artifacts[${index}].turn`)
  const invocation = requireRow(row.invocation, `artifacts[${index}].invocation`)
  assertString(invocation.name, `artifacts[${index}].invocation.name`)
  requireRow(invocation.args, `artifacts[${index}].invocation.args`)
}

function requireRow(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MultishotShotResultError(
      `${field} must be an object, received ${describeValue(value)}`,
    )
  }
  return value as Record<string, unknown>
}

function assertString(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    throw new MultishotShotResultError(
      `${field} must be a string, received ${describeValue(value)}`,
    )
  }
}

function assertFiniteCount(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new MultishotShotResultError(
      `${field} must be a finite number >= 0, received ${describeValue(value)}`,
    )
  }
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `${typeof value} ${String(value)}`
}
