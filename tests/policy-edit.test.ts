import { describe, expect, it } from 'vitest'
import { type AgentProfileCellInput, buildAgentProfileCell } from '../src/agent-profile-cell'
import {
  admitPolicyEdit,
  applyPolicyEditToSurface,
  makePolicyEdit,
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

  it('applies text and JSON changes deterministically', () => {
    const textEdit = strongEdit()
    expect(applyPolicyEditToSurface('Base prompt.', textEdit)).toContain(
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
  })
})
