import { describe, expect, it } from 'vitest'
import { type AgentProfileCellInput, buildAgentProfileCell } from '../src/agent-profile-cell'
import {
  admitPolicyEdit,
  applyPolicyEditToSurface,
  makePolicyEdit,
  type PolicyEditChange,
  policyEditFromFinding,
  policyEditsFromFindings,
  scorePolicyEditReadiness,
  validatePolicyEdit,
} from '../src/analyst/policy-edit'
import { makeFinding } from '../src/analyst/types'

const EXPECTED_GAIN = {
  metric: 'holdout.composite',
  direction: 'increase' as const,
  amount: 0.12,
  unit: 'absolute' as const,
  rationale: 'failed traces show this exact missing instruction',
}

function finding(over: Parameters<typeof makeFinding>[0] = {}) {
  return makeFinding({
    analyst_id: 'trace-analyst',
    area: 'agent-reasoning',
    severity: 'high',
    subject: 'system-prompt:tool-use',
    claim: 'Agent mutates records before fetching current state.',
    rationale: 'The failed trace skipped a read-before-write step.',
    evidence_refs: [{ kind: 'span', uri: 'span://trace-1/span-7', excerpt: 'PATCH /record' }],
    recommended_action: 'Always fetch current state before mutating a record.',
    validation_plan: 'Run held-out update tasks and compare composite score.',
    confidence: 0.92,
    metadata: { policyEdit: { expectedGain: EXPECTED_GAIN, risk: 'low' } },
    ...over,
  })
}

function strongEdit() {
  const edit = policyEditFromFinding(finding())
  if (!edit) throw new Error('expected edit')
  return edit
}

function textEdit(change: Extract<PolicyEditChange, { kind: 'text' }>, id = 'f_text') {
  return makePolicyEdit({
    axis: 'representation',
    target: { surface: 'prompt', path: 'system-prompt:tool-use' },
    change,
    claim: 'Agent needs a deterministic instruction.',
    expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.04 },
    confidence: 0.85,
    risk: 'low',
    source: {
      findingIds: [id],
      analystIds: ['trace-analyst'],
      evidenceRefs: [{ kind: 'span', uri: `span://trace-1/${id}` }],
    },
  })
}

function jsonEdit(change: Extract<PolicyEditChange, { kind: 'json' }>, id = 'f_json') {
  return makePolicyEdit({
    axis: 'budget',
    target: { surface: 'runtime-config', path: change.path },
    change,
    claim: 'Runtime config needs a deterministic update.',
    expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.04 },
    confidence: 0.85,
    risk: 'low',
    source: {
      findingIds: [id],
      analystIds: ['trace-analyst'],
      evidenceRefs: [{ kind: 'metric', uri: `metric://${id}` }],
    },
  })
}

describe('PolicyEdit contract', () => {
  it('calibrates admission: strong edit >70%, weak edit <30%', () => {
    const strong = strongEdit()
    const strongAdmission = admitPolicyEdit(strong)

    const weak = makePolicyEdit({
      axis: 'representation',
      target: { surface: 'prompt' },
      change: { kind: 'text', mode: 'append', value: 'Maybe be better.' },
      claim: 'Maybe improve the prompt.',
      expectedGain: {
        metric: 'holdout.composite',
        direction: 'increase',
        amount: 0.001,
      },
      confidence: 0.2,
      risk: 'unknown',
      source: { findingIds: ['f_weak'], analystIds: ['trace-analyst'], evidenceRefs: [] },
    })
    const weakAdmission = admitPolicyEdit(weak)

    expect(scorePolicyEditReadiness(strong)).toBeGreaterThan(0.7)
    expect(strongAdmission.decision).toBe('admit')
    expect(scorePolicyEditReadiness(weak)).toBeLessThan(0.3)
    expect(weakAdmission.decision).toBe('reject')
    expect(weakAdmission.reasons).toContain('missing evidence refs')
  })

  it('derives an axis-typed edit from an analyst finding with expected gain metadata', () => {
    const edit = strongEdit()

    expect(edit.schemaVersion).toBe('policy-edit/v1')
    expect(edit.axis).toBe('representation')
    expect(edit.target).toMatchObject({ surface: 'prompt', path: 'system-prompt:tool-use' })
    expect(edit.change).toMatchObject({
      kind: 'text',
      mode: 'append',
      value: 'Always fetch current state before mutating a record.',
    })
    expect(edit.expectedGain).toEqual(EXPECTED_GAIN)
    expect(edit.source.findingIds).toEqual([finding().finding_id])
    expect(validatePolicyEdit(edit)).toBe(edit)
  })

  it('returns no edit when the finding lacks a typed expected gain', () => {
    const edit = policyEditFromFinding(finding({ metadata: undefined }))
    expect(edit).toBeNull()
  })

  it('rejects judge-derived findings before they become steering edits', () => {
    expect(() =>
      policyEditsFromFindings([
        finding({
          analyst_id: 'judge',
          derived_from_judge: true,
        }),
      ]),
    ).toThrow(/judge verdict cannot be admitted/)
  })

  it('validates canonical AgentProfileCell deployment targets without a local profile shape', async () => {
    const input: AgentProfileCellInput = {
      profileId: 'support-agent-v1',
      sourceProfile: {
        kind: 'agent-interface-profile',
        profile: { name: 'support-agent', version: '1.0.0' },
      },
      model: 'model-snapshot-2026-01-01',
      promptHash: 'p'.repeat(64),
    }
    const cell = await buildAgentProfileCell(input)
    const edit = makePolicyEdit({
      axis: 'agent_profile',
      target: { surface: 'agent-profile', path: 'dimensions.maxTurns', agentProfileCell: cell },
      change: { kind: 'json', mode: 'set', path: 'dimensions.maxTurns', value: 8 },
      claim: 'Profile should expose the turn budget as a measured dimension.',
      expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.03 },
      confidence: 0.8,
      risk: 'low',
      source: {
        findingIds: ['f_profile_budget'],
        analystIds: ['trace-analyst'],
        evidenceRefs: [{ kind: 'metric', uri: 'metric://turn_budget_exhausted' }],
      },
    })

    expect(validatePolicyEdit(edit).target.agentProfileCell?.cellId).toBe(cell.cellId)
  })

  it('rejects non-finite confidence values', () => {
    expect(() => validatePolicyEdit({ ...strongEdit(), confidence: Number.NaN })).toThrow(
      /finite number in \[0,1\]/,
    )
  })

  it('requires source attribution ids', () => {
    expect(() =>
      validatePolicyEdit({
        ...strongEdit(),
        source: { ...strongEdit().source, findingIds: [] },
      }),
    ).toThrow(/expected non-empty array/)
    expect(() =>
      validatePolicyEdit({
        ...strongEdit(),
        source: { ...strongEdit().source, analystIds: [] },
      }),
    ).toThrow(/expected non-empty array/)
  })

  it('honors admission option variants', () => {
    const highRisk = policyEditFromFinding(
      finding({
        metadata: { policyEdit: { expectedGain: EXPECTED_GAIN, risk: 'high' } },
      }),
    )
    if (!highRisk) throw new Error('expected high-risk edit')

    expect(admitPolicyEdit(highRisk).decision).toBe('reject')
    expect(admitPolicyEdit(highRisk, { allowHighRisk: true }).decision).toBe('admit')
    expect(admitPolicyEdit(strongEdit(), { minScore: 0.95 }).decision).toBe('reject')
  })

  it('applies text and JSON changes deterministically', () => {
    const textEdit = strongEdit()
    expect(applyPolicyEditToSurface('Base prompt.', textEdit)).toContain(
      'Always fetch current state before mutating a record.',
    )

    const replaceEdit = makePolicyEdit({
      axis: 'representation',
      target: { surface: 'prompt', path: 'system-prompt:tool-use' },
      change: {
        kind: 'text',
        mode: 'replace',
        find: '  Fetch then mutate.  ',
        value: 'Always fetch current state before mutating a record.',
      },
      claim: 'Agent mutates records before fetching current state.',
      expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.12 },
      confidence: 0.9,
      risk: 'low',
      source: {
        findingIds: ['f_replace'],
        analystIds: ['trace-analyst'],
        evidenceRefs: [{ kind: 'span', uri: 'span://trace-1/span-7' }],
      },
    })
    expect(replaceEdit.change).toMatchObject({ find: 'Fetch then mutate.' })
    expect(applyPolicyEditToSurface('Fetch then mutate.', replaceEdit)).toBe(
      'Always fetch current state before mutating a record.',
    )

    const jsonEdit = makePolicyEdit({
      axis: 'budget',
      target: { surface: 'runtime-config', path: 'budget.maxTurns' },
      change: { kind: 'json', mode: 'set', path: 'budget.maxTurns', value: 6 },
      claim: 'Agent exhausts the turn budget on long traces.',
      expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.04 },
      confidence: 0.85,
      risk: 'low',
      source: {
        findingIds: ['f_budget'],
        analystIds: ['trace-analyst'],
        evidenceRefs: [{ kind: 'metric', uri: 'metric://turn_budget_exhausted' }],
      },
    })
    expect(applyPolicyEditToSurface('{"budget":{"maxTurns":3}}', jsonEdit)).toEqual({
      budget: { maxTurns: 6 },
    })

    const removeEdit = makePolicyEdit({
      axis: 'budget',
      target: { surface: 'runtime-config', path: 'budget.maxTurns' },
      change: { kind: 'json', mode: 'remove', path: 'budget.maxTurns' },
      claim: 'Remove a stale budget override.',
      expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.04 },
      confidence: 0.85,
      risk: 'low',
      source: {
        findingIds: ['f_remove_budget'],
        analystIds: ['trace-analyst'],
        evidenceRefs: [{ kind: 'metric', uri: 'metric://stale_budget_override' }],
      },
    })
    expect(applyPolicyEditToSurface('{"budget":{"maxTurns":3},"keep":true}', removeEdit)).toEqual({
      budget: {},
      keep: true,
    })
    expect(applyPolicyEditToSurface('{"keep":true}', removeEdit)).toEqual({ keep: true })
  })

  it('applies prepend and JSON merge modes deterministically', () => {
    const prependEdit = textEdit({
      kind: 'text',
      mode: 'prepend',
      value: 'Always read state before choosing a write.',
    })
    expect(applyPolicyEditToSurface('Existing prompt.', prependEdit)).toBe(
      'Always read state before choosing a write.\n\nExisting prompt.',
    )

    const mergeEdit = jsonEdit({
      kind: 'json',
      mode: 'merge',
      path: 'budget',
      value: { maxTurns: 6, stopOnResolved: true },
    })
    expect(
      applyPolicyEditToSurface('{"budget":{"maxTurns":3,"trace":true},"keep":true}', mergeEdit),
    ).toEqual({
      budget: { maxTurns: 6, trace: true, stopOnResolved: true },
      keep: true,
    })
  })

  it('treats append and prepend idempotency as exact text blocks, not substrings', () => {
    const appendEdit = textEdit({ kind: 'text', mode: 'append', value: 'fetch' }, 'f_append')
    expect(applyPolicyEditToSurface('Always fetch current state.', appendEdit)).toBe(
      'Always fetch current state.\n\nfetch',
    )
    expect(applyPolicyEditToSurface('Always fetch current state.\n\nfetch', appendEdit)).toBe(
      'Always fetch current state.\n\nfetch',
    )
    expect(applyPolicyEditToSurface('Intro.\nfetch\nOutro.', appendEdit)).toBe(
      'Intro.\nfetch\nOutro.',
    )

    const prependEdit = textEdit({ kind: 'text', mode: 'prepend', value: 'fetch' }, 'f_prepend')
    expect(applyPolicyEditToSurface('Always fetch current state.', prependEdit)).toBe(
      'fetch\n\nAlways fetch current state.',
    )
  })

  it('fails loud on invalid surface/edit combinations', () => {
    expect(() => applyPolicyEditToSurface({ prompt: 'Base prompt.' }, strongEdit())).toThrow(
      /text policy edits require a string surface/,
    )

    const replaceEdit = textEdit(
      { kind: 'text', mode: 'replace', find: 'missing text', value: 'replacement' },
      'f_missing_replace',
    )
    expect(() => applyPolicyEditToSurface('Base prompt.', replaceEdit)).toThrow(
      /replace target not found/,
    )

    const setEdit = jsonEdit(
      { kind: 'json', mode: 'set', path: 'budget.maxTurns', value: 6 },
      'f_invalid_json',
    )
    expect(() => applyPolicyEditToSurface('{not json', setEdit)).toThrow(
      /json policy edits require a JSON string surface/,
    )
  })
})
