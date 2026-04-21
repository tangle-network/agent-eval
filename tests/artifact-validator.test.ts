import { describe, it, expect } from 'vitest'
import {
  regexMatch,
  jsonHasKeys,
  byteLengthRange,
  containsAll,
  composeValidators,
  type Artifact,
} from '../src/artifact-validator'

const ctx = { scenarioId: 's1' }

describe('regexMatch', () => {
  it('passes on match', async () => {
    const v = regexMatch('hasEmail', /\b[\w.]+@[\w.]+\b/)
    const r = await v.validate({ kind: 'text', content: 'contact me at a@b.com' }, ctx)
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })
  it('fails + returns an error issue on no match', async () => {
    const v = regexMatch('hasEmail', /\b[\w.]+@[\w.]+\b/)
    const r = await v.validate({ kind: 'text', content: 'no email here' }, ctx)
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0)
    expect(r.issues[0].severity).toBe('error')
  })
})

describe('jsonHasKeys', () => {
  it('passes when all paths present', async () => {
    const v = jsonHasKeys('schema', ['user.name', 'user.email', 'total'])
    const r = await v.validate({ kind: 'json', content: JSON.stringify({ user: { name: 'A', email: 'a@b' }, total: 10 }) }, ctx)
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })

  it('partial credit when some paths missing — regression: 0/1 pass hides near-hits', async () => {
    const v = jsonHasKeys('schema', ['a', 'b', 'c', 'd'])
    const r = await v.validate({ kind: 'json', content: JSON.stringify({ a: 1, b: 2 }) }, ctx)
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0.5)
    expect(r.issues.map((i) => i.message)).toEqual([
      'Missing path: c',
      'Missing path: d',
    ])
  })

  it('rejects malformed JSON — regression: crash instead of fail would kill the whole suite', async () => {
    const v = jsonHasKeys('schema', ['x'])
    const r = await v.validate({ kind: 'json', content: '{broken' }, ctx)
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0)
    expect(r.issues[0].message).toMatch(/Invalid JSON/)
  })

  it('supports array-index paths', async () => {
    const v = jsonHasKeys('schema', ['items.0.id'])
    const r = await v.validate({ kind: 'json', content: JSON.stringify({ items: [{ id: 'a' }] }) }, ctx)
    expect(r.pass).toBe(true)
  })
})

describe('byteLengthRange', () => {
  it('passes inside the range', async () => {
    const v = byteLengthRange('size', 10, 100)
    const r = await v.validate({ kind: 'text', content: 'abc'.repeat(10) }, ctx)
    expect(r.pass).toBe(true)
  })
  it('fails below min + gives proportional score — regression: binary scores lose signal on near-misses', async () => {
    const v = byteLengthRange('size', 10, 100)
    const r = await v.validate({ kind: 'text', content: 'abc' }, ctx)
    expect(r.pass).toBe(false)
    expect(r.score).toBeCloseTo(0.3, 2) // 3/10
  })
  it('fails above max', async () => {
    const v = byteLengthRange('size', 10, 100)
    const r = await v.validate({ kind: 'text', content: 'x'.repeat(200) }, ctx)
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0.5) // 100/200
  })
})

describe('containsAll', () => {
  it('case-insensitive by default', async () => {
    const v = containsAll('keywords', ['Privacy', 'termination'])
    const r = await v.validate({ kind: 'text', content: 'privacy and termination clauses apply.' }, ctx)
    expect(r.pass).toBe(true)
  })
  it('case-sensitive opt-in', async () => {
    const v = containsAll('keywords', ['Privacy'], { caseSensitive: true })
    const r = await v.validate({ kind: 'text', content: 'privacy clause' }, ctx)
    expect(r.pass).toBe(false)
  })
  it('partial credit on missing substrings', async () => {
    const v = containsAll('keywords', ['a', 'b', 'c', 'd'])
    const r = await v.validate({ kind: 'text', content: 'a b' }, ctx)
    expect(r.score).toBeCloseTo(0.5, 2)
  })
})

describe('composeValidators', () => {
  it('aggregates pass as AND, score as weighted mean', async () => {
    const a: Artifact = { kind: 'json', content: JSON.stringify({ name: 'A' }) }
    const composed = composeValidators([
      jsonHasKeys('keys', ['name']),
      byteLengthRange('size', 1, 1000),
    ])
    const r = await composed.validate(a, ctx)
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })

  it('rejects weights length mismatch — regression: silent mismatch mis-weights reports', () => {
    expect(() =>
      composeValidators([regexMatch('a', /x/), regexMatch('b', /y/)], { weights: [1] }),
    ).toThrow(/weights length/)
  })

  it('fails when any validator fails; issues are namespaced by validator', async () => {
    const composed = composeValidators([
      regexMatch('needsX', /X/),
      regexMatch('needsY', /Y/),
    ])
    const r = await composed.validate({ kind: 'text', content: 'only has X' }, ctx)
    expect(r.pass).toBe(false)
    expect(r.issues.some((i) => i.locus?.startsWith('needsY'))).toBe(true)
  })
})
