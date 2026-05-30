import { describe, expect, it } from 'vitest'
import { gepaDriver } from '../../src/campaign/drivers/gepa'
import type { GenerationRecord, ProposeContext } from '../../src/campaign/types'

/** A fake router fetch that echoes the reflection user-prompt back so the test
 *  can assert the driver fed the right evidence, and returns N proposals. */
function fakeFetch(capture: { userPrompt?: string }, payloads: string[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    capture.userPrompt = body.messages?.find((m: { role: string }) => m.role === 'user')?.content
    const proposals = payloads.map((p, i) => ({ label: `c${i}`, rationale: 'r', payload: p }))
    const content = JSON.stringify({ proposals })
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function ctxWith(history: GenerationRecord[], populationSize: number): ProposeContext {
  return {
    currentSurface: 'PARENT SURFACE',
    history,
    findings: [],
    populationSize,
    generation: history.length,
    signal: new AbortController().signal,
  }
}

describe('gepaDriver', () => {
  it('reflects on prior-generation evidence and returns proposed surfaces', async () => {
    const capture: { userPrompt?: string } = {}
    const driver = gepaDriver({
      llm: {
        apiKey: 'k',
        baseUrl: 'https://router.test/v1',
        fetch: fakeFetch(capture, ['NEW A', 'NEW B']),
      },
      model: 'test-model',
      target: 'system-directive',
    })

    const history: GenerationRecord[] = [
      {
        generationIndex: 0,
        promoted: ['h1'],
        candidates: [
          {
            surfaceHash: 'h1',
            composite: 0.6,
            ci95: [0.6, 0.6],
            dimensions: { clarity: 0.9, safety: 0.2 },
            scenarios: [
              { scenarioId: 'good', composite: 0.9 },
              { scenarioId: 'bad', composite: 0.1 },
            ],
          },
        ],
      },
    ]

    const out = await driver.propose(ctxWith(history, 2))

    // Candidates carry the driver's label + rationale (the "why"), not just
    // the payload — the regression: gepa.ts dropping proposal.label/rationale.
    expect(out).toEqual([
      { surface: 'NEW A', label: 'c0', rationale: 'r' },
      { surface: 'NEW B', label: 'c1', rationale: 'r' },
    ])
    // Evidence grounding: worst scenario + weakest dimension surfaced to the LLM.
    expect(capture.userPrompt).toContain('bad')
    expect(capture.userPrompt).toContain('safety')
    expect(capture.userPrompt).toContain('PARENT SURFACE')
  })

  it('drops the parent + dedupes proposals', async () => {
    const capture: { userPrompt?: string } = {}
    const driver = gepaDriver({
      llm: {
        apiKey: 'k',
        baseUrl: 'https://router.test/v1',
        fetch: fakeFetch(capture, ['PARENT SURFACE', 'KEEP', 'KEEP']),
      },
      model: 'test-model',
      target: 'system-directive',
    })
    const out = await driver.propose(ctxWith([], 3))
    expect(out).toEqual([{ surface: 'KEEP', label: 'c1', rationale: 'r' }])
  })

  it('generation 0 (no history) reflects on the surface alone', async () => {
    const capture: { userPrompt?: string } = {}
    const driver = gepaDriver({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: fakeFetch(capture, ['G0']) },
      model: 'test-model',
      target: 'system-directive',
    })
    const out = await driver.propose(ctxWith([], 1))
    expect(out).toEqual([{ surface: 'G0', label: 'c0', rationale: 'r' }])
    expect(capture.userPrompt).not.toContain('weakest dimensions')
  })
})
