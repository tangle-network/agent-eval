import { describe, expect, it } from 'vitest'
import { gepaDriver } from '../../src/campaign/drivers/gepa'
import type { GenerationRecord, ParetoParent, ProposeContext } from '../../src/campaign/types'

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

// ── GEPA combine-complementary-lessons (#101) ──────────────────────────────

/** JSON chat-completion response carrying `proposals`. */
function proposalResponse(proposals: Array<{ label: string; rationale: string; payload: string }>) {
  const content = JSON.stringify({ proposals })
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A router fetch that branches on the system prompt: the combine merge uses
 *  COMBINE_SYSTEM ("combine complementary lessons"), the reflection fill uses
 *  REFLECTION_SYSTEM. Captures each call's user prompt + counts them. */
function combineAwareFetch(capture: {
  combineUser?: string
  reflectUser?: string
  combineCalls: number
  reflectCalls: number
}): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const system: string =
      body.messages?.find((m: { role: string }) => m.role === 'system')?.content ?? ''
    const user: string =
      body.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? ''
    if (system.includes('combine complementary lessons')) {
      capture.combineUser = user
      capture.combineCalls += 1
      return proposalResponse([
        { label: 'merged', rationale: 'merge AB', payload: 'MERGED SURFACE' },
      ])
    }
    capture.reflectUser = user
    capture.reflectCalls += 1
    return proposalResponse([{ label: 'r0', rationale: 'r', payload: 'REFLECT SURFACE' }])
  }) as unknown as typeof fetch
}

const PARENT_A: ParetoParent = {
  surface: 'A surface — leads with the outcome',
  surfaceHash: 'ha',
  objectives: { easy: 0.9, hard: 0.1 },
  composite: 0.5,
  generation: 0,
  label: 'a',
}
const PARENT_B: ParetoParent = {
  surface: 'B surface — anchors every claim in the brief',
  surfaceHash: 'hb',
  objectives: { easy: 0.2, hard: 0.95 },
  composite: 0.58,
  generation: 0,
  label: 'b',
}

function ctxWithParents(parents: ParetoParent[], populationSize: number): ProposeContext {
  return {
    currentSurface: 'PARENT SURFACE',
    history: [],
    findings: [],
    populationSize,
    generation: 1,
    signal: new AbortController().signal,
    paretoParents: parents,
  }
}

describe('gepaDriver — combine complementary lessons', () => {
  it('spends one population slot merging >1 non-dominated parents, fills the rest by reflection', async () => {
    const capture = { combineCalls: 0, reflectCalls: 0 } as Parameters<typeof combineAwareFetch>[0]
    const driver = gepaDriver({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: combineAwareFetch(capture) },
      model: 'test-model',
      target: 'system-directive',
    })

    const out = await driver.propose(ctxWithParents([PARENT_A, PARENT_B], 2))

    // population 2 → 1 combine candidate (first) + 1 reflection candidate.
    expect(out).toEqual([
      { surface: 'MERGED SURFACE', label: 'merged', rationale: 'merge AB' },
      { surface: 'REFLECT SURFACE', label: 'r0', rationale: 'r' },
    ])
    expect(capture.combineCalls).toBe(1)
    expect(capture.reflectCalls).toBe(1)
    // The combine prompt cited BOTH parent surfaces + each one's strongest scenario.
    expect(capture.combineUser).toContain('A surface')
    expect(capture.combineUser).toContain('B surface')
    expect(capture.combineUser).toContain('easy') // A's strongest objective
    expect(capture.combineUser).toContain('hard') // B's strongest objective
    // Per-parent structure (not just keyword presence): each parent's section
    // lists ITS OWN strengths, strongest-first. Parents are labeled A/B/… by
    // composite-descending, so identify each by its mean: PARENT_A (mean 0.50)
    // wins 'easy' (0.9 > 0.1) → easy before hard; PARENT_B (mean 0.58) wins
    // 'hard' (0.95 > 0.2) → hard before easy. A regression citing objectives
    // globally / paired to the wrong parent would fail this.
    const lines = capture.combineUser!.split('\n')
    const parentA = lines.find((l) => l.startsWith('### Version') && l.includes('mean 0.50'))!
    const parentB = lines.find((l) => l.startsWith('### Version') && l.includes('mean 0.58'))!
    expect(parentA.indexOf('easy')).toBeLessThan(parentA.indexOf('hard'))
    expect(parentB.indexOf('hard')).toBeLessThan(parentB.indexOf('easy'))
  })

  it('does NOT combine with a single Pareto parent (pure reflection)', async () => {
    const capture = { combineCalls: 0, reflectCalls: 0 } as Parameters<typeof combineAwareFetch>[0]
    const driver = gepaDriver({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: combineAwareFetch(capture) },
      model: 'test-model',
      target: 'system-directive',
    })
    const out = await driver.propose(ctxWithParents([PARENT_A], 2))
    expect(capture.combineCalls).toBe(0)
    expect(capture.reflectCalls).toBe(1)
    expect(out).toEqual([{ surface: 'REFLECT SURFACE', label: 'r0', rationale: 'r' }])
  })

  it('combineParents:false disables the merge even with >1 parents', async () => {
    const capture = { combineCalls: 0, reflectCalls: 0 } as Parameters<typeof combineAwareFetch>[0]
    const driver = gepaDriver({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: combineAwareFetch(capture) },
      model: 'test-model',
      target: 'system-directive',
      combineParents: false,
    })
    await driver.propose(ctxWithParents([PARENT_A, PARENT_B], 2))
    expect(capture.combineCalls).toBe(0)
    expect(capture.reflectCalls).toBe(1)
  })

  it('populationSize 1 with combine yields ONLY the merge (budget honored)', async () => {
    const capture = { combineCalls: 0, reflectCalls: 0 } as Parameters<typeof combineAwareFetch>[0]
    const driver = gepaDriver({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: combineAwareFetch(capture) },
      model: 'test-model',
      target: 'system-directive',
    })
    const out = await driver.propose(ctxWithParents([PARENT_A, PARENT_B], 1))
    expect(out).toEqual([{ surface: 'MERGED SURFACE', label: 'merged', rationale: 'merge AB' }])
    expect(capture.combineCalls).toBe(1)
    expect(capture.reflectCalls).toBe(0) // no budget left for reflection
  })
})
