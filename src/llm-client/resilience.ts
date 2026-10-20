import type { LlmClientOptions } from './contract'
import { LlmCallError } from './errors'

// ─── Internals ──────────────────────────────────────────────────────────

// Flagship / reasoning models routinely take several minutes on large prompts (a
// reflection over many failures, a long tool transcript). A tight cap aborts a
// legitimately-slow but healthy call — and because every retry attempt re-uses
// the same window, such a model aborts on ALL attempts and the loop throws. The
// default is generous enough to let those complete, bounded enough that a truly
// hung call still fails over after retries, and tunable per deployment via
// TANGLE_LLM_TIMEOUT_MS. Per-call `req.timeoutMs` / `opts.defaultTimeoutMs`
// still win for callers that know their model's latency.
export const DEFAULT_TIMEOUT_MS = Number(process.env.TANGLE_LLM_TIMEOUT_MS) || 300_000

const DEFAULT_MAXIMUM_ATTEMPTS =
  process.env.TANGLE_LLM_MAXIMUM_ATTEMPTS === undefined
    ? 6
    : Number(process.env.TANGLE_LLM_MAXIMUM_ATTEMPTS)

export function resolveMaximumAttempts(configured: number | undefined): number {
  const attempts = configured ?? DEFAULT_MAXIMUM_ATTEMPTS
  if (!Number.isInteger(attempts) || attempts <= 0) {
    throw new RangeError('LLM maximum attempts must be a positive integer')
  }
  return attempts
}

export function resolveMinIntervalMs(configured: number | undefined): number {
  const interval = configured ?? 0
  if (!Number.isFinite(interval) || interval < 0) {
    throw new RangeError('LLM minIntervalMs must be a finite non-negative number')
  }
  return interval
}

// Weak keys avoid retaining credentials or completed campaigns. LlmClient binds
// its per-call option copies to the same state as its constructor options.
export const pacingStates = new WeakMap<LlmClientOptions, { lastStartedAt?: number }>()

export function pacingStateFor(opts: LlmClientOptions): { lastStartedAt?: number } {
  let state = pacingStates.get(opts)
  if (!state) {
    state = {}
    pacingStates.set(opts, state)
  }
  return state
}

// 522/524: Cloudflare edge timeouts (origin connect/respond) — transient
// exactly like 504. Router deployments serve through Cloudflare, so a long
// non-streaming call can draw these from the edge, not the origin.
export const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 522, 524])

/**
 * Transient transport/network error signatures, matched against an error's
 * name, message, and `code`. Covers fetch/undici network failures, aborts
 * and timeouts, and — critically — HTTP/2 transport faults a keep-alive
 * connection raises mid-response: `terminated`, `NGHTTP2_INTERNAL_ERROR`,
 * `UND_ERR_*`, `other side closed`. Those last ones carry no clean HTTP
 * status; unrecognised, they escape the retry loop and surface as an
 * uncaught rejection.
 */
const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /AbortError/i,
  /TimeoutError/i,
  /this operation was aborted/i,
  /fetch failed/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /stream.*ended.*unexpectedly/i,
  /terminated/i,
  /other side closed/i,
  /NGHTTP2/i,
  /UND_ERR/i,
]

/**
 * True when an error is a transient transport/network fault worth retrying,
 * as opposed to a deterministic failure (4xx schema reject, JSON parse) that
 * a retry cannot fix. Inspects `LlmCallError.status`, then the error's
 * name/message/code, then recurses into `error.cause` — undici nests the
 * real socket fault one or more levels under `.cause`.
 *
 * This is the retry classifier for the package: `callLlm` and
 * `withJudgeRetry` both route through it, so connection failures are treated
 * consistently across transports.
 */
export function isTransientLlmError(err: unknown): boolean {
  return classifyTransient(err, 0)
}

function classifyTransient(err: unknown, depth: number): boolean {
  if (err instanceof LlmCallError) return RETRYABLE_STATUS.has(err.status)
  if (!(err instanceof Error)) return false
  // Foreign transport errors can carry a numeric HTTP status without being an
  // LlmCallError. A retryable status is decisive.
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) return true
  const code = (err as { code?: unknown }).code
  const haystack = `${err.name}\n${err.message}\n${typeof code === 'string' ? code : ''}`
  if (TRANSIENT_ERROR_PATTERNS.some((p) => p.test(haystack))) return true
  const cause = (err as { cause?: unknown }).cause
  if (depth < 4 && cause instanceof Error && cause !== err) {
    return classifyTransient(cause, depth + 1)
  }
  return false
}

export function parseRetryAfter(headers: Headers): number | null {
  const h = headers.get('retry-after')?.trim()
  if (!h) return null
  const asNumber = Number(h)
  if (!Number.isNaN(asNumber)) {
    const delay = asNumber * 1000
    return Number.isFinite(delay) && delay >= 0 ? delay : null
  }
  const asDate = Date.parse(h)
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now())
  return null
}

/** Exponential backoff: 500ms, 1s, 2s, 4s, ... capped at 16s. Attempt is 0-indexed. */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 16_000)
}

/** Backoff belongs to the caller's operation and must stop when it is cancelled. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // A timer above the signed 32-bit limit becomes a near-immediate timeout.
  // Split long server delays rather than truncating Retry-After or overflowing.
  do {
    signal?.throwIfAborted()
    const chunk = Math.min(Math.ceil(ms), 2_147_483_647)
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(signal?.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, chunk)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    ms -= chunk
  } while (ms > 0)
}

/** True once the cross-attempt wall-clock budget (if any) is exhausted. */
export function deadlineExceeded(start: number, deadlineMs: number | undefined): boolean {
  return deadlineMs != null && Date.now() - start >= deadlineMs
}
