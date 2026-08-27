import { describe, expect, it } from 'vitest'
import { CostLedger } from './cost-ledger'
import { createSemanticConceptJudge, runSemanticConceptJudge } from './semantic-concept-judge'

function mockFetch(bodies: Array<object | { status: number; body: string }>) {
  let call = 0
  return (async () => {
    const spec = bodies[Math.min(call, bodies.length - 1)]!
    call++
    if ('status' in spec && 'body' in spec) {
      return new Response((spec as { body: string }).body, {
        status: (spec as { status: number }).status,
      })
    }
    return new Response(
      JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: JSON.stringify(spec) } }],
        usage: { total_tokens: 100 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

const BASE_INPUT = {
  userRequest: 'Build an NFT mint page with supply counter, mint button, price.',
  sourceFiles: [
    { path: 'src/App.tsx', content: 'export default function App() { return <div>Mint</div>; }' },
  ],
  expectedConcepts: [
    { name: 'mint button', keywords: ['mint'] },
    { name: 'supply counter', keywords: ['minted', 'total'] },
  ],
}

describe('semantic-concept-judge', () => {
  it('parses a happy-path response + computes score from per-concept averages', async () => {
    const costLedger = new CostLedger()
    const fetch = mockFetch([
      {
        summary: 'mint button wired, supply counter absent',
        concepts: [
          {
            concept: 'mint button',
            present: true,
            score: 9,
            evidence: 'src/App.tsx:1',
            severity: 'info',
          },
          {
            concept: 'supply counter',
            present: false,
            score: 0,
            evidence: 'absent — no code displays totals',
            severity: 'critical',
          },
        ],
      },
    ])
    const r = await runSemanticConceptJudge(BASE_INPUT, { llm: { fetch }, costLedger })
    expect(r.available).toBe(true)
    expect(r.totalCount).toBe(2)
    expect(r.presentCount).toBe(1)
    // (9 + 0) / 2 = 4.5 / 10 = 0.45
    expect(r.score).toBeCloseTo(0.45, 2)
    expect(r.findings).toHaveLength(2)
    const critical = r.findings.find((f) => f.severity === 'critical')
    expect(critical?.concept).toBe('supply counter')
    expect(costLedger.list()).toEqual([
      expect.objectContaining({ channel: 'judge', actor: 'semantic-concept' }),
    ])
  })

  it('clamps out-of-range scores to 0..10', async () => {
    const fetch = mockFetch([
      {
        summary: 'out-of-range model response',
        concepts: [
          { concept: 'mint button', present: true, score: 42, evidence: 'e', severity: 'info' },
          {
            concept: 'supply counter',
            present: false,
            score: -5,
            evidence: 'e',
            severity: 'major',
          },
        ],
      },
    ])
    const r = await runSemanticConceptJudge(BASE_INPUT, { llm: { fetch } })
    expect(r.findings[0]!.score).toBe(10)
    expect(r.findings[1]!.score).toBe(0)
  })

  it('coerces invalid severity to "info"', async () => {
    const fetch = mockFetch([
      {
        summary: 's',
        concepts: [{ concept: 'x', present: true, score: 5, evidence: 'e', severity: 'nonsense' }],
      },
    ])
    const r = await runSemanticConceptJudge(
      { ...BASE_INPUT, expectedConcepts: [{ name: 'x' }] },
      { llm: { fetch } },
    )
    expect(r.findings[0]!.severity).toBe('info')
  })

  it('soft-fails available=false on malformed response (no concepts array)', async () => {
    const fetch = mockFetch([{ summary: 'oops', concepts: 'not an array' }])
    const r = await runSemanticConceptJudge(BASE_INPUT, { llm: { fetch } })
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/malformed/)
    expect(r.score).toBe(0)
  })

  it('soft-fails available=false on LLM 500', async () => {
    const fetch = mockFetch([{ status: 500, body: 'upstream oops' }])
    const r = await runSemanticConceptJudge(BASE_INPUT, { llm: { fetch, maxRetries: 1 } })
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/500/)
  })

  it('returns available=false on empty expectedConcepts (no-op)', async () => {
    const r = await runSemanticConceptJudge(
      { ...BASE_INPUT, expectedConcepts: [] },
      { llm: { fetch: mockFetch([]) } },
    )
    expect(r.available).toBe(false)
    expect(r.totalCount).toBe(0)
    expect(r.error).toMatch(/no expected concepts/)
  })

  it('weightConcepts: complexity weights integrate concepts higher than render', async () => {
    const fetch = mockFetch([
      {
        summary: 's',
        concepts: [
          // Render concept: high score
          { concept: 'mint button', present: true, score: 10, evidence: 'e', severity: 'info' },
          // Integrate concept: low score
          {
            concept: 'wallet connect',
            present: false,
            score: 0,
            evidence: 'e',
            severity: 'critical',
          },
        ],
      },
    ])
    const r = await runSemanticConceptJudge(
      {
        ...BASE_INPUT,
        expectedConcepts: [
          { name: 'mint button', complexity: 'render' },
          { name: 'wallet connect', complexity: 'integrate' },
        ],
      },
      { llm: { fetch }, weightConcepts: 'complexity' },
    )
    // weighted: (1.0*10 + 2.0*0) / (1.0 + 2.0) = 10/3 = 3.33 → /10 = 0.333
    expect(r.score).toBeCloseTo(0.333, 2)
  })

  it('weightConcepts: mean (default) gives equal weight (preserves 0.10 behavior)', async () => {
    const fetch = mockFetch([
      {
        summary: 's',
        concepts: [
          { concept: 'mint button', present: true, score: 10, evidence: 'e', severity: 'info' },
          {
            concept: 'wallet connect',
            present: false,
            score: 0,
            evidence: 'e',
            severity: 'critical',
          },
        ],
      },
    ])
    const r = await runSemanticConceptJudge(
      {
        ...BASE_INPUT,
        expectedConcepts: [
          { name: 'mint button', complexity: 'render' },
          { name: 'wallet connect', complexity: 'integrate' },
        ],
      },
      { llm: { fetch } },
    )
    // mean: (10+0)/2 = 5 → /10 = 0.5
    expect(r.score).toBeCloseTo(0.5, 2)
  })

  it('weightConcepts: explicit weight overrides complexity-derived weight', async () => {
    const fetch = mockFetch([
      {
        summary: 's',
        concepts: [
          { concept: 'a', present: true, score: 10, evidence: 'e', severity: 'info' },
          { concept: 'b', present: true, score: 0, evidence: 'e', severity: 'info' },
        ],
      },
    ])
    const r = await runSemanticConceptJudge(
      {
        ...BASE_INPUT,
        expectedConcepts: [
          { name: 'a', complexity: 'render', weight: 5 },
          { name: 'b', complexity: 'integrate', weight: 1 },
        ],
      },
      { llm: { fetch }, weightConcepts: 'complexity' },
    )
    // (5*10 + 1*0) / (5 + 1) = 50/6 = 8.33 → /10 = 0.833
    expect(r.score).toBeCloseTo(0.833, 2)
  })

  it('createSemanticConceptJudge factory — closure over options', async () => {
    const fetch = mockFetch([
      {
        summary: 's',
        concepts: [
          { concept: 'mint button', present: true, score: 8, evidence: 'e', severity: 'info' },
        ],
      },
      {
        summary: 's',
        concepts: [
          {
            concept: 'supply counter',
            present: false,
            score: 0,
            evidence: 'e',
            severity: 'critical',
          },
        ],
      },
    ])
    const judge = createSemanticConceptJudge({ llm: { fetch }, model: 'x' })
    const a = await judge({ ...BASE_INPUT, expectedConcepts: [{ name: 'mint button' }] })
    const b = await judge({ ...BASE_INPUT, expectedConcepts: [{ name: 'supply counter' }] })
    expect(a.findings[0]!.concept).toBe('mint button')
    expect(b.findings[0]!.severity).toBe('critical')
  })
})
