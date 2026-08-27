import { describe, expect, it } from 'vitest'

import { CostLedger } from './cost-ledger'
import { runIntentMatchJudge } from './intent-match-judge'

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
        usage: { total_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

describe('runIntentMatchJudge', () => {
  it('returns available=false when no input artifact', async () => {
    const r = await runIntentMatchJudge({ userRequest: 'build a thing', sourceFiles: [] })
    expect(r.available).toBe(false)
    expect(r.error).toBe('no input artifact')
    expect(r.score).toBe(0)
  })

  it('returns score and evidence on a happy LLM call', async () => {
    const costLedger = new CostLedger()
    const fetch = mockFetch([
      {
        score: 0.92,
        evidence: 'src/App.tsx renders <MintWidget /> with mint-1/mint-5 buttons',
      },
    ])
    const r = await runIntentMatchJudge(
      {
        userRequest: 'build an NFT mint page',
        sourceFiles: [
          {
            path: 'src/App.tsx',
            content:
              'import { MintWidget } from "./MintWidget"\nexport default function App() { return <MintWidget /> }',
          },
        ],
      },
      { llm: { fetch }, costLedger },
    )

    expect(r.available).toBe(true)
    expect(r.score).toBe(0.92)
    expect(r.evidence).toContain('MintWidget')
    expect(costLedger.list()).toEqual([
      expect.objectContaining({ channel: 'judge', actor: 'intent-match' }),
    ])
  })

  it('soft-fails (available=false) on LLM 500', async () => {
    const fetch = mockFetch([{ status: 500, body: 'upstream error' }])
    const r = await runIntentMatchJudge(
      { userRequest: 'x', sourceFiles: [{ path: 'a.ts', content: 'x' }] },
      { llm: { fetch, maxRetries: 1 } },
    )
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/500|upstream/i)
  })

  it('clamps score to [0, 1]', async () => {
    const fetch = mockFetch([{ score: 1.5, evidence: 'overshoot' }])
    const r = await runIntentMatchJudge(
      { userRequest: 'x', sourceFiles: [{ path: 'a.ts', content: 'x' }] },
      { llm: { fetch } },
    )
    expect(r.score).toBe(1)
  })
})
