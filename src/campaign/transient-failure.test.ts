import { describe, expect, it } from 'vitest'
import type { CampaignCellFailureReceipt } from './run-campaign'
import {
  isTransientTransportFailure,
  quotaExhaustedUntil,
  transientDispatchFailure,
} from './transient-failure'

describe('isTransientTransportFailure', () => {
  it.each([
    'cli-bridge 502: no stream output',
    'HTTP 503 admission timed out after 30000ms',
    'upstream 504 gateway',
    'opencode produced no stream',
    'admission_rejected: queue full',
    'queue_timeout while waiting',
    'fetch failed',
    'read ECONNRESET',
    'This operation was aborted',
  ])('classifies %s as transient', (msg) => {
    expect(isTransientTransportFailure(msg)).toBe(true)
  })

  it('does NOT retry full-duration timeouts by default (a real task failure)', () => {
    expect(isTransientTransportFailure('cli-bridge timeout after 180000ms; cancel=cancelled')).toBe(
      false,
    )
  })

  it('retries full-duration timeouts when the caller opts in (saturated shared infra)', () => {
    expect(
      isTransientTransportFailure('cli-bridge timeout after 180000ms', {
        retryFullDurationTimeouts: true,
      }),
    ).toBe(true)
  })

  it('treats empty/undefined as not transient and supports extra patterns', () => {
    expect(isTransientTransportFailure('')).toBe(false)
    expect(isTransientTransportFailure(undefined)).toBe(false)
    expect(isTransientTransportFailure('model exploded', { extraPatterns: [/exploded/] })).toBe(
      true,
    )
    expect(isTransientTransportFailure('agent gave a wrong answer')).toBe(false)
  })
})

describe('transientDispatchFailure', () => {
  const failure = (
    stage: 'dispatch' | 'judge',
    message: string,
  ): CampaignCellFailureReceipt['failure'] => ({ stage, error: { name: 'Error', message } })

  it('retries a dispatch-stage transport hiccup', () => {
    expect(transientDispatchFailure()(failure('dispatch', 'router returned HTTP 503'))).toBe(true)
  })

  it('never retries a judge-stage failure, even with a transient-looking message', () => {
    expect(transientDispatchFailure()(failure('judge', 'HTTP 503 from judge backend'))).toBe(false)
  })

  it('scores a non-transport dispatch failure instead of retrying it', () => {
    expect(transientDispatchFailure()(failure('dispatch', 'agent gave a wrong answer'))).toBe(false)
  })
})

describe('quotaExhaustedUntil', () => {
  /** The exact text the codex/ChatGPT backend returned on 2026-09-01, byte for byte. */
  const CODEX_USAGE_LIMIT =
    "bridgeExecutor: bridge stream error: codex: You've hit your usage limit. " +
    'Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ' +
    'Sep 6th, 2026 8:29 PM.'

  it('reads the release time out of the message that cost 21 runs', () => {
    const until = quotaExhaustedUntil(CODEX_USAGE_LIMIT)
    expect(until).not.toBeNull()
    // Asserted on the WALL CLOCK, so the expectation does not depend on the runner's zone: a
    // date with no zone is the host's, because a CLI renders it in the host's.
    expect([
      until?.getFullYear(),
      until?.getMonth(),
      until?.getDate(),
      until?.getHours(),
      until?.getMinutes(),
    ]).toEqual([2026, 8, 6, 20, 29])
  })

  it.each([
    "You've hit your usage limit. Try again at Sep 7th, 2026 2:29 AM.",
    'usage limit reached — resets at 2026-09-07T02:29:00Z',
    'quota exceeded; retry after Sep 7, 2026 02:29',
  ])('reads other renderings of the same statement: %s', (message) => {
    expect(quotaExhaustedUntil(message)).not.toBeNull()
  })

  it.each([
    'provider returned 429: rate limit exceeded, retry later',
    '您的账户已达到速率限制，请您控制请求频率',
    "You've hit your usage limit. Try again later.",
    'usage limit reached; slow down',
    'router returned HTTP 503',
    '',
  ])('states no release time, so it stays retryable: %s', (message) => {
    expect(quotaExhaustedUntil(message)).toBeNull()
  })

  it("never pairs one payload's refusal with another payload's date", () => {
    // Measured 2026-09-01 on a z.ai seat: `Rate limit reached for requests`, then 4,134 characters
    // later `reset at 2026-09-02 02:05:02`. A per-minute limit is not a spent allowance, and a
    // date that far away is not its release. Both halves are refused.
    const zai =
      '{"error":{"message":"Rate limit reached for requests","statusCode":429}}' +
      'x'.repeat(4000) +
      '{"error":{"message":"reset at 2026-09-02 02:05:02","statusCode":429}}'
    expect(quotaExhaustedUntil(zai)).toBeNull()
    expect(isTransientTransportFailure(`fetch failed; ${zai}`)).toBe(true)
    expect(
      quotaExhaustedUntil(
        `You've hit your usage limit.${'x'.repeat(600)} try again at Sep 6, 2026 8:29 PM.`,
      ),
    ).toBeNull()
  })

  it('refuses a release whose clock carries no zone, and honours the same statement with one', () => {
    // Measured 2026-09-01 on a z.ai seat: `Usage limit reached for 5 hour. Your limit will reset
    // at 2026-09-02 02:05:02` — a real spent allowance stating a real release, in a machine
    // payload with no zone. Read locally that is 6 hours from the provider's reading, and the gap
    // is a healthy seat withheld. A month-name rendering is a CLI printing in the host's zone,
    // which is knowable; a bare numeric clock is not.
    const zai = 'Usage limit reached for 5 hour. Your limit will reset at 2026-09-02 02:05:02'
    expect(quotaExhaustedUntil(zai)).toBeNull()
    expect(quotaExhaustedUntil(`${zai}Z`.replace(' 02:05:02', 'T02:05:02'))?.toISOString()).toBe(
      '2026-09-02T02:05:02.000Z',
    )
  })

  it('returns null rather than guessing when the stated date cannot be parsed', () => {
    expect(
      quotaExhaustedUntil("You've hit your usage limit. Try again at Blursday 9999."),
    ).toBeNull()
  })

  it('is terminal until the stated instant, and retryable again after it', () => {
    const wall = quotaExhaustedUntil(CODEX_USAGE_LIMIT)?.getTime() as number
    // Before the wall comes down: not a hiccup, even with a caller pattern that would match.
    expect(
      isTransientTransportFailure(CODEX_USAGE_LIMIT, {
        now: wall - 1000,
        extraPatterns: [/usage limit/i],
      }),
    ).toBe(false)
    expect(
      transientDispatchFailure({ now: wall - 1000 })({
        stage: 'dispatch',
        error: { name: 'BackendTransportError', message: CODEX_USAGE_LIMIT },
      }),
    ).toBe(false)
    // After it, the text no longer describes a live wall and the caller's own rules decide again.
    expect(
      isTransientTransportFailure(CODEX_USAGE_LIMIT, {
        now: wall + 1000,
        extraPatterns: [/usage limit/i],
      }),
    ).toBe(true)
  })

  it('leaves an undated rate limit retryable, which is the behaviour that must not change', () => {
    expect(isTransientTransportFailure('cli-bridge 502: no stream output while rate limited')).toBe(
      true,
    )
    expect(isTransientTransportFailure('router returned HTTP 503')).toBe(true)
  })
})
