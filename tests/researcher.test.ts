import { describe, expect, it } from 'vitest'
import {
  CallbackResearcher,
  type ExperimentPlan,
  NoopResearcher,
  type Researcher,
} from '../src/researcher'

describe('NoopResearcher', () => {
  it('throws on every method (fails loud, not silently)', async () => {
    const r = new NoopResearcher()
    await expect(r.inspectFailures([])).rejects.toThrow(/inspectFailures not implemented/)
    await expect(r.proposeChange([])).rejects.toThrow(/proposeChange not implemented/)
    await expect(r.applyChange([], {} as unknown as ExperimentPlan)).rejects.toThrow(
      /applyChange not implemented/,
    )
    await expect(r.evaluateChange({} as unknown as ExperimentPlan)).rejects.toThrow(
      /evaluateChange not implemented/,
    )
  })

  it('honours a custom hint message', async () => {
    const r = new NoopResearcher('use FooResearcher from @x/y')
    await expect(r.inspectFailures([])).rejects.toThrow(/FooResearcher/)
  })
})

describe('CallbackResearcher', () => {
  it('provides a concrete callback-backed researcher implementation', async () => {
    const baseline: ExperimentPlan = {
      baselineCandidateId: 'base',
      proposedCandidateId: 'candidate',
      changes: [],
      evaluationBudgetUsd: 1,
      splits: { search: ['s1'], holdout: ['h1'] },
    }
    const researcher = new CallbackResearcher({
      inspectFailures: async () => [
        {
          code: 'missing-proof',
          description: 'Missing executable proof',
          evidence: { runIds: ['r1'], samples: 1 },
        },
      ],
      proposeChange: async (failures) => [
        {
          kind: 'threshold',
          payload: { minProofCount: failures.length },
          rationale: 'Require executable proof.',
        },
      ],
      applyChange: async (changes, plan) => ({
        ...plan,
        changes,
        proposedCandidateId: 'candidate-v2',
      }),
      evaluateChange: async (plan) => ({
        plan,
        runs: [],
        gateDecision: {
          promote: false,
          candidateId: plan.proposedCandidateId,
          baselineId: plan.baselineCandidateId,
          evidence: {
            productiveRuns: 0,
            medianPairedDelta: 0,
            pairedCI: { low: 0, high: 0 },
            pairedPValue: 1,
            searchScore: Number.NaN,
            holdoutScore: Number.NaN,
            overfitGap: Number.NaN,
            baselineOverfitGap: Number.NaN,
          },
          reason: 'not enough runs',
          rejectionCode: 'few_runs',
        },
      }),
    })

    const failures = await researcher.inspectFailures([])
    const changes = await researcher.proposeChange(failures)
    const plan = await researcher.applyChange(changes, baseline)
    const result = await researcher.evaluateChange(plan)

    expect(failures[0].code).toBe('missing-proof')
    expect(changes[0].payload).toEqual({ minProofCount: 1 })
    expect(plan.proposedCandidateId).toBe('candidate-v2')
    expect(result.gateDecision.baselineId).toBe('base')
  })
})

describe('Researcher interface — structural conformance', () => {
  it('lets a downstream impl satisfy the four-method contract', () => {
    // Compilation = test. If any method signature shifts in the
    // public type, this stops compiling.
    class Impl implements Researcher {
      async inspectFailures() {
        return []
      }
      async proposeChange() {
        return []
      }
      async applyChange(_changes: unknown[], baseline: ExperimentPlan) {
        return baseline
      }
      async evaluateChange(plan: ExperimentPlan) {
        return {
          plan,
          runs: [],
          gateDecision: {
            promote: false,
            candidateId: 'x',
            baselineId: 'y',
            evidence: {
              productiveRuns: 0,
              medianPairedDelta: 0,
              pairedCI: { low: 0, high: 0 },
              pairedPValue: 1,
              searchScore: Number.NaN,
              holdoutScore: Number.NaN,
              overfitGap: Number.NaN,
              baselineOverfitGap: Number.NaN,
            },
            reason: 'stub',
            rejectionCode: 'few_runs' as const,
          },
        }
      }
    }
    const i: Researcher = new Impl()
    expect(typeof i.inspectFailures).toBe('function')
  })
})
