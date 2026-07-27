import { canonicalCandidateJson } from '@tangle-network/agent-interface'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { canonicalString, hashCanonical, LedgerCanonicalizationError } from './canonical'

describe('canonicalString refuses values with no faithful JSON form', () => {
  it('refuses a non-finite number instead of encoding it as null', () => {
    expect(() => canonicalString({ a: Number.NaN })).toThrow(LedgerCanonicalizationError)
    expect(() => canonicalString({ a: Number.NaN })).toThrow('$.a is NaN')
    expect(() => canonicalString({ a: Number.POSITIVE_INFINITY })).toThrow('$.a is Infinity')
    expect(() => canonicalString({ a: Number.NEGATIVE_INFINITY })).toThrow('$.a is -Infinity')
    expect(canonicalString({ a: null })).toBe('{"a":null}')
  })

  it('refuses an undefined value instead of dropping the key', () => {
    expect(() => canonicalString({ a: 1, b: undefined })).toThrow(LedgerCanonicalizationError)
    expect(() => canonicalString({ a: 1, b: undefined })).toThrow('$.b is undefined')
    expect(canonicalString({ a: 1 })).toBe('{"a":1}')
  })

  it('refuses class instances, cycles, and unpaired surrogates', () => {
    expect(() => canonicalString({ at: new Date(0) })).toThrow(
      '$.at is a Date instance, not plain JSON data',
    )
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => canonicalString(cyclic)).toThrow('$.self closes a reference cycle')
    expect(() => canonicalString({ a: '\ud800' })).toThrow('$.a contains an unpaired surrogate')
  })

  it('reports the path of the offending value inside nested structures', () => {
    expect(() => canonicalString({ outer: [{ inner: Number.NaN }] })).toThrow(
      '$.outer[0].inner is NaN',
    )
  })

  it('hashes distinctly for values the old coercions collapsed together', () => {
    expect(hashCanonical({ a: null })).not.toBe(hashCanonical({ a: 0 }))
    expect(() => hashCanonical({ a: Number.NaN })).toThrow(LedgerCanonicalizationError)
    expect(() => hashCanonical({ a: 1, b: undefined })).toThrow(LedgerCanonicalizationError)
  })

  it('keeps an own __proto__ key in the digest instead of silently dropping it', () => {
    const polluted = JSON.parse('{"__proto__":1,"a":2}') as Record<string, unknown>
    expect(canonicalString(polluted)).toBe('{"__proto__":1,"a":2}')
    expect(hashCanonical(polluted)).not.toBe(hashCanonical({ a: 2 }))
  })

  it('sorts array-index-like keys as strings, not in numeric enumeration order', () => {
    expect(canonicalString(JSON.parse('{"10":1,"2":2}'))).toBe('{"10":1,"2":2}')
    expect(canonicalString(JSON.parse('{"0":"x","":0}'))).toBe('{"":0,"0":"x"}')
  })
})

describe('canonicalString is the RFC 8785 encoder', () => {
  it('agrees byte-for-byte with the shared candidate canonicalizer', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(canonicalString(value)).toBe(canonicalCandidateJson(value))
      }),
      { numRuns: 5000 },
    )
  })

  it('is insertion-order independent', () => {
    expect(canonicalString({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalString({ a: { c: 3, d: 2 }, b: 1 }),
    )
  })
})
