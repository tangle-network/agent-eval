import type { CustomTokenPricing } from '../cost-ledger'
import { costForTokenPricing } from '../cost-ledger'

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

export interface ExternalOptimizerModelBudget {
  /** Maximum optimizer-model spend, independent of task-evaluation spend. */
  maxCostUsd: number
  /** Network attempts, including provider retries. */
  maxRequests: number
  /** Reject a request body above this byte count. */
  maxRequestBytes: number
  /** Reject a provider response above this byte count. */
  maxResponseBytes: number
  /** Reject a request asking the provider for more output tokens. */
  maxOutputTokensPerRequest: number
  /** Rates used to estimate cost when the provider omits a valid `usage.cost`. */
  pricing: CustomTokenPricing
  /** Per-provider-request deadline. Default: 300,000 ms. */
  requestTimeoutMs?: number
}

export interface ExternalOptimizerModelProxy {
  /** OpenAI-compatible base URL supplied to the optimizer process. */
  baseUrl: string
  /** Ephemeral credential supplied only to the local proxy. */
  apiKey: string
  requests: () => number
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
  if (!Number.isFinite(value.maxCostUsd) || value.maxCostUsd <= 0) {
    throw new Error(`${label}.maxCostUsd must be positive and finite`)
  }
  if (
    value.requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.requestTimeoutMs) || value.requestTimeoutMs <= 0)
  ) {
    throw new Error(`${label}.requestTimeoutMs must be a positive safe integer`)
  }
  costForTokenPricing(value.pricing, { inputTokens: 1, outputTokens: 1 })
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
