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
 * A third direction was measured later and is not a knob: a provider refusal that states its own
 * release time (`quotaExhaustedUntil`). Retrying that is neither scoring nor recovering — it is
 * spending a subscription against a wall the provider already dated. It is terminal until the
 * stated instant, and an undated rate limit is untouched.
 *
 * Full-duration timeouts are the deliberate knob: on saturated shared
 * infrastructure a timeout usually means the request never got a slot
 * (retry it), but on unthrottled infrastructure it means the agent flailed
 * on the task until the clock ran out (a real score-0). Both readings were
 * needed in practice within one week, so the classifier takes it as an
 * option instead of hardcoding either.
 */

import type { CampaignCellFailureReceipt } from './run-campaign'

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
  /**
   * The instant a dated quota refusal is measured against. Defaults to `Date.now()`; inject it
   * to replay a past classification, which is what a retry audit needs.
   */
  readonly now?: number
}

const BASE_TRANSIENT =
  /\b50[234]\b|no stream output|produced no stream|admission timed out|admission_rejected|queue_timeout|fetch failed|ECONNRESET|This operation was aborted/i

const TIMEOUT_PATTERN = /timeout after \d+ ?ms|cli-bridge timeout/i

/**
 * A provider refusal about a SPENT ALLOWANCE, which is not the same thing as a rate limit. It
 * becomes a release time only when a date follows it; the phrase alone stays retryable.
 *
 * `rate limit reached` is deliberately absent. Measured 2026-09-01: a z.ai 429 payload carries
 * `Rate limit reached for requests` and, 4,134 characters later in the same attempt log,
 * `reset at 2026-09-02 02:05:02`. That reset is minutes away and retrying it is correct. A
 * per-minute limit recovers on its own; an allowance does not.
 */
const QUOTA_PHRASE =
  /hit your usage limit|usage limit reached|insufficient balance|quota exceeded/gi

/**
 * The clause that introduces the release time. The date may sit behind a purchase link and an
 * `or`, so the phrase and the clause are matched independently rather than as one span.
 */
const RELEASE_CLAUSE =
  /(?:try again|resets?|available again|retry)\s+(?:at|on|after)\s+([^\n]{4,80})/i

/**
 * How far past a refusal its release time may sit. Long enough for the purchase URL the codex
 * message puts between them, far shorter than one attempt record — see `quotaExhaustedUntil`.
 */
const RELEASE_WINDOW_CHARS = 400

/**
 * The shapes a stated release is written in, in the order they are tried. THESE ARE THE
 * VALIDATION: a fragment that matches none of them is not a date, whatever `Date.parse` makes of
 * it. That matters — `Date.parse('Blursday 9999')` returns 9999-01-01, and a bare four-digit
 * number in prose would otherwise become a release nine thousand years out and stop a caller
 * forever.
 */
const RELEASE_SHAPES = [
  // NO UNZONED CLOCK. Measured 2026-09-01 on the z.ai seat: `Usage limit reached for 5 hour. Your
  // limit will reset at 2026-09-02 02:05:02` — a real spent allowance that states a real release,
  // in a machine payload with no zone at all. Read in the host's zone (UTC-6) that is 08:05Z; read
  // as the provider's it is 02:05Z. Nothing in the message decides between them, and a six-hour
  // error is six hours of a healthy seat withheld. A month-name or slash rendering is a CLI
  // printing in the HOST's zone, which is knowable; a bare numeric clock is not, and is refused.

  // 2026-09-07T02:29:00Z, 2026-09-07T02:29+02:00, or a bare 2026-09-07 (which ECMA-262 reads as
  // UTC). A numeric date-time with NO zone is deliberately absent — see NO UNZONED CLOCK below.
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?(?![\d\s:T-])/,
  // Sep 6th, 2026 8:29 PM · September 6 2026 · Sep 6, 2026
  /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?/,
  // 6 September 2026
  /\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}/,
  // 9/6/2026 8:29 PM
  /\d{1,2}\/\d{1,2}\/\d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?/,
]

/**
 * The instant a provider says a spent quota works again, or null when the text states none.
 *
 * MEASURED (2026-09-01, discovery lab). The codex/ChatGPT backend answered
 * `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more
 * credits or try again at Sep 6th, 2026 8:29 PM.` — a refusal SIX DAYS out. 25 supervised runs met
 * it. 21 of them retried it 12 times over about 31 minutes and settled with zero children, zero
 * tokens and zero claims: about 11 hours of one subscription's capacity spent on a wall that had
 * already told the caller when it would come down.
 *
 * The distinction this draws is not "quota" versus "not quota". It is "the provider named a
 * release time" versus "it did not". A bare 429, or z.ai's `您的账户已达到速率限制`, recovers on
 * its own in seconds and SHOULD be retried; those return null here and keep their existing
 * treatment. Only a stated release is terminal, and only until that instant.
 *
 * A date with no zone is read in the host's zone, because a CLI renders it in the host's zone.
 * An unparseable date returns null rather than a guess: a caller that stops dispatching must
 * never do so on a misread string.
 *
 * @param message the provider's error text
 * @returns the stated release time, or null when the text names none
 */
export function quotaExhaustedUntil(message: string | null | undefined): Date | null {
  if (!message) return null
  QUOTA_PHRASE.lastIndex = 0
  // THE RELEASE MUST BELONG TO THE REFUSAL. An error string can carry several provider payloads,
  // so searching the whole text for a phrase and, separately, for a date reads one payload's
  // quota against another payload's timestamp. Measured 2026-09-01: that pairing matched a z.ai
  // 429 to a date 4,134 characters away. The clause is searched only in the window FOLLOWING
  // each refusal.
  for (
    let phrase = QUOTA_PHRASE.exec(message);
    phrase !== null;
    phrase = QUOTA_PHRASE.exec(message)
  ) {
    const clause = RELEASE_CLAUSE.exec(
      message.slice(phrase.index, phrase.index + RELEASE_WINDOW_CHARS),
    )
    const stated = clause?.[1]
    if (stated === undefined) continue
    for (const shape of RELEASE_SHAPES) {
      const found = shape.exec(stated)
      if (found === null) continue
      // `Sep 6th` is not a date any parser accepts; the ordinal suffix is the only edit made.
      const until = Date.parse(found[0].replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, '$1'))
      if (Number.isFinite(until)) return new Date(until)
    }
  }
  return null
}

/**
 * True when the error text describes an infrastructure hiccup that should be
 * retried rather than scored. Empty/undefined input is not transient.
 */
export function isTransientTransportFailure(
  message: string | null | undefined,
  opts: TransientFailureOptions = {},
): boolean {
  if (!message) return false
  // A refusal that names its own release time is TERMINAL until that time, whatever else the text
  // matches. Checked first, and ahead of `extraPatterns`, because a caller's broad rate-limit
  // pattern would otherwise turn a six-day wall into a retry loop — see `quotaExhaustedUntil`.
  const until = quotaExhaustedUntil(message)
  if (until !== null && until.getTime() > (opts.now ?? Date.now())) return false
  if (BASE_TRANSIENT.test(message)) return true
  if ((opts.retryFullDurationTimeouts ?? false) && TIMEOUT_PATTERN.test(message)) return true
  for (const p of opts.extraPatterns ?? []) if (p.test(message)) return true
  return false
}

/**
 * Ready-made `cellRetry.retryable` predicate: true for a dispatch-stage
 * failure whose error message `isTransientTransportFailure` classifies as an
 * infrastructure hiccup. A judge-stage failure is never retried here — the
 * dispatch already produced an artifact, so re-dispatching would score a
 * different sample. A per-cell dispatch deadline ("dispatch exceeded <N>ms")
 * is not transient by default; opt in via `extraPatterns` or
 * `retryFullDurationTimeouts` when queue starvation eats the clock. A provider refusal that
 * states its own release time is never retried while that time is in the future
 * (`quotaExhaustedUntil`).
 */
export function transientDispatchFailure(
  opts: TransientFailureOptions = {},
): (failure: CampaignCellFailureReceipt['failure']) => boolean {
  return (failure) =>
    failure.stage === 'dispatch' && isTransientTransportFailure(failure.error.message, opts)
}
