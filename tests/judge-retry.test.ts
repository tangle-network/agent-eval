import { describe, expect, it } from 'vitest'
import { withJudgeRetry } from '../src/judge-retry'

describe('withJudgeRetry — substrate guard against silent-zero judge corruption', () => {
  it('returns succeeded=true on first-attempt success', async () => {
    const fn = async () => ({ score: 0.85 })
    const out = await withJudgeRetry(fn, { maxAttempts: 3 })
    expect(out.succeeded).toBe(true)
    expect(out.attempts).toBe(1)
    expect(out.value).toEqual({ score: 0.85 })
    expect(out.attemptErrors).toHaveLength(0)
  })

  it('retries on transient AbortError and eventually succeeds', async () => {
    let calls = 0
    const fn = async () => {
      calls += 1
      if (calls < 3) {
        const err = new Error('This operation was aborted')
        err.name = 'AbortError'
        throw err
      }
      return { score: 0.72 }
    }
    const out = await withJudgeRetry(fn, { maxAttempts: 3, backoffMs: () => 1 })
    expect(out.succeeded).toBe(true)
    expect(out.attempts).toBe(3)
    expect(out.value).toEqual({ score: 0.72 })
    expect(out.attemptErrors).toHaveLength(2)
  })

  it('returns succeeded=false (NOT silent zero) after exhausting retries on abort', async () => {
    const fn = async () => {
      const err = new Error('fetch failed')
      throw err
    }
    const out = await withJudgeRetry(fn, { maxAttempts: 3, backoffMs: () => 1 })
    expect(out.succeeded).toBe(false)
    expect(out.value).toBeNull()
    expect(out.attempts).toBe(3)
    expect(out.error?.message).toBe('fetch failed')
    expect(out.attemptErrors).toHaveLength(3)
  })

  it('does NOT retry on non-retriable errors (JSON parse, schema rejection)', async () => {
    const fn = async () => {
      throw new Error('LLM returned non-JSON content (model=claude-code/sonnet)')
    }
    const out = await withJudgeRetry(fn, { maxAttempts: 5, backoffMs: () => 1 })
    expect(out.succeeded).toBe(false)
    expect(out.attempts).toBe(1)
    expect(out.attemptErrors).toHaveLength(1)
  })

  it('rotates to fallback model after exhausting attempts on the primary', async () => {
    const modelHits: string[] = []
    const fn = async (model: string) => {
      modelHits.push(model)
      if (model === 'claude-code/sonnet') {
        const err = new Error('This operation was aborted')
        throw err
      }
      return { score: 0.9, usedModel: model }
    }
    const out = await withJudgeRetry(fn, {
      maxAttempts: 2,
      backoffMs: () => 1,
      models: ['claude-code/sonnet', 'kimi-code/k2p6'],
    })
    expect(out.succeeded).toBe(true)
    expect(out.modelUsed).toBe('kimi-code/k2p6')
    expect(modelHits).toEqual(['claude-code/sonnet', 'claude-code/sonnet', 'kimi-code/k2p6'])
  })

  it('respects timeoutMs by aborting via signal', async () => {
    const fn = async (_model: string, signal: AbortSignal) => {
      return new Promise<{ score: number }>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('TimeoutError')))
      })
    }
    const out = await withJudgeRetry(fn, { maxAttempts: 2, timeoutMs: 50, backoffMs: () => 1 })
    expect(out.succeeded).toBe(false)
    expect(out.attempts).toBe(2)
    // Both attempts hit the timeout
    expect(out.attemptErrors.every((e) => /timeout/i.test(e.error))).toBe(true)
  })

  it('treats LlmCallError with retryable HTTP status as retriable', async () => {
    let calls = 0
    const fn = async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('429 Too Many Requests') as Error & { status: number }
        err.status = 429
        throw err
      }
      return { ok: true }
    }
    const out = await withJudgeRetry(fn, { maxAttempts: 3, backoffMs: () => 1 })
    expect(out.succeeded).toBe(true)
    expect(out.attempts).toBe(2)
  })

  it('retries an HTTP/2 transport fault via the shared classifier', async () => {
    // Regression: judge-retry and llm-client carried separate retry-pattern
    // lists; neither matched undici HTTP/2 faults (`terminated`,
    // NGHTTP2_INTERNAL_ERROR). A TCloud-backed judge hitting one would fail
    // the trial as a silent non-retry. Both now route through
    // isTransientLlmError.
    let calls = 0
    const fn = async () => {
      calls += 1
      if (calls === 1) {
        throw new TypeError('terminated', { cause: new Error('NGHTTP2_INTERNAL_ERROR') })
      }
      return { score: 0.81 }
    }
    const out = await withJudgeRetry(fn, { maxAttempts: 3, backoffMs: () => 1 })
    expect(out.succeeded).toBe(true)
    expect(out.attempts).toBe(2)
    expect(out.value).toEqual({ score: 0.81 })
  })
})
