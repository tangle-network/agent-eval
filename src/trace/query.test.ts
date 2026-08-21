import { describe, expect, it } from 'vitest'
import { canonicalString, LedgerCanonicalizationError } from '../ledger-core/canonical'
import { aggregateLlm, argHash } from './query'
import type { LlmSpan } from './schema'

function llm(extra: Partial<LlmSpan>): LlmSpan {
  // `extra` is a Partial spread last, which widens `kind`; cast back to LlmSpan.
  return { spanId: 's', runId: 'r', kind: 'llm', name: 'llm', startedAt: 0, ...extra } as LlmSpan
}

describe('aggregateLlm', () => {
  it('sums cache reads, cache writes, and reasoning tokens', () => {
    const agg = aggregateLlm([
      llm({
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 300,
        cacheWriteTokens: 30,
        reasoningTokens: 1000,
      }),
      llm({
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 40,
        cacheWriteTokens: 4,
        reasoningTokens: 200,
      }),
    ])
    expect(agg.inputTokens).toBe(110)
    expect(agg.outputTokens).toBe(55)
    expect(agg.cachedTokens).toBe(340)
    expect(agg.cacheWriteTokens).toBe(34)
    expect(agg.reasoningTokens).toBe(1200)
  })
})

describe('argHash', () => {
  it('keys uncaptured args and null args to distinct strings', () => {
    expect(argHash(undefined)).toBe('undefined')
    expect(argHash(null)).toBe('null')
    expect(argHash(undefined)).not.toBe(argHash(null))
  })

  it('is the RFC 8785 canonical JSON of the args', () => {
    expect(argHash({ b: 2, a: 1 })).toBe(canonicalString({ a: 1, b: 2 }))
    expect(argHash({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('is stable across object key insertion order', () => {
    expect(argHash({ a: 1, b: 2 })).toBe(argHash({ b: 2, a: 1 }))
  })

  it('refuses args with no canonical JSON form instead of keying them loosely', () => {
    expect(() => argHash({ a: 1, b: undefined })).toThrow(LedgerCanonicalizationError)
    expect(() => argHash({ a: 1, b: undefined })).toThrow(/\$\.b is undefined/)
    expect(() => argHash(() => 1)).toThrow(LedgerCanonicalizationError)
    expect(() => argHash({ n: Number.NaN })).toThrow(/\$\.n is NaN/)
  })

  it('distinguishes null, the string "null", and distinct args', () => {
    expect(argHash(null)).not.toBe(argHash('null'))
    expect(argHash({ cmd: 'a' })).not.toBe(argHash({ cmd: 'b' }))
  })

  it('recurses into nested structures stably', () => {
    expect(argHash({ x: [{ a: 1, b: 2 }] })).toBe(argHash({ x: [{ b: 2, a: 1 }] }))
  })
})
