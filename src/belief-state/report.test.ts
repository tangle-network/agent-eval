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
})
