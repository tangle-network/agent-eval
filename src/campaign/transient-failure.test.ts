import { describe, expect, it } from 'vitest'
import { isTransientTransportFailure } from './transient-failure'

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
