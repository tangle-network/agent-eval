import { describe, expect, it } from 'vitest'
import { canonicalString, LedgerCanonicalizationError } from '../ledger-core/canonical'
import { argHash } from './query'






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
