import { describe, expect, it } from 'vitest'
import { evaluateBeliefSelectivePolicy, thresholdSelectivePolicy } from './selective'
import type { BeliefDecisionPoint } from './types'

describe('belief-state selective policy evaluation', () => {
  it('rewards rejecting low-confidence failures while preserving accepted successes', () => {
    const points: BeliefDecisionPoint[] = Array.from({ length: 40 }, (_, index) => {
      const success = index < 20
      return {
        id: `d-${index}`,
        runId: `r-${index}`,
        stepIndex: index,
        kind: 'continue',
        chosenAction: 'continue',
        confidence: success ? 0.9 : 0.2,
        evidence: [{ source: 'event', id: `e-${index}` }],
        outcome: { success },
      }
    })
    const report = evaluateBeliefSelectivePolicy(
      points,
      thresholdSelectivePolicy({ confidenceThreshold: 0.5 }),
      { minN: 10, minAccepted: 5, seed: 3 },
    )

    expect(report.recommendation).toBe('ship')
    expect(report.accepted).toBe(20)
    expect(report.rejected).toBe(20)
    expect(report.acceptedErrorRate).toBe(0)
    expect(report.utilityCi95.lower).toBeGreaterThan(0)
  })

  it('returns need_more_data when the corpus is too small', () => {
    const points: BeliefDecisionPoint[] = [
      {
        id: 'd-1',
        runId: 'r-1',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'continue',
        confidence: 1,
        evidence: [{ source: 'event', id: 'e-1' }],
        outcome: { success: true },
      },
    ]

    const report = evaluateBeliefSelectivePolicy(
      points,
      thresholdSelectivePolicy({ confidenceThreshold: 0.5 }),
    )

    expect(report.recommendation).toBe('need_more_data')
    expect(report.reasons[0]).toMatch(/need at least/)
  })
})
