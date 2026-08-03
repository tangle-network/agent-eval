import type { CustomTokenPricing } from '../cost-ledger'
import { costForTokenPricing } from '../cost-ledger'

const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface ExternalOptimizerRunnerCommand {
  command?: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
}

export type ExternalOptimizerResumeMode = 'never' | 'if-compatible' | 'required'

export type ExternalTextCandidate = string | Record<string, string>

export interface ExternalTextEvaluationRequest {
  candidate: ExternalTextCandidate
  exampleId: string
}

export interface ExternalOptimizerCallback {
  url: string
  token: string
  evaluations: () => number
  close: () => Promise<void>
}

/** One exact model request admitted by the loopback proxy. */
export interface ExternalOptimizerModelCallRequest {
  readonly path: '/v1/chat/completions' | '/v1/responses'
  readonly model: string
  readonly body: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
}

/** Runtime-owned result for one admitted optimizer-model call. */
export type ExternalOptimizerModelCallResult =
  | {
      readonly succeeded: true
      /** OpenAI-compatible response forwarded unchanged to the optimizer process. */
      readonly response: Response
      /** Canonical measured usage/cost input retained by Agent Eval's cost ledger. */
      readonly receipt: import('../cost-ledger').CostReceiptInput
      /** Opaque, finite JSON proof of the exact execution retained in provenance. */
      readonly execution: unknown
    }
  | {
      readonly succeeded: false
      /** Public failure text safe to retain and return to the child process. */
      readonly error: string
      /** Usage/cost state for the failed Runtime call. Unknown values stay unknown. */
      readonly receipt: import('../cost-ledger').CostReceiptInput
      /** Opaque, finite JSON proof of the failed exact execution. */
      readonly execution: unknown
    }

/**
 * Execution-neutral model-call seam for an external optimizer.
 *
 * The package that owns execution implements this with its exact execution
 * path. For Discovery that owner is Runtime and the identity is an
 * AgentProfile. The loopback proxy owns request validation, limits, response
 * bounds, and cost-ledger recording. Once invoked, the callback must resolve
 * with one success/failure result. Rejecting loses the execution record and
 * therefore fails the optimizer attempt.
 */
export type ExternalOptimizerModelCall = (
  request: ExternalOptimizerModelCallRequest,
) => Promise<ExternalOptimizerModelCallResult>

/** One opaque Runtime execution record retained for one admitted model call. */
export type ExternalOptimizerModelExecutionObservation =
  | {
      readonly sequence: number
      readonly callRef: string
      readonly path: ExternalOptimizerModelCallRequest['path']
      readonly model: string
      readonly succeeded: true
      readonly responseStatus: number
      readonly execution: unknown
    }
  | {
      readonly sequence: number
      readonly callRef: string
      readonly path: ExternalOptimizerModelCallRequest['path']
      readonly model: string
      readonly succeeded: false
      readonly error: string
      readonly execution: unknown
    }

export type ExternalOptimizerEvaluationRefusalReason =
  | 'invalid-request'
  | 'evaluation-limit'
  | 'evaluation-failed'

/**
 * Durable callback-side record of every candidate submitted for scoring,
 * scored task, and callback refusal. Optimizer-internal proposals that never
 * reach this callback are outside this record's scope.
 */
export type ExternalOptimizerEvaluationObservation =
  | {
      readonly kind: 'proposal'
      readonly sequence: number
      readonly candidate: ExternalTextCandidate
      readonly candidateHash: string
    }
  | {
      readonly kind: 'evaluation'
      readonly sequence: number
      readonly candidate: ExternalTextCandidate
      readonly candidateHash: string
      readonly exampleId: string
      /** One-based accepted evaluation number for this optimizer attempt. */
      readonly evaluationNumber: number
      readonly response: unknown
    }
  | {
      readonly kind: 'refusal'
      readonly sequence: number
      readonly reason: ExternalOptimizerEvaluationRefusalReason
      readonly candidate?: ExternalTextCandidate
      readonly candidateHash?: string
      readonly exampleId?: string
    }

export interface ExternalOptimizerModelBudget {
  /** Optional optimizer-model spend ceiling, independent of task-evaluation spend. */
  maxCostUsd?: number
  /** Maximum calls into the execution owner; owner-internal retries are reported there. */
  maxRequests: number
  /** Reject a request body above this byte count. */
  maxRequestBytes: number
  /** Reject a provider response above this byte count. */
  maxResponseBytes: number
  /** Reject a request asking the provider for more output tokens. */
  maxOutputTokensPerRequest: number
  /**
   * Reasoning tokens a single response may bill beyond its completion limit.
   *
   * A reasoning model bounds only the completion by `max_tokens` and bills
   * thinking on top, so a reservation sized to the completion alone is always
   * too small and the ledger refuses the real charge. Callers that route a
   * reasoning model declare its thinking budget here; the reservation covers
   * it and a response exceeding it still fails loudly. Default: 0.
   */
  maxReasoningTokensPerRequest?: number
  /**
   * Optional rates used to estimate cost when the provider omits a valid
   * `usage.cost`. Omit when billed USD is unknown; catalog estimates are not
   * enforcement evidence.
   */
  pricing?: CustomTokenPricing
  /** Per-provider-request deadline. Default: 300,000 ms. */
  requestTimeoutMs?: number
}

export interface ExternalOptimizerModelProxy {
  /** OpenAI-compatible base URL supplied to the optimizer process. */
  baseUrl: string
  /** Ephemeral credential supplied only to the local proxy. */
  apiKey: string
  /** Execution-owner calls admitted during this proxy process, including failures. */
  requestAttempts: () => number
  /** Successful 2xx responses recorded during this proxy process. */
  successfulCompletions: () => number
  /** Fail if an invoked caller-owned model path omitted its execution record. */
  assertExecutionComplete: () => void
  close: () => Promise<void>
}

export function isCandidateText(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars
}

export function isExternalTextCandidate(value: unknown): value is ExternalTextCandidate {
  if (typeof value === 'string') return value.trim().length > 0
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length > 0 &&
    entries.every(
      ([name, content]) =>
        name.trim().length > 0 && name.trim() === name && typeof content === 'string',
    )
  )
}

export function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${label} must be JSON-serializable`)
    seen.add(value)
    for (const item of value) assertJsonValue(item, label, seen)
    seen.delete(value)
    return
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error(`${label} must be JSON-serializable`)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must be JSON-serializable`)
    }
    seen.add(value)
    for (const item of Object.values(value)) assertJsonValue(item, label, seen)
    seen.delete(value)
    return
  }
  throw new Error(`${label} must be JSON-serializable`)
}

export function assertNoCredentialValues(
  value: unknown,
  path: string,
  credentialLocation = 'runner.env',
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoCredentialValues(item, `${path}[${index}]`, credentialLocation)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (isCredentialKey(key)) {
      throw new Error(`${path}.${key} must be supplied through ${credentialLocation}`)
    }
    assertNoCredentialValues(item, `${path}.${key}`, credentialLocation)
  }
}

export function removeCredentialEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !isCredentialKey(key)) sanitized[key] = value
  }
  return sanitized
}

export function assertExternalOptimizerModelBudget(
  value: ExternalOptimizerModelBudget,
  label: string,
): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} is required`)
  }
  for (const [field, entry] of [
    ['maxRequests', value.maxRequests],
    ['maxRequestBytes', value.maxRequestBytes],
    ['maxResponseBytes', value.maxResponseBytes],
    ['maxOutputTokensPerRequest', value.maxOutputTokensPerRequest],
  ] as const) {
    if (!Number.isSafeInteger(entry) || entry <= 0) {
      throw new Error(`${label}.${field} must be a positive safe integer`)
    }
  }
  if (
    value.maxReasoningTokensPerRequest !== undefined &&
    (!Number.isSafeInteger(value.maxReasoningTokensPerRequest) ||
      value.maxReasoningTokensPerRequest < 0)
  ) {
    throw new Error(`${label}.maxReasoningTokensPerRequest must be a non-negative safe integer`)
  }
  if (
    value.maxCostUsd !== undefined &&
    (!Number.isFinite(value.maxCostUsd) || value.maxCostUsd <= 0)
  ) {
    throw new Error(`${label}.maxCostUsd must be positive and finite when supplied`)
  }
  if (
    value.requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.requestTimeoutMs) ||
      value.requestTimeoutMs <= 0 ||
      value.requestTimeoutMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new Error(`${label}.requestTimeoutMs must be between 1 and ${MAX_TIMER_DELAY_MS}`)
  }
  if (value.pricing !== undefined) {
    costForTokenPricing(value.pricing, { inputTokens: 1, outputTokens: 1 })
  }
  if (value.maxCostUsd !== undefined && value.pricing === undefined) {
    throw new Error(`${label}.pricing is required when maxCostUsd is supplied`)
  }
}

export function safePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function isCredentialKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
  const segments = normalized.split('_')
  return segments.some((segment) =>
    [
      'auth',
      'authorization',
      'cookie',
      'credential',
      'credentials',
      'key',
      'password',
      'secret',
      'session',
      'token',
    ].includes(segment),
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
