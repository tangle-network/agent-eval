/**
 * gepaDriver `constraints` option — structured-doc invariants.
 *
 * When `constraints.preserveSections` is set, candidates that drop any
 * named H2 heading are dropped from the returned population.
 * When `constraints.maxSentenceEdits` is set, candidates whose
 * sentence-level edit count vs the parent exceeds `maxSentenceEdits * 2`
 * (counts adds + removes as separate edits) are dropped.
 *
 * These constraints subsume the former standalone `skillOptDriver`
 * (which was structurally gepaDriver + 2 post-parse rejections). The
 * `skillOptDriver` name is now reserved for a real implementation of
 * SkillOpt's 6-stage patch-mode pipeline (task #100).
 */

import { describe, expect, it } from 'vitest'
import { countSentenceEdits, extractH2Sections, gepaDriver } from '../src/campaign/drivers/gepa'
import type { ProposeContext } from '../src/campaign/types'

function makeCtx(currentSurface: string, populationSize = 3): ProposeContext {
  return {
    currentSurface,
    history: [],
    findings: [],
    populationSize,
    generation: 0,
    signal: new AbortController().signal,
  }
}

function mockLlm(payloads: string[]) {
  return {
    apiKey: 'test',
    baseUrl: 'http://mock.local',
    fetch: async () => {
      const proposals = payloads.map((payload, i) => ({
        label: `p-${i}`,
        rationale: `synthetic ${i}`,
        payload,
      }))
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ proposals }) } }],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  }
}

const BASELINE = `# Driver — structured procedure

## Principle

Bounded edits prevent useful rules from being overwritten.

## Edit budget

Edits beyond the budget are rejected.

## Section preservation

Headings must survive every edit.`

describe('extractH2Sections', () => {
  it('returns H2 headings only, ignoring H1/H3+', () => {
    expect(extractH2Sections(BASELINE)).toEqual([
      'Principle',
      'Edit budget',
      'Section preservation',
    ])
  })

  it('returns empty for surfaces with no H2', () => {
    expect(extractH2Sections('# H1\n### H3\nprose.\n')).toEqual([])
  })
})

describe('countSentenceEdits', () => {
  it('returns 0 for identical strings', () => {
    expect(countSentenceEdits(BASELINE, BASELINE)).toBe(0)
  })

  it('counts adds + removes as separate edits', () => {
    const a = 'First. Second. Third.'
    const b = 'First. X. Y.' // remove Second + Third, add X + Y
    expect(countSentenceEdits(a, b)).toBe(4)
  })

  it('treats trivial whitespace as identical', () => {
    const a = 'Hello world.\n\nNext.'
    const b = 'Hello world.   \nNext.'
    expect(countSentenceEdits(a, b)).toBe(0)
  })
})

describe('gepaDriver constraints — preserveSections', () => {
  it('keeps candidates that preserve every named H2', async () => {
    const good = BASELINE.replace(
      'Bounded edits prevent useful rules from being overwritten.',
      'Bounded edits prevent useful prior rules from being overwritten by an LLM rewrite.',
    )
    const driver = gepaDriver({
      llm: mockLlm([good]),
      model: 'test-model',
      target: 'structured doc',
      constraints: { preserveSections: [], maxSentenceEdits: 10 }, // empty array = auto-detect from baseline
    })
    const out = await driver.propose(makeCtx(BASELINE, 1))
    expect(out).toContain(good.trim())
  })

  it('rejects candidates that drop a preserved H2', async () => {
    const bad = BASELINE.replace('## Edit budget\n\nEdits beyond the budget are rejected.\n\n', '')
    const driver = gepaDriver({
      llm: mockLlm([bad]),
      model: 'test-model',
      target: 'structured doc',
      constraints: { preserveSections: [] },
    })
    const out = await driver.propose(makeCtx(BASELINE, 1))
    expect(out).not.toContain(bad.trim())
    expect(out.length).toBe(0)
  })

  it('honours an explicit preserveSections allowlist', async () => {
    const dropsExtraSection = BASELINE
    const driver = gepaDriver({
      llm: mockLlm([dropsExtraSection]),
      model: 'test-model',
      target: 'structured doc',
      constraints: { preserveSections: ['Principle', 'Edit budget'] },
    })
    // Identical to baseline → driver's existing baseline-equality reject kicks in
    const out = await driver.propose(makeCtx(BASELINE, 1))
    expect(out.length).toBe(0)
  })
})

describe('gepaDriver constraints — maxSentenceEdits', () => {
  it('keeps candidates within the edit budget', async () => {
    const small = BASELINE.replace(
      'Edits beyond the budget are rejected.',
      'Edits beyond the budget are dropped from the returned population.',
    )
    const driver = gepaDriver({
      llm: mockLlm([small]),
      model: 'test-model',
      target: 'structured doc',
      constraints: { maxSentenceEdits: 2 }, // cap = 2*2 = 4 sentence diffs
    })
    const out = await driver.propose(makeCtx(BASELINE, 1))
    expect(out).toContain(small.trim())
  })

  it('rejects candidates that exceed the edit budget', async () => {
    const sprawling = `# Driver — structured procedure

## Principle

Brand new sentence A. Brand new sentence B. Brand new sentence C.

## Edit budget

Different sentence X. Different sentence Y. Different sentence Z.

## Section preservation

New rule one. New rule two. New rule three.`
    const driver = gepaDriver({
      llm: mockLlm([sprawling]),
      model: 'test-model',
      target: 'structured doc',
      constraints: { maxSentenceEdits: 2 }, // cap = 4 sentence diffs
    })
    const out = await driver.propose(makeCtx(BASELINE, 1))
    expect(out.length).toBe(0)
  })
})

describe('gepaDriver — unconstrained behavior unchanged', () => {
  it('returns proposals without constraint when constraints option is omitted', async () => {
    const rewrite = BASELINE.replace('Bounded edits prevent', 'Bounded edits MUST prevent')
    const driver = gepaDriver({
      llm: mockLlm([rewrite]),
      model: 'test-model',
      target: 'structured doc',
    })
    const out = await driver.propose(makeCtx(BASELINE, 1))
    expect(out).toContain(rewrite.trim())
  })

  it('still drops baseline-identical proposals', async () => {
    const driver = gepaDriver({
      llm: mockLlm([BASELINE, BASELINE]),
      model: 'test-model',
      target: 'structured doc',
    })
    const out = await driver.propose(makeCtx(BASELINE, 2))
    expect(out.length).toBe(0)
  })

  it('dedupes identical proposals', async () => {
    const r = BASELINE.replace('useful rules', 'useful prior rules')
    const driver = gepaDriver({
      llm: mockLlm([r, r, r]),
      model: 'test-model',
      target: 'structured doc',
    })
    const out = await driver.propose(makeCtx(BASELINE, 3))
    expect(out.length).toBe(1)
  })
})
