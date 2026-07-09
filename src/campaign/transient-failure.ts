/**
 * Transient-transport-failure classification for dispatch retry policies.
 *
 * When an eval cell dies, the harness must decide: retry (the infrastructure
 * hiccuped - a 502 storm, an admission-queue rejection, a dropped stream) or
 * score it (the agent genuinely failed). Getting this wrong corrupts results
 * in both directions: scoring transport hiccups as failures buries real
 * effects under noise (agent-lab R353 found 5/30 identical repeats were 502s
 * scored as task failures), while retrying genuine failures silently drops
 * the hard cells and inflates every arm.
 *
 * Full-duration timeouts are the deliberate knob: on saturated shared
 * infrastructure a timeout usually means the request never got a slot
 * (retry it), but on unthrottled infrastructure it means the agent flailed
 * on the task until the clock ran out (a real score-0). Both readings were
 * needed in practice within one week, so the classifier takes it as an
 * option instead of hardcoding either.
 */

export interface TransientFailureOptions {
  /**
   * Treat full-duration timeouts ("timeout after 180000ms") as transient.
   * Enable on saturated shared infrastructure where queue starvation eats
   * the clock; leave off when the agent had the resources and simply failed.
   * Default false.
   */
  readonly retryFullDurationTimeouts?: boolean
  /** Additional caller-specific transient patterns. */
  readonly extraPatterns?: readonly RegExp[]
}

const BASE_TRANSIENT =
  /\b50[234]\b|no stream output|produced no stream|admission timed out|admission_rejected|queue_timeout|fetch failed|ECONNRESET|This operation was aborted/i

const TIMEOUT_PATTERN = /timeout after \d+ ?ms|cli-bridge timeout/i

/**
 * True when the error text describes an infrastructure hiccup that should be
 * retried rather than scored. Empty/undefined input is not transient.
 */
export function isTransientTransportFailure(
  message: string | null | undefined,
  opts: TransientFailureOptions = {},
): boolean {
  if (!message) return false
  if (BASE_TRANSIENT.test(message)) return true
  if ((opts.retryFullDurationTimeouts ?? false) && TIMEOUT_PATTERN.test(message)) return true
  for (const p of opts.extraPatterns ?? []) if (p.test(message)) return true
  return false
}
