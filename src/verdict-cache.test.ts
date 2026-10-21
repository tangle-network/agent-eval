import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashCanonical, LedgerCanonicalizationError } from './ledger-core/canonical'
import { canonicalJson, contentHash, fileVerdictCache } from './verdict-cache'

describe('canonicalJson', () => {
  it('produces byte-identical output regardless of key insertion order', () => {
    const a = canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } })
    const b = canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"c":"x","d":[1,2]},"b":1}')
  })

  it('round-trips through JSON.parse to an equal value', () => {
    const value = { z: [1, 'two', null, true], a: { nested: 0.5 } }
    expect(JSON.parse(canonicalJson(value))).toEqual(value)
  })

  it('throws on undefined, function, and symbol values', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(LedgerCanonicalizationError)
    expect(() => canonicalJson({ a: undefined })).toThrow(/\$\.a is undefined/)
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/\$\.a is a function/)
    expect(() => canonicalJson({ a: Symbol('x') })).toThrow(/\$\.a is a symbol/)
    expect(() => canonicalJson([1, undefined])).toThrow(/\$\[1\] is undefined/)
  })

  it('throws on NaN and non-finite numbers', () => {
    expect(() => canonicalJson({ score: NaN })).toThrow(/\$\.score is NaN/)
    expect(() => canonicalJson({ score: Infinity })).toThrow(/\$\.score is Infinity/)
    expect(() => canonicalJson({ score: -Infinity })).toThrow(/\$\.score is -Infinity/)
  })

  it('throws on Map and Set instead of serializing them as {}', () => {
    expect(() => canonicalJson({ m: new Map([['k', 1]]) })).toThrow(/\$\.m is a Map instance/)
    expect(() => canonicalJson({ s: new Set([1]) })).toThrow(/\$\.s is a Set instance/)
  })

  it('refuses a Date instance; timestamps travel as ISO strings', () => {
    const at = new Date('2026-06-07T00:00:00.000Z')
    expect(() => canonicalJson({ at })).toThrow(LedgerCanonicalizationError)
    expect(() => canonicalJson({ at })).toThrow(/\$\.at is a Date instance/)
    expect(canonicalJson({ at: at.toISOString() })).toBe('{"at":"2026-06-07T00:00:00.000Z"}')
  })
})

describe('contentHash', () => {
  it('is stable across key order and sensitive to value changes', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }))
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }))
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is the hex form of the ledger-core digest', () => {
    const value = { report: ['a', 1, null], nested: { k: true } }
    expect(`sha256:${contentHash(value)}`).toBe(hashCanonical(value))
  })

  it('keeps a distinct digest for a record with an undefined field by refusing it', () => {
    expect(() => contentHash({ a: 1, b: undefined })).toThrow(LedgerCanonicalizationError)
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 1, b: null }))
  })
})

describe('fileVerdictCache', () => {
  it('starts empty when the file does not exist', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'verdict-cache-')), 'missing.jsonl')
    expect(() => fileVerdictCache(path)).not.toThrow()
  })

  it('throws loudly with file:line on a corrupt line', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'verdict-cache-')), 'corrupt.jsonl')
    const good = JSON.stringify({
      key: 'k1',
      score: { dimensions: { clarity: 1 }, composite: 1, notes: 'ok' },
    })
    writeFileSync(path, `${good}\nnot-json{{{\n`, 'utf8')
    expect(() => fileVerdictCache(path)).toThrow(/corrupt JSONL at .*corrupt\.jsonl:2/)
  })

  it('throws loudly on a well-formed JSON line with the wrong shape', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'verdict-cache-')), 'shape.jsonl')
    writeFileSync(path, `${JSON.stringify({ key: 'k1', score: { composite: 'high' } })}\n`, 'utf8')
    expect(() => fileVerdictCache(path)).toThrow(/invalid record shape at .*shape\.jsonl:1/)
  })
})
