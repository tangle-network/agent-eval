import { describe, expect, it } from 'vitest'
import { analyzeBeliefPolicy } from './report'
import { thresholdSelectivePolicy } from './selective'
import type { BeliefDecisionPoint } from './types'

describe('belief-state policy report', () => {
  it('does not ship when calibration is unsupported', () => {
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

    const report = analyzeBeliefPolicy({
      points,
      policy: thresholdSelectivePolicy({ confidenceThreshold: 0.5 }),
      selective: { minN: 1, minAccepted: 1 },
      calibration: { minPairs: 10 },
    })

    expect(report.status).toBe('need_more_data')
    expect(report.diagnostics).toContain(
      'calibration unsupported: not enough confidence/outcome pairs',
    )
  })

  it('does not ship when OPE is required but no target policy is supplied', () => {
    const points = policyEvaluationFixture()

    const report = analyzeBeliefPolicy({
      points,
      policy: thresholdSelectivePolicy({ confidenceThreshold: 0.5 }),
      selective: { minN: 10, minAccepted: 5 },
      calibration: { minPairs: 10 },
      requireOpe: true,
    })

    expect(report.selectiveStatus).toBe('ship')
    expect(report.calibrationStatus).toBe('supported')
    expect(report.opeStatus).toBe('unsupported')
    expect(report.status).toBe('hold')
    expect(report.diagnostics).toContain('OPE unsupported: missing target policy')
  })

  it('reports supported OPE under a distinct target policy id', () => {
    const points = policyEvaluationFixture()

    const report = analyzeBeliefPolicy({
      points,
      policy: thresholdSelectivePolicy({ confidenceThreshold: 0.5 }),
      selective: { minN: 10, minAccepted: 5 },
      calibration: { minPairs: 10 },
      ope: {
        targetPolicy: {
          id: 'confidence-target-policy',
          targetProbOf(point) {
            return point.confidence && point.confidence >= 0.5 ? 0.5 : 0
          },
          qHatOf(point) {
            return point.confidence
          },
        },
        minEffectiveSampleSize: 10,
      },
      requireOpe: true,
    })

    expect(report.status).toBe('ship')
    expect(report.opeStatus).toBe('supported')
    expect(report.opeTargetPolicyId).toBe('confidence-target-policy')
    expect(report.ope?.targetPolicyId).toBe('confidence-target-policy')
  })
})

function policyEvaluationFixture(): BeliefDecisionPoint[] {
  return Array.from({ length: 40 }, (_, index) => {
    const success = index < 20
    return {
      id: `d-${index}`,
      runId: `r-${index}`,
      stepIndex: index,
      kind: 'continue',
      chosenAction: 'continue',
      confidence: success ? 0.9 : 0.1,
      behaviorProb: 0.5,
      targetProb: success ? 0.5 : 0,
      evidence: [{ source: 'event', id: `e-${index}` }],
      outcome: { success },
    }
  })
}
