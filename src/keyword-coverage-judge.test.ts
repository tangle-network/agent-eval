import { describe, it, expect } from 'vitest'
import {
  runKeywordCoverageJudge,
  runKeywordCoverageJudgeUrl,
  htmlContainsElement,
  extractAssetUrls,
} from './keyword-coverage-judge'

describe('keyword-coverage — runKeywordCoverageJudge (content)', () => {
  it('counts concept as found when any keyword is in haystack', () => {
    const r = runKeywordCoverageJudge(
      '<h1>Mint Now</h1><p>0.05 ETH</p>',
      [
        { name: 'mint button', keywords: ['mint now', 'mint 1'] },
        { name: 'price', keywords: ['ETH', 'price'] },
      ],
    )
    expect(r.score).toBe(1)
    expect(r.presentCount).toBe(2)
    expect(r.findings[0]!.matchedKeywords).toEqual(['mint now'])
    expect(r.findings[1]!.matchedKeywords).toEqual(['ETH'])
  })

  it('case-insensitive keyword matching', () => {
    const r = runKeywordCoverageJudge('<p>Connect Wallet</p>', [
      { name: 'wallet', keywords: ['connect wallet'] },
    ])
    expect(r.findings[0]!.found).toBe(true)
  })

  it('requiredElement gate: blocks found when selector missing', () => {
    const r = runKeywordCoverageJudge(
      '<p>price 0.05 ETH</p>',
      [{ name: 'price', keywords: ['price'], requiredElement: 'input[type="number"]' }],
    )
    expect(r.findings[0]!.matchedKeywords).toEqual(['price'])
    expect(r.findings[0]!.requiredElementPresent).toBe(false)
    expect(r.findings[0]!.found).toBe(false)
    expect(r.score).toBe(0)
  })

  it('requiredElement gate: passes when both keyword + element match', () => {
    const r = runKeywordCoverageJudge(
      '<form><input type="number" name="price"/></form>',
      [{ name: 'price', keywords: ['price'], requiredElement: 'input[type="number"]' }],
    )
    expect(r.findings[0]!.found).toBe(true)
    expect(r.findings[0]!.requiredElementPresent).toBe(true)
  })

  it('unsupported selector → null requiredElementPresent → unenforced (passes on keyword alone)', () => {
    const r = runKeywordCoverageJudge('<p>price</p>', [
      { name: 'price', keywords: ['price'], requiredElement: 'div.complex > span:nth-child(2)' },
    ])
    expect(r.findings[0]!.requiredElementPresent).toBeNull()
    expect(r.findings[0]!.found).toBe(true)
  })

  it('absent concept: empty matchedKeywords, found=false', () => {
    const r = runKeywordCoverageJudge('<p>just a paragraph</p>', [
      { name: 'mint button', keywords: ['mint now', 'mint 1'] },
    ])
    expect(r.findings[0]!.found).toBe(false)
    expect(r.score).toBe(0)
  })

  it('empty expectedConcepts: score=0, totalCount=0', () => {
    const r = runKeywordCoverageJudge('<p>x</p>', [])
    expect(r.score).toBe(0)
    expect(r.totalCount).toBe(0)
    expect(r.findings).toHaveLength(0)
  })

  it('mixes html + assets into the haystack', () => {
    const r = runKeywordCoverageJudge(
      '<p>only html</p>',
      [{ name: 'wallet', keywords: ['wagmi'] }],
      ['import { useAccount } from "wagmi"'],
    )
    expect(r.findings[0]!.found).toBe(true)
  })
})

describe('keyword-coverage — htmlContainsElement', () => {
  it('tag-only matches case-insensitively', () => {
    expect(htmlContainsElement('<FORM></FORM>', 'form')).toBe(true)
    expect(htmlContainsElement('<div></div>', 'form')).toBe(false)
  })

  it('tag[attr="value"] matches with single or double quotes', () => {
    expect(htmlContainsElement('<input type="number"/>', 'input[type="number"]')).toBe(true)
    expect(htmlContainsElement("<input type='number'/>", 'input[type="number"]')).toBe(true)
    expect(htmlContainsElement('<input type="text"/>', 'input[type="number"]')).toBe(false)
  })

  it('tag[attr] (presence-only) matches', () => {
    expect(htmlContainsElement('<input required/>', 'input[required]')).toBe(true)
    expect(htmlContainsElement('<input/>', 'input[required]')).toBe(false)
  })

  it('unsupported selector returns null', () => {
    expect(htmlContainsElement('<p>x</p>', 'div > .child')).toBeNull()
    expect(htmlContainsElement('<p>x</p>', 'p::first-line')).toBeNull()
  })
})

describe('keyword-coverage — extractAssetUrls', () => {
  it('extracts both link[href] and script[src] resolved against base', () => {
    const urls = extractAssetUrls(
      '<link rel="stylesheet" href="/a.css"/><script src="/b.js"></script>',
      'https://x.example/page',
    )
    expect(urls).toContain('https://x.example/a.css')
    expect(urls).toContain('https://x.example/b.js')
  })

  it('skips data: URLs gracefully', () => {
    const urls = extractAssetUrls(
      '<script src="data:text/plain,hello"></script>',
      'https://x.example/',
    )
    expect(urls.some((u) => u.startsWith('data:'))).toBe(true)
  })
})

describe('keyword-coverage — runKeywordCoverageJudgeUrl', () => {
  it('fetches HTML + assets and scores', async () => {
    const fetch: typeof globalThis.fetch = (async (input: string) => {
      if (input.endsWith('/index.html')) {
        return new Response(
          '<link rel="stylesheet" href="/a.css"/><h1>Mint Now</h1>',
          { status: 200 },
        )
      }
      if (input.endsWith('/a.css')) {
        return new Response('.btn { color: red } /* mint button */', { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof globalThis.fetch

    const r = await runKeywordCoverageJudgeUrl(
      'https://example.test/index.html',
      [
        { name: 'mint button', keywords: ['mint now'] },
        { name: 'styling', keywords: ['btn'] },
      ],
      { fetch },
    )
    expect(r.score).toBe(1)
    expect(r.totalAssembledBytes).toBeGreaterThan(0)
  })

  it('soft-fails on 5xx', async () => {
    const fetch: typeof globalThis.fetch = (async () =>
      new Response('upstream', { status: 503 })) as unknown as typeof globalThis.fetch
    const r = await runKeywordCoverageJudgeUrl(
      'https://example.test/x',
      [{ name: 'a', keywords: ['x'] }],
      { fetch },
    )
    expect(r.error).toMatch(/HTTP 503/)
    expect(r.score).toBe(0)
  })

  it('soft-fails on network error', async () => {
    const fetch: typeof globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const r = await runKeywordCoverageJudgeUrl(
      'https://example.test/x',
      [{ name: 'a', keywords: ['x'] }],
      { fetch },
    )
    expect(r.error).toMatch(/ECONNREFUSED/)
  })

  it('returns empty result on empty expectedConcepts', async () => {
    const fetch: typeof globalThis.fetch = (async () =>
      new Response('<p>x</p>', { status: 200 })) as unknown as typeof globalThis.fetch
    const r = await runKeywordCoverageJudgeUrl('https://example.test/x', [], { fetch })
    expect(r.totalCount).toBe(0)
  })
})
