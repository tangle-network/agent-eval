import { describe, expect, it } from 'vitest'
import type { CampaignCellFailureReceipt } from './run-campaign'
import { isTransientTransportFailure, transientDispatchFailure } from './transient-failure'

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
