import { describe, expect, it } from 'vitest'
import { calibrateBeliefDecisions } from './calibration'
import type { BeliefDecisionPoint } from './types'

describe('belief-state calibration', () => {
  it('computes confidence calibration from decision outcomes', () => {
    const points: BeliefDecisionPoint[] = Array.from({ length: 20 }, (_, index) => ({
      id: `d-${index}`,
      runId: `r-${index}`,
      stepIndex: index,
      kind: 'continue',
      chosenAction: 'continue',
      confidence: index < 10 ? 0.9 : 0.1,
      evidence: [{ source: 'event', id: `e-${index}` }],
      outcome: { score: index < 10 ? 1 : 0 },
    }))

    const report = calibrateBeliefDecisions(points, { minPairs: 10, bins: 2 })

    expect(report).not.toBeNull()
    expect(report!.n).toBe(20)
    expect(report!.bins).toHaveLength(2)
    expect(report!.ece).toBeLessThan(0.11)
  })

  it('returns null when confidence support is too small', () => {
    const report = calibrateBeliefDecisions([], { minPairs: 1 })
    expect(report).toBeNull()
  })
})
