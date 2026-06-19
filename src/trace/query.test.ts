import { describe, expect, it } from 'vitest'
import { argHash } from './query'

describe('argHash', () => {
  it('always returns a string — even for undefined / functions', () => {
    // Regression: JSON.stringify(undefined) returns the value `undefined`,
    // which made argHash non-string and broke de-dup keys downstream.
    expect(typeof argHash(undefined)).toBe('string')
    expect(typeof argHash(null)).toBe('string')
    expect(typeof argHash(() => 1)).toBe('string')
  })

  it('is stable across object key insertion order', () => {
    expect(argHash({ a: 1, b: 2 })).toBe(argHash({ b: 2, a: 1 }))
  })

  it('treats an undefined-valued key like an absent key (JSON semantics)', () => {
    expect(argHash({ a: 1 })).toBe(argHash({ a: 1, b: undefined }))
  })

  it('distinguishes null, the string "null", and distinct args', () => {
    expect(argHash(null)).not.toBe(argHash('null'))
    expect(argHash({ cmd: 'a' })).not.toBe(argHash({ cmd: 'b' }))
  })

  it('recurses into nested structures stably', () => {
    expect(argHash({ x: [{ a: 1, b: 2 }] })).toBe(argHash({ x: [{ b: 2, a: 1 }] }))
  })
})
