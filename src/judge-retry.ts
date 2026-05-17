/**
 * Judge-retry wrapper.
 *
 * Today's failure mode: a judge LLM call aborts mid-stream (connection
 * dropped, model timed out, schema rejected) → consumer's try/catch swallows
 * the error and returns `score: 0`. The eval composite then weights that
 * zero into the mean, silently corrupting the score. Today's tax/gtm evals
 * had `judge=0` across every trial — the prompt rewrites couldn't be
 * evaluated honestly because the measurement instrument was broken.
 *
 * `withJudgeRetry` is the substrate fix. It wraps a single judge invocation
 * with:
 *
 *   1. N retry attempts on transient failures (abort, timeout, network).
 *   2. Optional fallback-model rotation — try the next model in the list
 *      if the primary keeps aborting (a verbose new prompt may stream-abort
 *      on claude-code/sonnet but succeed on kimi-code/k2p6).
 *   3. Exponential backoff between attempts.
 *   4. A typed outcome `{ succeeded, attempts, value, error }` that callers
 *      MUST decide what to do with. No silent zero.
 *
 * The reporting contract: callers ship `TrialResult.judgeSucceeded = succeeded`
 * and `TrialResult.judgeAttempts = attempts`. `aggregateTrials({mode: 'exclude-failed'})`
 * then skips failed-judge trials when computing composites.
 *
 * The library does NOT decide what score to record on failure — that's the
 * caller's product choice. Today's product agents (legal/gtm/tax/creative)
 * should set `score: NaN` + `judgeSucceeded: false` + `error: ...` so the
 * aggregator's exclude-failed mode drops the trial. Defaulting to 0 is what
 * caused today's data corruption.
 */

/**
 * Retry policy for judge LLM calls.
 *
 * Defaults are tuned for the verbose post-2yr-rewrite prompts that exceed
 * the 60s `callLlm` default and abort on streaming. Pick a different timeout
 * for cheap-and-quick judges (e.g., 30s) or longer for thinking models.
 */
export interface JudgeRetryPolicy {
  /** Max attempts per model. Default 3 (one initial + two retries). */
  maxAttempts?: number
  /** Per-attempt timeout in ms. Default 90_000 (1.5×agent-eval's 60s default). */
  timeoutMs?: number
  /**
   * Models to try, in order. The first model is the primary; subsequent
   * models are fallbacks invoked only when ALL retries on the previous
   * model have been exhausted. Example: `['claude-code/sonnet', 'kimi-code/k2p6']`
   * runs claude-code up to maxAttempts times, then falls back to kimi.
   * If omitted, the caller's judge function controls model selection and
   * the retries apply to that single model.
   */
  models?: readonly string[]
  /** Exponential backoff function, default `attempt → min(500 * 2^attempt, 16_000)`. */
  backoffMs?: (attempt: number) => number
  /**
   * Predicate deciding whether an error should trigger a retry. Default
   * retries on: AbortError, TimeoutError, `fetch failed`, `ECONNRESET`,
   * `[This operation was aborted]`, and any LlmCallError with status in
   * {429, 502, 503, 504}. JSON-parse errors are NOT retriable (the model
   * needs prompt adjustment, not another shot).
   */
  isRetryable?: (err: unknown) => boolean
}

/** Outcome of a wrapped judge invocation. */
export interface JudgeRetryOutcome<T> {
  /** The judge's returned value when `succeeded === true`. */
  value: T | null
  /** True iff one of the attempts completed without throwing. */
  succeeded: boolean
  /** Total attempts made across all models. */
  attempts: number
  /** Which model the successful attempt used (when succeeded). */
  modelUsed?: string
  /** Last error captured when `succeeded === false`. */
  error?: Error
  /** Per-attempt error log for forensics. */
  attemptErrors: Array<{ attempt: number; model: string; error: string }>
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_BACKOFF = (attempt: number) => Math.min(500 * 2 ** attempt, 16_000)

const ABORT_PATTERNS = [
  /AbortError/i,
  /TimeoutError/i,
  /fetch failed/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /this operation was aborted/i,
  /stream.*ended.*unexpectedly/i,
  /socket hang up/i,
]

const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504])

function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    if (ABORT_PATTERNS.some((p) => p.test(err.message) || p.test(err.name))) return true
    // LlmCallError exposes `status` as a numeric property; check without
    // hard-importing to avoid a circular dep.
    const status = (err as unknown as { status?: number }).status
    if (typeof status === 'number' && RETRYABLE_HTTP_STATUS.has(status)) return true
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wrap a judge call with retry + fallback-model + typed outcome semantics.
 *
 * The `judgeFn` signature is `(model: string, signal: AbortSignal) => Promise<T>`.
 * The signal will be aborted at `timeoutMs`. Callers should pass the signal
 * to their underlying fetch/SDK call so the abort actually fires.
 *
 * Returns a typed outcome — callers MUST inspect `succeeded` before using
 * `value`. The library refuses to default to a silent zero score because that
 * is exactly what caused today's eval data corruption.
 */
export async function withJudgeRetry<T>(
  judgeFn: (model: string, signal: AbortSignal) => Promise<T>,
  policy: JudgeRetryPolicy = {},
): Promise<JudgeRetryOutcome<T>> {
  const maxAttempts = policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const backoff = policy.backoffMs ?? DEFAULT_BACKOFF
  const isRetryable = policy.isRetryable ?? defaultIsRetryable
  const models =
    policy.models && policy.models.length > 0 ? policy.models : [undefined as unknown as string]

  let totalAttempts = 0
  const attemptErrors: JudgeRetryOutcome<T>['attemptErrors'] = []
  let lastError: Error | undefined

  for (const model of models) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      totalAttempts += 1
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('TimeoutError')), timeoutMs)
      try {
        const value = await judgeFn(model as string, controller.signal)
        clearTimeout(timer)
        return {
          value,
          succeeded: true,
          attempts: totalAttempts,
          modelUsed: model,
          attemptErrors,
        }
      } catch (err) {
        clearTimeout(timer)
        const errObj = err instanceof Error ? err : new Error(String(err))
        lastError = errObj
        attemptErrors.push({
          attempt: totalAttempts,
          model: model ?? '(default)',
          error: errObj.message,
        })
        if (!isRetryable(errObj)) {
          // Non-retriable (e.g., JSON parse, schema rejection): break out of
          // attempts on this model AND skip the fallback rotation — a
          // permanent error here will be permanent on the fallback too.
          return {
            value: null,
            succeeded: false,
            attempts: totalAttempts,
            error: errObj,
            attemptErrors,
          }
        }
        if (attempt < maxAttempts - 1) {
          await sleep(backoff(attempt))
        }
      }
    }
    // Exhausted attempts on this model — fall through to next model in the
    // rotation (if any). The backoff between MODEL rotations is the same
    // as the last per-attempt backoff (already slept above).
  }

  return {
    value: null,
    succeeded: false,
    attempts: totalAttempts,
    error: lastError,
    attemptErrors,
  }
}
