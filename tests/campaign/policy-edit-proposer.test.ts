import { describe, expect, it } from 'vitest'
import { makePolicyEdit } from '../../src/analyst/policy-edit'
import { makeFinding } from '../../src/analyst/types'
import { policyEditProposer } from '../../src/campaign/proposers/policy-edit'
import type { ProposeContext } from '../../src/campaign/types'

function ctx(findings: unknown[], currentSurface = 'Base prompt.'): ProposeContext {
  return {
    currentSurface,
    history: [],
    findings,
    populationSize: 3,
    generation: 0,
    signal: new AbortController().signal,
  }
}

function edit() {
  return makePolicyEdit({
    axis: 'representation',
    target: { surface: 'prompt', path: 'system-prompt:tool-use' },
    change: {
      kind: 'text',
      mode: 'append',
      value: 'Always fetch current state before mutating a record.',
    },
    claim: 'Agent mutates records before fetching current state.',
    expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.12 },
    confidence: 0.9,
    risk: 'low',
    source: {
      findingIds: ['f_trace_mutation'],
      analystIds: ['trace-analyst'],
      evidenceRefs: [{ kind: 'span', uri: 'span://trace-1/span-7' }],
    },
  })
}

describe('policyEditProposer', () => {
  it('turns admitted typed edits into candidate surfaces', async () => {
    const proposer = policyEditProposer()
    const out = await proposer.propose(ctx([edit()]))

    expect(out).toHaveLength(1)
    expect(out[0]!.label).toBe('policy-edit:representation')
    expect(String(out[0]!.surface)).toContain(
      'Always fetch current state before mutating a record.',
    )
    expect(out[0]!.rationale).toContain('expected increase holdout.composite')
  })

  it('materializes legacy AnalystFinding rows only when they carry typed expected gain', async () => {
    const finding = makeFinding({
      analyst_id: 'trace-analyst',
      area: 'agent-reasoning',
      severity: 'high',
      subject: 'system-prompt:tool-use',
      claim: 'Agent mutates records before fetching current state.',
      evidence_refs: [{ kind: 'span', uri: 'span://trace-1/span-7' }],
      recommended_action: 'Always fetch current state before mutating a record.',
      confidence: 0.9,
      metadata: {
        policyEdit: {
          expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.12 },
          risk: 'low',
        },
      },
    })
    const proposer = policyEditProposer()
    const out = await proposer.propose(ctx([finding]))

    expect(out).toHaveLength(1)
    expect(String(out[0]!.surface)).toContain(
      'Always fetch current state before mutating a record.',
    )
  })

  it('skips weak edits instead of proposing unmeasurable candidates', async () => {
    const weak = makePolicyEdit({
      axis: 'representation',
      target: { surface: 'prompt' },
      change: { kind: 'text', mode: 'append', value: 'Try harder.' },
      claim: 'Maybe improve.',
      expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.001 },
      confidence: 0.2,
      risk: 'unknown',
      source: { findingIds: ['f_weak'], analystIds: ['trace-analyst'], evidenceRefs: [] },
    })
    const admissions: string[] = []
    const proposer = policyEditProposer({
      onAdmission: (a) => admissions.push(a.decision),
    })

    await expect(proposer.propose(ctx([weak]))).resolves.toEqual([])
    expect(admissions).toEqual(['reject'])
  })

  it('applies JSON policy edits to serialized runtime config surfaces', async () => {
    const budgetEdit = makePolicyEdit({
      axis: 'budget',
      target: { surface: 'runtime-config', path: 'budget.maxTurns' },
      change: { kind: 'json', mode: 'set', path: 'budget.maxTurns', value: 6 },
      claim: 'Agent exhausts its turn budget on long traces.',
      expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.04 },
      confidence: 0.85,
      risk: 'low',
      source: {
        findingIds: ['f_budget'],
        analystIds: ['trace-analyst'],
        evidenceRefs: [{ kind: 'metric', uri: 'metric://turn_budget_exhausted' }],
      },
    })
    const proposer = policyEditProposer()
    const out = await proposer.propose(ctx([budgetEdit], '{"budget":{"maxTurns":3}}'))

    expect(JSON.parse(String(out[0]!.surface))).toEqual({ budget: { maxTurns: 6 } })
  })

  it('fails loud when judge-derived findings try to steer proposals', async () => {
    const judgeFinding = makeFinding({
      analyst_id: 'judge',
      area: 'heldout-score',
      severity: 'high',
      claim: 'Candidate got a low held-out score.',
      evidence_refs: [{ kind: 'metric', uri: 'metric://holdout.composite' }],
      recommended_action: 'Add the exact judge preference to the prompt.',
      confidence: 0.95,
      derived_from_judge: true,
      metadata: {
        policyEdit: {
          expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.2 },
        },
      },
    })
    const proposer = policyEditProposer()

    await expect(proposer.propose(ctx([judgeFinding]))).rejects.toThrow(
      /judge verdict cannot be admitted/,
    )
  })
})
