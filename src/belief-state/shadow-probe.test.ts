import { describe, expect, it } from 'vitest'
import {
  type BeliefShadowProbeInput,
  formatBeliefShadowProbePrompt,
  runBeliefShadowProbe,
} from './shadow-probe'
import type { BeliefDecisionPoint } from './types'

describe('belief shadow probe', () => {
  it('runs an outcome-blind fork probe and joins the structured record back to the decision', async () => {
    const inputs: BeliefShadowProbeInput[] = []
    const result = await runBeliefShadowProbe({
      probeId: 'failure-recovery-shadow',
      points: [decisionPoint()],
      contextOf: () => 'patch failed with a type error; no verification has passed yet',
      probe: (input) => {
        inputs.push(input)
        return {
          predictedAction: 'verify',
          confidence: 0.72,
          beliefSummary: 'The edit may be wrong; verify before another patch.',
          uncertainty: ['whether the failing type is related'],
          evidenceRefs: ['event-1'],
          wouldChangeMindIf: ['typecheck passes'],
          targetProb: 0.8,
        }
      },
    })

    expect(inputs[0]!).toMatchObject({
      decisionId: 'd-1',
      candidateActions: ['retry', 'verify', 'continue', 'stop'],
    })
    expect(inputs[0]!.observedAction).toBeUndefined()
    expect(inputs[0]!.metadata).toBeUndefined()
    expect(inputs[0]!.evidence[0]).toEqual({ id: 'event-1', source: 'event' })
    expect(inputs[0]!).not.toHaveProperty('outcome')
    expect(result.diagnostics).toEqual([])
    expect(result.records[0]).toMatchObject({
      decisionId: 'd-1',
      observedAction: 'verify',
      predictedAction: 'verify',
      agreesWithObservedAction: true,
      confidence: 0.72,
      targetProb: 0.8,
      outcome: { success: true },
    })
    expect(result.summary).toMatchObject({
      attempted: 1,
      completed: 1,
      dropped: 0,
      withOutcome: 1,
      withTargetProb: 1,
      meanConfidence: 0.72,
      observedAgreementRate: 1,
    })
  })

  it('drops invalid probe responses without throwing by default', async () => {
    const result = await runBeliefShadowProbe({
      probeId: 'bad-shadow',
      points: [decisionPoint()],
      probe: () => ({
        predictedAction: 'hallucinated-action',
        confidence: 1.2,
      }),
    })

    expect(result.records).toEqual([])
    expect(result.summary).toMatchObject({ attempted: 1, completed: 0, dropped: 1 })
    expect(result.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual([
      'predictedAction hallucinated-action is not in candidateActions',
      'invalid confidence 1.2',
    ])
  })

  it('preserves deterministic output order under concurrent probes', async () => {
    const result = await runBeliefShadowProbe({
      probeId: 'concurrent-shadow',
      points: [
        decisionPoint({ id: 'd-2', stepIndex: 2, chosenAction: 'retry' }),
        decisionPoint({ id: 'd-1', stepIndex: 1, chosenAction: 'verify' }),
      ],
      concurrency: 2,
      probe: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, input.stepIndex === 1 ? 10 : 0))
        return { predictedAction: input.candidateActions[0] ?? 'retry', confidence: 0.5 }
      },
    })

    expect(result.records.map((record) => record.decisionId)).toEqual(['d-2', 'd-1'])
  })

  it('formats a no-chain-of-thought prompt without leaking the outcome', () => {
    const input: BeliefShadowProbeInput = {
      probeId: 'shadow',
      decisionId: 'd-1',
      runId: 'run-1',
      stepIndex: 0,
      decisionKind: 'retry',
      candidateActions: ['retry', 'verify'],
      evidence: [{ id: 'event-1', source: 'event' }],
      context: 'tool failed before outcome was known',
    }

    const prompt = formatBeliefShadowProbePrompt(input)

    expect(prompt).toContain('Return only JSON')
    expect(prompt).toContain('Do not include chain-of-thought')
    expect(prompt).toContain('"retry","verify"')
    expect(prompt).not.toContain('success')
  })
})

function decisionPoint(overrides: Partial<BeliefDecisionPoint> = {}): BeliefDecisionPoint {
  return {
    id: 'd-1',
    runId: 'run-1',
    stepIndex: 0,
    kind: 'retry',
    chosenAction: 'verify',
    candidateActions: ['retry', 'verify', 'continue', 'stop'],
    evidence: [{ source: 'event', id: 'event-1' }],
    outcome: { success: true, score: 1 },
    ...overrides,
  }
}
