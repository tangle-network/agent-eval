import { describe, expect, it } from 'vitest'
import {
  evaluateOracles,
  jsonShape,
  notBlocked,
  regexMatches,
  textInSnapshot,
  urlContains,
} from './oracle'

describe('declarative oracles', () => {
  it('textInSnapshot matches case-insensitively by default and carries an excerpt', () => {
    const result = textInSnapshot('Order Confirmed').check({
      text: 'Thanks! Your ORDER CONFIRMED at 12:01.',
    })
    expect(result.pass).toBe(true)
    expect(result.evidence).toContain('ORDER CONFIRMED')
    expect(
      textInSnapshot('Order Confirmed', { caseSensitive: true }).check({ text: 'order confirmed' })
        .pass,
    ).toBe(false)
  })

  it('urlContains, regexMatches and jsonShape decide from their own observation fields', () => {
    expect(urlContains('/checkout').check({ url: 'https://x.test/Checkout/done' }).pass).toBe(true)
    expect(regexMatches(/total: \d+/).check({ text: 'total: 42' }).pass).toBe(true)
    expect(
      jsonShape({ status: 'ok', id: 're:^run-' }).check({
        json: { status: 'ok', id: 'run-7' },
      }).pass,
    ).toBe(true)
    expect(jsonShape({ status: 'ok' }).check({ json: { status: 'failed' } }).pass).toBe(false)
  })

  it('notBlocked fails on an anti-bot marker and names the blocker', () => {
    const blocked = notBlocked().check({ text: 'Just a moment... verifying you are human' })
    expect(blocked.pass).toBe(false)
    expect(blocked.detail).toContain('cloudflare')
  })
})

describe('evaluateOracles — the verdict spine', () => {
  const passing = textInSnapshot('done')
  const failing = urlContains('/missing')

  it('lands in DefaultVerdict: valid, score, per-oracle scores, and a test-strategy certification', () => {
    const report = evaluateOracles({ text: 'all done', url: 'https://x.test/home' }, [
      passing,
      failing,
    ])
    expect(report.valid).toBe(false)
    expect(report.score).toBe(0.5)
    expect(report.scores).toEqual({ 'text-in-snapshot(done)': 1, 'url-contains(/missing)': 0 })
    expect(report.passCount).toBe(1)
    expect(report.failCount).toBe(1)
    expect(report.certification?.strategy).toBe('test')
    expect(report.certification?.checker.name).toBe('agent-eval:declarative-oracles')
    expect(report.certification?.checker.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(report.certification?.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('an empty oracle set never passes vacuously', () => {
    const report = evaluateOracles({ text: 'anything' }, [])
    expect(report.valid).toBe(false)
    expect(report.score).toBe(0)
  })

  it('the evidence digest is stable, including over a result with no evidence excerpt', () => {
    // A failed text oracle carries `evidence: undefined` — the digest covers
    // the JSON-serialized results, so the absent field must not throw.
    const oracles = [passing, textInSnapshot('nope')]
    const a = evaluateOracles({ text: 'all done' }, oracles)
    const b = evaluateOracles({ text: 'all done' }, oracles)
    expect(a.certification?.evidenceDigest).toBe(b.certification?.evidenceDigest)
  })
})
