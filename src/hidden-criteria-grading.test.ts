import { describe, expect, it } from 'vitest'
import type { JudgeScore } from './campaign/types'
import { ValidationError } from './errors'
import {
  agentVisibleFields,
  assertNoHiddenLeak,
  blendHeldout,
  defaultBlendWeights,
  type FieldDestination,
  gradeOnHidden,
  type HiddenCriteriaGrader,
  hiddenGrade,
  isHiddenDestination,
  routeFields,
  withHeldoutBlend,
} from './hidden-criteria-grading'

// A NON-coding domain proves the firewall has no domain coupling: here it is a
// legal-brief task. The agent sees the question + a sample citation; the hidden
// "answer key" (the required holdings) and the rubric anchors are graded but
// never reach the agent. Any domain plugs in its own grader the same way.
const legalRouting = {
  question: 'agent-visible',
  sampleCitation: 'develop-against',
  requiredHoldings: 'grading-only',
  rubricNote: 'judge-only',
} as const satisfies Record<string, FieldDestination>

const legalValues = {
  question: 'Draft a brief arguing the search violated the Fourth Amendment.',
  sampleCitation: 'See Katz v. United States, 389 U.S. 347 (1967).',
  requiredHoldings: 'Must cite Carpenter v. United States and the third-party-doctrine limit.',
  rubricNote: 'Reward a clean reasonable-expectation-of-privacy framing.',
} as const

describe('field routing by destination', () => {
  it('classifies grading-only and judge-only as hidden, the rest as visible', () => {
    expect(isHiddenDestination('grading-only')).toBe(true)
    expect(isHiddenDestination('judge-only')).toBe(true)
    expect(isHiddenDestination('agent-visible')).toBe(false)
    expect(isHiddenDestination('develop-against')).toBe(false)
  })

  it('routes a domain field map into RoutedFields', () => {
    const fields = routeFields(legalRouting, legalValues)
    expect(fields).toHaveLength(4)
    expect(fields.find((f) => f.name === 'requiredHoldings')?.destination).toBe('grading-only')
  })

  it('fails loud when a routed field has no value', () => {
    expect(() =>
      routeFields({ a: 'agent-visible', b: 'grading-only' }, { a: 'present' } as unknown as Record<
        'a' | 'b',
        string
      >),
    ).toThrow(ValidationError)
  })

  it('agentVisibleFields keeps only the non-hidden fields', () => {
    const visible = agentVisibleFields(routeFields(legalRouting, legalValues))
    const names = visible.map((f) => f.name).sort()
    expect(names).toEqual(['question', 'sampleCitation'])
  })
})

describe('assertNoHiddenLeak — the firewall', () => {
  const fields = routeFields(legalRouting, legalValues)

  it('passes when the agent context holds only visible fields', () => {
    const cleanContext = `${legalValues.question}\n${legalValues.sampleCitation}`
    expect(() => assertNoHiddenLeak(fields, cleanContext)).not.toThrow()
  })

  it('REJECTS when a grading-only field reaches the agent context', () => {
    const leakyContext = `${legalValues.question}\n${legalValues.requiredHoldings}`
    let thrown: unknown
    try {
      assertNoHiddenLeak(fields, leakyContext)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ValidationError)
    expect((thrown as Error).message).toMatch(/requiredHoldings/)
    expect((thrown as Error).message).toMatch(/grading-only/)
  })

  it('REJECTS when a judge-only field reaches the agent context', () => {
    const leakyContext = `${legalValues.question}\n${legalValues.rubricNote}`
    expect(() => assertNoHiddenLeak(fields, leakyContext)).toThrow(/judge-only/)
  })

  it('does not flag a develop-against field that appears in the context (intentional)', () => {
    const tddContext = `${legalValues.question}\n${legalValues.sampleCitation}`
    expect(() => assertNoHiddenLeak(fields, tddContext)).not.toThrow()
  })

  it('skips a too-short hidden value (no spurious substring match)', () => {
    const fields = routeFields(
      { task: 'agent-visible', key: 'grading-only' },
      { task: 'Summarize the contract clause about indemnity.', key: 'A' },
    )
    expect(() => assertNoHiddenLeak(fields, 'A wholly innocent prompt.')).not.toThrow()
  })
})

describe('hiddenGrade — honest pass-rate normalization', () => {
  it('computes passRate = passed / total', () => {
    expect(hiddenGrade(3, 4).passRate).toBeCloseTo(0.75)
  })

  it('returns 0 (honest no-run) when total is 0', () => {
    const g = hiddenGrade(0, 0, 'criteria did not run')
    expect(g.passRate).toBe(0)
    expect(g.total).toBe(0)
    expect(g.notes).toBe('criteria did not run')
  })

  it('never reports passed above total', () => {
    expect(hiddenGrade(9, 4).passed).toBe(4)
  })
})

describe('gradeOnHidden — firewall + domain grader wired', () => {
  // The domain's OWN grader: check the brief artifact against the hidden
  // required-holdings string. The substrate bakes in NO node/test/exec — this
  // grader is pure string matching; a coding domain would run node --test here.
  const legalGrader: HiddenCriteriaGrader<{ brief: string }, { mustCite: string[] }> = (
    artifact,
    hidden,
  ) => {
    const passed = hidden.mustCite.filter((c) => artifact.brief.includes(c)).length
    return hiddenGrade(passed, hidden.mustCite.length)
  }

  const fields = routeFields(legalRouting, legalValues)
  const agentContext = `${legalValues.question}\n${legalValues.sampleCitation}`

  it('grades against the hidden criteria behind the firewall', async () => {
    const result = await gradeOnHidden({
      artifact: { brief: 'We rely on Carpenter v. United States and Katz.' },
      hiddenCriteria: { mustCite: ['Carpenter v. United States', 'Katz'] },
      grader: legalGrader,
      firewall: { fields, agentContext },
    })
    expect(result.passRate).toBe(1)
    expect(result.total).toBe(2)
  })

  it('throws BEFORE grading if the firewall is breached at grading time', async () => {
    const leaky = `${agentContext}\n${legalValues.requiredHoldings}`
    await expect(
      gradeOnHidden({
        artifact: { brief: 'irrelevant' },
        hiddenCriteria: { mustCite: ['Carpenter v. United States'] },
        grader: legalGrader,
        firewall: { fields, agentContext: leaky },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('blendHeldout — composite weighting', () => {
  it('composes with the default 0.7 / 0.3 weights', () => {
    // 0.7 * 1.0 (perfect held-out) + 0.3 * 0.5 (mediocre judge) = 0.85
    expect(blendHeldout(1, 0.5)).toBeCloseTo(0.85)
    // 0.7 * 0.0 (failed held-out) + 0.3 * 1.0 (loved by judge) = 0.30 (capped low)
    expect(blendHeldout(0, 1)).toBeCloseTo(0.3)
    expect(defaultBlendWeights).toEqual({ heldout: 0.7, judge: 0.3 })
  })

  it('renormalizes arbitrary positive weight ratios', () => {
    // 3:1 ratio == 0.75 / 0.25
    expect(blendHeldout(1, 0, { heldout: 3, judge: 1 })).toBeCloseTo(0.75)
    expect(blendHeldout(0, 1, { heldout: 1, judge: 1 })).toBeCloseTo(0.5)
  })

  it('clamps out-of-range inputs to [0,1]', () => {
    expect(blendHeldout(2, -1)).toBeCloseTo(0.7) // 0.7*1 + 0.3*0
  })

  it('throws on a non-positive weight sum', () => {
    expect(() => blendHeldout(1, 1, { heldout: 0, judge: 0 })).toThrow(ValidationError)
  })
})

describe('withHeldoutBlend — judge composite becomes the blend', () => {
  const baseScore = (_input: { artifact: { heldoutPassRate: number } }): JudgeScore => ({
    dimensions: { quality: 0.5 },
    composite: 0.5,
    notes: 'style ok',
  })

  it('replaces the judge composite with the held-out-weighted blend', async () => {
    const blended = withHeldoutBlend(baseScore, (a) => a.heldoutPassRate)
    const out = await blended({ artifact: { heldoutPassRate: 1 } })
    // 0.7 * 1.0 + 0.3 * 0.5 = 0.85
    expect(out.composite).toBeCloseTo(0.85)
    expect(out.dimensions).toEqual({ quality: 0.5 })
    expect(out.notes).toMatch(/held-out 100%/)
  })

  it('passes a failed judge verdict through untouched', async () => {
    const failing = (_i: { artifact: { heldoutPassRate: number } }): JudgeScore => ({
      dimensions: {},
      composite: 0,
      notes: 'judge errored',
      failed: true,
    })
    const blended = withHeldoutBlend(failing, (a) => a.heldoutPassRate)
    const out = await blended({ artifact: { heldoutPassRate: 1 } })
    expect(out.failed).toBe(true)
    expect(out.composite).toBe(0)
  })
})
