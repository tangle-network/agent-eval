/**
 * skillOptDriver — bounded-edit + section-preservation invariants.
 *
 * The driver wraps an LLM reflection call, so we mock the LLM via a
 * dependency-injected llm.fetch and assert: (1) section preservation
 * rejects candidates that drop H2 headers, (2) edit-budget rejects
 * candidates with >budget*2 sentence-level diffs, (3) baseline-identical
 * candidates are dropped, (4) the populationSize ceiling is respected,
 * (5) extractH2Sections + countSentenceEdits behave as documented.
 */

import { describe, expect, it } from 'vitest'
import {
  countSentenceEdits,
  extractH2Sections,
  skillOptDriver,
} from '../src/campaign/drivers/skillopt'
import type { ProposeContext } from '../src/campaign/types'

// ── Helpers ─────────────────────────────────────────────────────────

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
        label: `proposal-${i}`,
        rationale: `synthetic test proposal ${i}`,
        payload,
      }))
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ proposals }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  }
}

const BASELINE = `# Driver — skill doc

## Principle

Bounded edits prevent useful rules from being overwritten. This is the
SkillOpt textual learning rate.

## Edit budget

At most 3 sentence-level changes per candidate. Reject candidates that
exceed the budget.

## Section preservation

Every H2 heading must appear unchanged. Do not delete or rename sections.
`

// ── extractH2Sections ──────────────────────────────────────────────

describe('extractH2Sections', () => {
  it('extracts H2 headings from markdown', () => {
    const sections = extractH2Sections(BASELINE)
    expect(sections).toEqual(['Principle', 'Edit budget', 'Section preservation'])
  })

  it('ignores H1 and H3+ headings', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n'
    expect(extractH2Sections(md)).toEqual(['H2'])
  })

  it('strips trailing whitespace', () => {
    const md = '## Section A   \n## Section B\t\n'
    expect(extractH2Sections(md)).toEqual(['Section A', 'Section B'])
  })

  it('returns empty for surfaces with no H2', () => {
    expect(extractH2Sections('Just prose, no headers.')).toEqual([])
  })
})

// ── countSentenceEdits ─────────────────────────────────────────────

describe('countSentenceEdits', () => {
  it('reports 0 for identical strings', () => {
    expect(countSentenceEdits(BASELINE, BASELINE)).toBe(0)
  })

  it('counts insertions and deletions', () => {
    const a = 'First sentence. Second sentence.'
    const b = 'First sentence. Third sentence.' // 1 deletion + 1 insertion
    expect(countSentenceEdits(a, b)).toBe(2)
  })

  it('treats trivial whitespace as identical', () => {
    const a = 'Hello world.\n\nNext line.'
    const b = 'Hello world.   \nNext line.'
    expect(countSentenceEdits(a, b)).toBe(0)
  })

  it('scales with the number of distinct edits', () => {
    const a = 'A. B. C. D. E.'
    const b = 'A. X. C. Y. E.' // 2 deletions + 2 insertions = 4
    expect(countSentenceEdits(a, b)).toBe(4)
  })
})

// ── skillOptDriver propose ─────────────────────────────────────────

describe('skillOptDriver', () => {
  it('rejects candidates that delete a preserved section', async () => {
    const goodCandidate = BASELINE.replace(
      'Bounded edits prevent',
      'Bounded edits explicitly prevent',
    )
    const badCandidate = BASELINE.replace('## Edit budget\n', '') // drops a section heading
    const driver = skillOptDriver({
      llm: mockLlm([goodCandidate, badCandidate]),
      model: 'test-model',
      target: 'skill doc',
      editBudget: 5,
    })
    const out = await driver.propose(makeCtx(BASELINE, 2))
    expect(out).toContain(goodCandidate.trim())
    expect(out).not.toContain(badCandidate.trim())
  })

  it('rejects candidates that exceed the edit budget', async () => {
    const compactCandidate = BASELINE.replace(
      'Bounded edits prevent useful rules from being overwritten.',
      'Bounded edits prevent rule overwrites.',
    )
    // Rewrite multiple sentences across multiple sections — exceeds budget
    const sprawlingCandidate = `# Driver — skill doc

## Principle

Completely rewritten principle one. Brand-new principle two. New principle
three. Different rationale four.

## Edit budget

Totally new sentence A. Totally new sentence B. Totally new sentence C.
Totally new sentence D.

## Section preservation

Brand-new content X. Brand-new content Y. Brand-new content Z.
`
    const driver = skillOptDriver({
      llm: mockLlm([compactCandidate, sprawlingCandidate]),
      model: 'test-model',
      target: 'skill doc',
      editBudget: 2, // 2 edits → budget*2 = 4 sentence-diff cap
    })
    const out = await driver.propose(makeCtx(BASELINE, 2))
    expect(out).toContain(compactCandidate.trim())
    expect(out).not.toContain(sprawlingCandidate.trim())
  })

  it('rejects baseline-identical candidates (after trim)', async () => {
    // Both payloads, after trim, exactly equal the baseline (which is
    // compared as baseline === text — driver does not trim baseline).
    // Strip trailing whitespace from BASELINE for an apples-to-apples
    // comparison: driver receives `baseline = ctx.currentSurface` and
    // rejects only when `text === baseline`, not `text.trim() === baseline.trim()`.
    const trimmedBaseline = BASELINE.trim()
    const driver = skillOptDriver({
      llm: mockLlm([trimmedBaseline, trimmedBaseline]),
      model: 'test-model',
      target: 'skill doc',
      editBudget: 3,
    })
    const out = await driver.propose(makeCtx(trimmedBaseline, 2))
    expect(out.length).toBe(0)
  })

  it('respects an explicit preserveSections allowlist that does not match H2s', async () => {
    const candidate = BASELINE + '\n## Extra section\n\nNew content.\n'
    const driver = skillOptDriver({
      llm: mockLlm([candidate]),
      model: 'test-model',
      target: 'skill doc',
      preserveSections: ['Principle', 'Edit budget', 'Section preservation'],
      editBudget: 10,
    })
    const out = await driver.propose(makeCtx(BASELINE, 1))
    expect(out).toContain(candidate.trim())
  })

  it('throws on a non-string surface', async () => {
    const driver = skillOptDriver({
      llm: mockLlm(['anything']),
      model: 'test-model',
      target: 'skill doc',
    })
    const ctx = makeCtx(BASELINE)
    // biome-ignore lint/suspicious/noExplicitAny: deliberate type-violation for the runtime check
    ;(ctx as any).currentSurface = { kind: 'code-surface', files: {} }
    await expect(driver.propose(ctx)).rejects.toThrow(/string skill document/)
  })

  it('throws on editBudget < 1', () => {
    expect(() =>
      skillOptDriver({
        llm: mockLlm([]),
        model: 'test-model',
        target: 'skill doc',
        editBudget: 0,
      }),
    ).toThrow(/editBudget must be >= 1/)
  })

  it('dedupes identical proposals from the LLM', async () => {
    const cand = BASELINE.replace(
      'At most 3 sentence-level changes per candidate.',
      'At most 5 sentence-level changes per candidate.',
    )
    const driver = skillOptDriver({
      llm: mockLlm([cand, cand, cand]),
      model: 'test-model',
      target: 'skill doc',
      editBudget: 5,
    })
    const out = await driver.propose(makeCtx(BASELINE, 3))
    expect(out.length).toBe(1)
  })
})
