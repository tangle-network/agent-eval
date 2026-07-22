import { describe, expect, it } from 'vitest'
import type { GenerationRecord, ProposeContext } from '../types'
import { gepaProposer } from './gepa'

const EMITTED_EXCERPT = 'def add(a, b):\n    return a - b  # WRONG-OP-MARKER'
const FAILURE_NOTE = 'AssertionError: add(2, 2) == 4, got 0 (TRACEBACK-MARKER)'

function historyWithEmitted(): GenerationRecord[] {
  return [
    {
      generationIndex: 0,
      candidates: [
        {
          surfaceHash: 'hash-a',
          composite: 0.5,
          ci95: [0.5, 0.5],
          dimensions: { pass: 0.5 },
          scenarios: [
            { scenarioId: 'ok-scenario', composite: 1 },
            {
              scenarioId: 'failing-scenario',
              composite: 0,
              notes: FAILURE_NOTE,
              emitted: EMITTED_EXCERPT,
            },
          ],
        },
      ],
      promoted: ['hash-a'],
    },
  ]
}

describe('gepaProposer reflection evidence', () => {
  it('threads a breakdown row `emitted` excerpt into the reflection prompt', async () => {
    // Capture the reflection request through the llm-client's fetch seam
    // instead of module mocking — the same transport override real callers use.
    let userPrompt = ''
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
      }
      userPrompt = body.messages.find((m) => m.role === 'user')?.content ?? ''
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  proposals: [{ label: 'v1', rationale: 'r', payload: 'improved surface' }],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const proposer = gepaProposer({
      llm: { baseUrl: 'https://fake.test/v1', apiKey: 'test', fetch: fakeFetch },
      model: 'test-model',
      target: 'test surface',
    })
    const ctx: ProposeContext = {
      currentSurface: 'base surface',
      history: historyWithEmitted(),
      findings: [],
      populationSize: 1,
      generation: 1,
      signal: new AbortController().signal,
      track: {
        id: 'contrarian',
        operation: 'branch',
        proposer: 'gepa',
        vision: 'challenge assumptions with a distinct retrieval strategy',
        parentTrackIds: ['baseline'],
      },
    }
    const out = await proposer.propose(ctx)

    expect(out).toHaveLength(1)
    // The bottom-trial block must show BOTH the judge's why (failureNote) and
    // the candidate's own wrong output (emitted) — the trace evidence GEPA
    // reflection is supposed to ground on.
    expect(userPrompt).toContain('What the agent emitted')
    expect(userPrompt).toContain(EMITTED_EXCERPT)
    expect(userPrompt).toContain(FAILURE_NOTE)
    expect(userPrompt).toContain('Track objective (contrarian)')
    expect(userPrompt).toContain('challenge assumptions with a distinct retrieval strategy')
  })
})
