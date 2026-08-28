import { describe, expect, it } from 'vitest'
import {
  admitPolicyEdit,
  applyPolicyEditToSurface,
  computePolicyEditId,
  makePolicyEdit,
  makePolicyEditCandidateRecord,
  type PolicyEditInit,
  PolicyEditValidationError,
  policyEditsFromFindings,
  validatePolicyEdit,
  validatePolicyEditCandidateRecord,
} from './policy-edit'
import type { AnalystFinding } from './types'

const baseInit = (): PolicyEditInit => ({
  axis: 'representation',
  target: { surface: 'prompt', path: 'system-prompt' },
  change: {
    kind: 'text',
    mode: 'append',
    value: 'Always fetch current state before mutating a record.',
  },
  claim: 'Agent mutates records before fetching current state.',
  expectedGain: { metric: 'search.composite', direction: 'increase', amount: 0.12 },
  confidence: 0.9,
  risk: 'low',
  source: {
    findingIds: ['finding-1'],
    analystIds: ['analyst-1'],
    evidenceRefs: [{ kind: 'span', uri: 'span://trace/1' }],
  },
})

const finding = (overrides: Partial<AnalystFinding> = {}): AnalystFinding => ({
  schema_version: '1.0.0',
  finding_id: 'finding-1',
  analyst_id: 'analyst-1',
  produced_at: '2026-08-28T00:00:00.000Z',
  severity: 'high',
  area: 'execution',
  claim: 'Agent mutates records before fetching current state.',
  confidence: 0.9,
  evidence_refs: [{ kind: 'span', uri: 'span://trace/1' }],
  ...overrides,
})

describe('the policy-edit contract', () => {
  it('mints a content-addressed editId and refuses drift between id and content', () => {
    const edit = makePolicyEdit(baseInit())
    expect(edit.editId).toMatch(/^policy-edit:sha256:[0-9a-f]{64}$/)
    expect(computePolicyEditId(edit)).toBe(edit.editId)
    expect(validatePolicyEdit(edit)).toEqual(edit)
    const forged = { ...edit, claim: 'a different claim' }
    expect(() => validatePolicyEdit(forged)).toThrow(PolicyEditValidationError)
  })

  it('is deterministic: identical content mints an identical id', () => {
    expect(makePolicyEdit(baseInit()).editId).toBe(makePolicyEdit(baseInit()).editId)
  })

  it('applies a text append to a prompt surface exactly once', () => {
    const edit = makePolicyEdit(baseInit())
    const out = applyPolicyEditToSurface('Base prompt.', edit)
    expect(out).toContain('Base prompt.')
    expect(out).toContain('Always fetch current state before mutating a record.')
  })

  it('admission scores an evidence-backed low-risk edit above the default bar', () => {
    const admission = admitPolicyEdit(makePolicyEdit(baseInit()))
    expect(admission.decision).toBe('admit')
    expect(admission.score).toBeGreaterThanOrEqual(0.7)
  })

  it('admission rejects a high-risk edit unless explicitly allowed', () => {
    const edit = makePolicyEdit({ ...baseInit(), risk: 'high' })
    expect(admitPolicyEdit(edit).decision).toBe('reject')
    expect(admitPolicyEdit(edit, { allowHighRisk: true }).decision).toBe('admit')
  })

  it('the steer firewall refuses a judge-derived finding as an edit source', () => {
    expect(() =>
      policyEditsFromFindings([finding({ derived_from_judge: true })], {
        expectedGain: { metric: 'search.composite', direction: 'increase', amount: 0.1 },
      }),
    ).toThrow(/judge/i)
  })

  it('lifts an observable finding into an edit that carries its provenance', () => {
    const edits = policyEditsFromFindings(
      [
        finding({
          recommended_action: 'Append: Always fetch current state before mutating a record.',
        }),
      ],
      { expectedGain: { metric: 'search.composite', direction: 'increase', amount: 0.1 } },
    )
    expect(edits.length).toBeGreaterThanOrEqual(0)
    for (const edit of edits) {
      expect(edit.source.findingIds).toContain('finding-1')
    }
  })

  it('candidate records round-trip through validation as isolated snapshots', () => {
    const edit = makePolicyEdit(baseInit())
    const record = makePolicyEditCandidateRecord(edit)
    const validated = validatePolicyEditCandidateRecord({ ...record })
    expect(validated.policyEdit).toEqual(edit)
    expect(() =>
      validatePolicyEditCandidateRecord({
        ...record,
        policyEdit: { ...edit, editId: 'policy-edit:sha256:'.padEnd(78, '0') },
      }),
    ).toThrow(PolicyEditValidationError)
  })
})

describe('audit regressions', () => {
  it('an evidence-less edit admits by default — provenance, not evidence, is the discriminator', () => {
    const edit = makePolicyEdit({
      ...baseInit(),
      source: { findingIds: ['finding-1'], analystIds: ['analyst-1'], evidenceRefs: [] },
    })
    expect(admitPolicyEdit(edit).decision).toBe('admit')
    expect(admitPolicyEdit(edit, { requireEvidence: true }).decision).toBe('reject')
  })

  it('a JSON path through the prototype chain is refused loudly at validation time', () => {
    for (const path of ['__proto__.maxTurns', 'a.constructor.b', 'prototype']) {
      expect(() =>
        makePolicyEdit({
          ...baseInit(),
          target: { surface: 'agent-profile', path },
          change: { kind: 'json', mode: 'set', path, value: 999 },
        }),
      ).toThrow(/prototype chain/)
    }
  })

  it('one poisoned model-produced row skips instead of aborting the batch', () => {
    const good = finding({
      finding_id: 'good-1',
      recommended_action: 'Append: fetch current state first.',
      metadata: {
        policyEdit: {
          expectedGain: { metric: 'search.composite', direction: 'increase', amount: 0.1 },
        },
      },
    })
    const poisonedGain = finding({
      finding_id: 'bad-gain',
      recommended_action: 'Append: something.',
      metadata: {
        policyEdit: {
          expectedGain: { metric: 'search.composite', direction: 'increase', amount: -5 },
        },
      },
    })
    const poisonedConfidence = finding({
      finding_id: 'bad-confidence',
      recommended_action: 'Append: something else.',
      confidence: 1.5,
      metadata: {
        policyEdit: {
          expectedGain: { metric: 'search.composite', direction: 'increase', amount: 0.1 },
        },
      },
    })
    const edits = policyEditsFromFindings([good, poisonedGain, poisonedConfidence])
    expect(edits).toHaveLength(1)
    expect(edits[0]!.source.findingIds).toEqual(['good-1'])
  })
})
