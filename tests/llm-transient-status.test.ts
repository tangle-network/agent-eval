import { describe, expect, it } from 'vitest'
import { isTransientLlmError, LlmCallError } from '../src/llm-client'

describe('isTransientLlmError — HTTP status classification', () => {
  const call = (status: number) => new LlmCallError('upstream error', status, '', 'test-model')

  it.each([429, 502, 503, 504])('retries gateway-transient status %i', (status) => {
    expect(isTransientLlmError(call(status))).toBe(true)
  })

  it.each([522, 524])('retries Cloudflare edge timeout %i like a 504', (status) => {
    expect(isTransientLlmError(call(status))).toBe(true)
  })

  it.each([400, 401, 404, 422])('never retries deterministic status %i', (status) => {
    expect(isTransientLlmError(call(status))).toBe(false)
  })

  it('reads a retryable numeric status off a foreign (non-LlmCallError) error', () => {
    const err = Object.assign(new Error('edge timeout'), { status: 524 })
    expect(isTransientLlmError(err)).toBe(true)
  })
})
