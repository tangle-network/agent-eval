import { describe, expect, it } from 'vitest'
import type { Span } from '../trace/schema'
import {
  defaultProviderToolMatcher,
  extractRetrievedText,
  scoreGroundedness,
  scoreGroundednessForRun,
} from './index'

describe('scoreGroundedness', () => {
  it('scores the share of required knowledge the provider surfaced, case-insensitively', () => {
    const text = 'The current API uses createMiddleware from hono/factory and streamSSE.'
    const r = scoreGroundedness(text, ['createMiddleware', 'streamSSE', 'getRuntimeKey'])
    expect(r.total).toBe(3)
    expect(r.found.sort()).toEqual(['createMiddleware', 'streamSSE'])
    expect(r.missing).toEqual(['getRuntimeKey'])
    expect(r.score).toBeCloseTo(2 / 3)
    expect(r.hadResults).toBe(true)
  })

  it('matches case-insensitively but reports keys in their original casing', () => {
    const r = scoreGroundedness('imports * as Z from ZOD', ['z', 'zod'])
    expect(r.found).toEqual(['z', 'zod'])
    expect(r.score).toBe(1)
  })

  it('dedupes required keys (case-insensitive) so the denominator cannot be inflated', () => {
    const r = scoreGroundedness('uses viem', ['viem', 'VIEM', ' viem '])
    expect(r.total).toBe(1)
    expect(r.score).toBe(1)
  })

  it('fails open when there is no required knowledge (nothing to ground)', () => {
    const r = scoreGroundedness('', [])
    expect(r.score).toBe(1)
    expect(r.total).toBe(0)
    expect(r.hadResults).toBe(false)
  })

  it('distinguishes "no results" from "results that missed the facts"', () => {
    const empty = scoreGroundedness('', ['useReadContract'])
    expect(empty.hadResults).toBe(false)
    expect(empty.score).toBe(0)

    const missed = scoreGroundedness('here is some unrelated prose', ['useReadContract'])
    expect(missed.hadResults).toBe(true)
    expect(missed.score).toBe(0)
  })
})

describe('extractRetrievedText', () => {
  const base = { runId: 'r1', name: 'n', startedAt: 0 } as const

  it('reads RetrievalSpan hit content', () => {
    const spans: Span[] = [
      {
        ...base,
        spanId: 's1',
        kind: 'retrieval',
        query: 'hono factory',
        hits: [
          { docId: 'd1', score: 0.9, content: 'createMiddleware from hono/factory' },
          { docId: 'd2', score: 0.4, content: 'streamSSE from hono/streaming' },
          { docId: 'd3', score: 0.1 }, // no content — skipped, not crashed
        ],
      },
    ]
    const text = extractRetrievedText(spans)
    expect(text).toContain('createMiddleware')
    expect(text).toContain('streamSSE')
  })

  it('reads provider ToolSpan results by the default matcher, skipping fetch + non-provider tools', () => {
    const spans: Span[] = [
      {
        ...base,
        spanId: 's1',
        kind: 'tool',
        toolName: 'web_search',
        args: { q: 'viem v2' },
        result: { snippets: ['useReadContract is current'] },
      },
      {
        ...base,
        spanId: 's2',
        kind: 'tool',
        toolName: 'fetch_url', // search/research-not-fetch default excludes this
        args: {},
        result: 'getContract legacy',
      },
      {
        ...base,
        spanId: 's3',
        kind: 'tool',
        toolName: 'write_file', // not a provider tool at all
        args: {},
        result: 'irrelevant',
      },
    ]
    const text = extractRetrievedText(spans)
    expect(text).toContain('useReadContract')
    expect(text).not.toContain('getContract legacy')
    expect(text).not.toContain('irrelevant')
  })

  it('honors an injected provider matcher (no benchmark literal baked in)', () => {
    const spans: Span[] = [
      {
        ...base,
        spanId: 's1',
        kind: 'tool',
        toolName: 'youcom',
        args: {},
        result: 'surfaced fact',
      },
    ]
    const isProviderTool = (name: string) => name === 'youcom'
    expect(extractRetrievedText(spans, { isProviderTool })).toContain('surfaced fact')
    // default matcher would NOT pick up 'youcom'
    expect(extractRetrievedText(spans)).toBe('')
  })

  it('default matcher accepts search/research and rejects fetch', () => {
    expect(defaultProviderToolMatcher('web_search')).toBe(true)
    expect(defaultProviderToolMatcher('deep_research')).toBe(true)
    expect(defaultProviderToolMatcher('fetch_url')).toBe(false)
    expect(defaultProviderToolMatcher('read_file')).toBe(false)
  })
})

describe('scoreGroundednessForRun', () => {
  it('extracts provider text from spans then scores it in one call', () => {
    const base = { runId: 'r1', name: 'n', startedAt: 0 } as const
    const spans: Span[] = [
      {
        ...base,
        spanId: 's1',
        kind: 'retrieval',
        query: 'wagmi v2',
        hits: [{ docId: 'd1', score: 0.9, content: 'useReadContract and useWriteContract' }],
      },
    ]
    const r = scoreGroundednessForRun(spans, [
      'useReadContract',
      'useWriteContract',
      'useContractRead',
    ])
    expect(r.found.sort()).toEqual(['useReadContract', 'useWriteContract'])
    expect(r.missing).toEqual(['useContractRead'])
    expect(r.score).toBeCloseTo(2 / 3)
  })
})
