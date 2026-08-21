import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JudgeConfig, JudgeScore } from './campaign/types'
import { hashCanonical, LedgerCanonicalizationError } from './ledger-core/canonical'
import {
  cachedJudge,
  canonicalJson,
  contentHash,
  fileVerdictCache,
  inMemoryVerdictCache,
  VERDICT_CACHE_KEY_SCHEME,
} from './verdict-cache'

const signal = new AbortController().signal
const scenario = { id: 's-1', kind: 'unit' }

function makeFakeJudge(): { judge: JudgeConfig<string>; calls: () => number } {
  let calls = 0
  const judge: JudgeConfig<string> = {
    name: 'fake-judge',
    dimensions: [{ key: 'clarity', description: 'is the artifact clear' }],
    score({ artifact }) {
      calls += 1
      const score: JudgeScore = {
        dimensions: { clarity: artifact.length % 2 === 0 ? 1 : 0.5 },
        composite: artifact.length % 2 === 0 ? 1 : 0.5,
        notes: `judged ${artifact.length} chars`,
      }
      return score
    },
  }
  return { judge, calls: () => calls }
}

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

describe('cachedJudge', () => {
  it('serves a repeat judgment from the cache without invoking score()', async () => {
    const { judge, calls } = makeFakeJudge()
    const wrapped = cachedJudge(judge, inMemoryVerdictCache(), { judgeVersion: 'v1' })

    const first = await wrapped.score({ artifact: 'hello', scenario, signal })
    const second = await wrapped.score({ artifact: 'hello', scenario, signal })

    expect(calls()).toBe(1)
    expect(second).toEqual(first)
    expect(wrapped.stats()).toEqual({ hits: 1, misses: 1 })
  })

  it('misses when the artifact changes', async () => {
    const { judge, calls } = makeFakeJudge()
    const wrapped = cachedJudge(judge, inMemoryVerdictCache(), { judgeVersion: 'v1' })

    await wrapped.score({ artifact: 'one', scenario, signal })
    await wrapped.score({ artifact: 'two', scenario, signal })

    expect(calls()).toBe(2)
    expect(wrapped.stats()).toEqual({ hits: 0, misses: 2 })
  })

  it('misses when judgeVersion changes over the same store', async () => {
    const { judge, calls } = makeFakeJudge()
    const store = inMemoryVerdictCache()

    await cachedJudge(judge, store, { judgeVersion: 'v1' }).score({
      artifact: 'same',
      scenario,
      signal,
    })
    await cachedJudge(judge, store, { judgeVersion: 'v2' }).score({
      artifact: 'same',
      scenario,
      signal,
    })

    expect(calls()).toBe(2)
  })

  it('misses when the rubric dimensions change over the same store', async () => {
    const { judge, calls } = makeFakeJudge()
    const reworded: JudgeConfig<string> = {
      ...judge,
      dimensions: [{ key: 'clarity', description: 'REWRITTEN rubric text' }],
    }
    const store = inMemoryVerdictCache()

    await cachedJudge(judge, store, { judgeVersion: 'v1' }).score({
      artifact: 'same',
      scenario,
      signal,
    })
    await cachedJudge(reworded, store, { judgeVersion: 'v1' }).score({
      artifact: 'same',
      scenario,
      signal,
    })

    expect(calls()).toBe(2)
  })

  it('misses when the scenario id changes', async () => {
    const { judge, calls } = makeFakeJudge()
    const wrapped = cachedJudge(judge, inMemoryVerdictCache(), { judgeVersion: 'v1' })

    await wrapped.score({ artifact: 'same', scenario, signal })
    await wrapped.score({ artifact: 'same', scenario: { id: 's-2', kind: 'unit' }, signal })

    expect(calls()).toBe(2)
  })

  it('misses an entry stored under the unprefixed key scheme and repopulates', async () => {
    const { judge, calls } = makeFakeJudge()
    const store = inMemoryVerdictCache()
    const legacyKey = contentHash({
      artifact: canonicalJson('abcd'),
      scenarioId: scenario.id,
      judgeName: judge.name,
      dimensions: judge.dimensions,
      judgeVersion: 'v1',
    })
    await store.set(legacyKey, { dimensions: { clarity: 0 }, composite: 0, notes: 'stale' })
    const cached = cachedJudge(judge, store, { judgeVersion: 'v1' })
    const score = await cached.score({ artifact: 'abcd', scenario, signal })
    expect(calls()).toBe(1)
    expect(score.notes).toBe('judged 4 chars')
    expect(cached.stats()).toEqual({ hits: 0, misses: 1 })
    expect(await store.get(`${VERDICT_CACHE_KEY_SCHEME}:${legacyKey}`)).toEqual(score)
  })

  it('refuses an artifact that carries a Date instead of content-addressing it', async () => {
    const judge: JudgeConfig<{ at: Date }> = {
      name: 'date-judge',
      dimensions: [{ key: 'clarity', description: 'is the artifact clear' }],
      score: () => ({ dimensions: { clarity: 1 }, composite: 1, notes: '' }),
    }
    const cached = cachedJudge(judge, inMemoryVerdictCache(), { judgeVersion: 'v1' })
    await expect(cached.score({ artifact: { at: new Date(0) }, scenario, signal })).rejects.toThrow(
      LedgerCanonicalizationError,
    )
  })

  it('requires a non-empty judgeVersion', () => {
    const { judge } = makeFakeJudge()
    expect(() => cachedJudge(judge, inMemoryVerdictCache(), { judgeVersion: '' })).toThrow(
      /judgeVersion is required/,
    )
  })

  it('preserves name, dimensions, and appliesTo', () => {
    const { judge } = makeFakeJudge()
    const appliesTo = (s: { kind: string }) => s.kind === 'unit'
    const wrapped = cachedJudge({ ...judge, appliesTo }, inMemoryVerdictCache(), {
      judgeVersion: 'v1',
    })
    expect(wrapped.name).toBe('fake-judge')
    expect(wrapped.dimensions).toEqual(judge.dimensions)
    expect(wrapped.appliesTo).toBe(appliesTo)
  })
})

describe('fileVerdictCache', () => {
  it('round-trips verdicts across store instances via the JSONL file', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'verdict-cache-')), 'cache.jsonl')
    const { judge, calls } = makeFakeJudge()

    await cachedJudge(judge, fileVerdictCache(path), { judgeVersion: 'v1' }).score({
      artifact: 'persisted',
      scenario,
      signal,
    })
    // Fresh store instance reads the file back — score() must not run again.
    const reloaded = cachedJudge(judge, fileVerdictCache(path), { judgeVersion: 'v1' })
    const score = await reloaded.score({ artifact: 'persisted', scenario, signal })

    expect(calls()).toBe(1)
    expect(score.notes).toBe('judged 9 chars')
    expect(reloaded.stats()).toEqual({ hits: 1, misses: 0 })
  })

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

  it('appends one JSONL line per set', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'verdict-cache-')), 'lines.jsonl')
    const { judge } = makeFakeJudge()
    const wrapped = cachedJudge(judge, fileVerdictCache(path), { judgeVersion: 'v1' })

    await wrapped.score({ artifact: 'a', scenario, signal })
    await wrapped.score({ artifact: 'bb', scenario, signal })
    await wrapped.score({ artifact: 'a', scenario, signal })

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })
})
