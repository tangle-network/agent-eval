import { createHash } from 'node:crypto'
import { canonicalCandidateJson } from '@tangle-network/agent-interface'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  canonicalString,
  compareCodeUnits,
  hashCanonical,
  LedgerCanonicalizationError,
} from './canonical'

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

/**
 * The key-sorting encoders this package used to carry, kept here only as
 * oracles: `canonicalString` must agree with each of them byte-for-byte on
 * every plain JSON value, so delegating to it changes no digest of persisted
 * plain data, while the values they coerced are refused instead.
 */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
  }
  return out
}
const sortThenStringify = (value: unknown): string => JSON.stringify(sortKeysDeep(value))
/** Keys on which the old sort-into-a-new-object encoders were not faithful:
 * integer-like keys re-enumerate numerically first, and an own `__proto__` key
 * vanishes through plain assignment. Both divergences have explicit tests. */
function hasNonParityKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasNonParityKey)
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) =>
      String(Number.parseInt(key, 10)) === key || key === '__proto__' || hasNonParityKey(entry),
  )
}
function recursiveSortedEncoder(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(recursiveSortedEncoder).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${recursiveSortedEncoder(record[key])}`).join(',')}}`
}

describe('canonicalString replaces the key-sorting encoders byte-for-byte', () => {
  it('agrees with sort-then-JSON.stringify on plain JSON values without integer-like keys', () => {
    // JS object enumeration puts integer-like keys first in numeric order, so
    // the old sort-into-a-new-object encoders never actually sorted those keys
    // and diverge from RFC 8785 on them — covered by the next test.
    fc.assert(
      fc.property(
        fc.jsonValue().filter((value) => !hasNonParityKey(value)),
        (value) => {
          expect(canonicalString(value)).toBe(sortThenStringify(value))
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('sorts integer-like keys as strings where sort-then-stringify emitted them numerically', () => {
    const value = JSON.parse('{"10":1,"2":2,"":0}') as Record<string, unknown>
    expect(sortThenStringify(value)).toBe('{"2":2,"10":1,"":0}')
    expect(canonicalString(value)).toBe('{"":0,"10":1,"2":2}')
  })

  it('keeps the own __proto__ key sort-then-stringify silently dropped', () => {
    const value = JSON.parse('{"__proto__":1,"a":2}') as Record<string, unknown>
    expect(sortThenStringify(value)).toBe('{"a":2}')
    expect(canonicalString(value)).toBe('{"__proto__":1,"a":2}')
  })

  it('agrees with the recursive sorted encoder on every plain JSON value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(canonicalString(value)).toBe(recursiveSortedEncoder(value))
      }),
      { numRuns: 1000 },
    )
  })

  it('keeps the hex digest of sort-then-stringify for plain data', () => {
    const value = {
      scenarios: [
        { id: 'b', payload: { q: 1 } },
        { id: 'a', payload: null },
      ],
    }
    const legacyHex = createHash('sha256').update(sortThenStringify(value)).digest('hex')
    expect(hashCanonical(value)).toBe(`sha256:${legacyHex}`)
  })

  it('refuses the undefined-valued field both old encoders silently dropped', () => {
    const withUndefined = { a: 1, b: undefined }
    expect(sortThenStringify(withUndefined)).toBe(sortThenStringify({ a: 1 }))
    expect(recursiveSortedEncoder(withUndefined)).toBe(recursiveSortedEncoder({ a: 1 }))
    expect(() => canonicalString(withUndefined)).toThrow(LedgerCanonicalizationError)
    expect(() => hashCanonical(withUndefined)).toThrow('$.b is undefined')
    expect(canonicalString({ a: 1, b: null })).not.toBe(canonicalString({ a: 1 }))
  })

  it('refuses the Date the old encoders coerced', () => {
    const at = new Date('2026-06-07T00:00:00.000Z')
    // JSON.stringify honors toJSON (the verdict-cache encoder did too); the
    // sort-into-a-new-object encoders flattened a Date to {}. Both coercions
    // are refused: a timestamp travels as an ISO string.
    expect(JSON.stringify({ at })).toBe('{"at":"2026-06-07T00:00:00.000Z"}')
    expect(sortThenStringify({ at })).toBe('{"at":{}}')
    expect(() => canonicalString({ at })).toThrow('$.at is a Date instance')
    expect(canonicalString({ at: at.toISOString() })).toBe('{"at":"2026-06-07T00:00:00.000Z"}')
  })
})

describe('compareCodeUnits', () => {
  /**
   * The whole point: `localeCompare` reads the host's collation, so an array
   * sorted with it can reach `canonicalString`/`hashCanonical` in an order that
   * is a property of the machine. RFC 8785 canonicalizes an array BY POSITION,
   * so that order decides the digest bytes.
   */
  it('orders by code unit where a collation orders differently', () => {
    const names = ['brevity', 'Accuracy', 'Clarity']

    expect([...names].sort(compareCodeUnits)).toEqual(['Accuracy', 'Clarity', 'brevity'])
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual([
      'Accuracy',
      'brevity',
      'Clarity',
    ])
  })

  it('gives an array a digest that a collation cannot move', () => {
    const rows = ['brevity', 'Accuracy', 'Clarity'].map((id) => ({ id }))
    const byCodeUnit = [...rows].sort((a, b) => compareCodeUnits(a.id, b.id))
    const byCollation = [...rows].sort((a, b) => a.id.localeCompare(b.id))

    expect(hashCanonical(byCodeUnit)).not.toBe(hashCanonical(byCollation))
    expect(hashCanonical(byCodeUnit)).toBe(
      hashCanonical([...rows].reverse().sort((a, b) => compareCodeUnits(a.id, b.id))),
    )
  })

  it('is a total order on equal values', () => {
    expect(compareCodeUnits('a', 'a')).toBe(0)
    expect(compareCodeUnits('a', 'b')).toBe(-1)
    expect(compareCodeUnits('b', 'a')).toBe(1)
  })
})
