/**
 * Truncation-recovery must be conservative: recover real prefixes, never
 * invent structure. Each case pins one truncation shape an LLM cap-hit
 * actually produces.
 */

import { describe, expect, it } from 'vitest'

import { autoCloseTruncatedJson, recoverTruncatedJson } from './json-recovery'

describe('autoCloseTruncatedJson', () => {
  it('returns balanced input unchanged', () => {
    expect(autoCloseTruncatedJson('{"a": 1}')).toBe('{"a": 1}')
  })

  it('closes unclosed objects and arrays in LIFO order', () => {
    expect(autoCloseTruncatedJson('{"a": [1, 2')).toBe('{"a": [1, 2]}')
  })

  it('closes an open string before closing containers', () => {
    expect(autoCloseTruncatedJson('{"a": "cut of')).toBe('{"a": "cut of"}')
  })

  it('is escape-aware inside strings', () => {
    expect(autoCloseTruncatedJson('{"a": "he said \\"hi')).toBe('{"a": "he said \\"hi"}')
  })

  it('returns null on over-closed input (not a truncation)', () => {
    expect(autoCloseTruncatedJson('{"a": 1}}')).toBeNull()
  })
})

describe('recoverTruncatedJson', () => {
  it('recovers an object cut mid-string-value', () => {
    expect(recoverTruncatedJson('{"correct": false, "reason": "the deliv')).toEqual({
      correct: false,
      reason: 'the deliv',
    })
  })

  it('recovers by dropping a dangling key (cut right after a comma)', () => {
    expect(recoverTruncatedJson('{"correct": true, "')).toEqual({ correct: true })
  })

  it('extracts JSON embedded in prose', () => {
    expect(recoverTruncatedJson('Verdict below:\n{"score": 3, "note": "ok"}')).toEqual({
      score: 3,
      note: 'ok',
    })
  })

  it('returns null when there is no JSON at all', () => {
    expect(recoverTruncatedJson('the artifact looks fine')).toBeNull()
  })

  it('does not invent a value for a key whose value was cut off', () => {
    const r = recoverTruncatedJson('{"correct": ') as Record<string, unknown> | null
    expect(r === null || !('correct' in r)).toBe(true)
  })

  it('recovers an object preceded by a bracketed prose tag', () => {
    expect(recoverTruncatedJson('[note] {"score": 3}')).toEqual({ score: 3 })
  })

  it('still recovers a truncated top-level array', () => {
    expect(recoverTruncatedJson('scores: [1, 2, 3')).toEqual([1, 2, 3])
  })

  it('recovers a string truncated right after a backslash', () => {
    const r = recoverTruncatedJson('{"a": "val\\') as Record<string, unknown> | null
    expect(r).not.toBeNull()
    expect(typeof r?.a).toBe('string')
  })

  it('auto-close completes a trailing escape instead of emitting an escaped quote', () => {
    const closed = autoCloseTruncatedJson('{"a":"x\\')
    expect(closed).not.toBeNull()
    expect(() => JSON.parse(closed as string)).not.toThrow()
  })
})
