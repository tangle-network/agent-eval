import { describe, expect, it } from 'vitest'
import {
  type ScenarioSignal,
  scoreDiscrimination,
} from './scenario-selection'

describe('scoreDiscrimination', () => {
  it('ranks a high-variance scenario above a low-variance one', () => {
    const signals: ScenarioSignal[] = [
      { scenarioId: 'flat', scores: [0.5, 0.5, 0.5] },
      { scenarioId: 'spread', scores: [0.1, 0.9, 0.5] },
    ]
    const ranked = scoreDiscrimination(signals)
    expect(ranked.map((s) => s.scenarioId)).toEqual(['spread', 'flat'])
    expect(ranked[0]!.discrimination).toBeGreaterThan(ranked[1]!.discrimination)
  })

  it('flags a scenario every candidate scores 1.0 as tied', () => {
    const signals: ScenarioSignal[] = [
      { scenarioId: 'saturated', scores: [1.0, 1.0, 1.0] },
      { scenarioId: 'live', scores: [0.2, 0.8] },
    ]
    const byId = new Map(scoreDiscrimination(signals).map((s) => [s.scenarioId, s]))
    const saturated = byId.get('saturated')
    expect(saturated?.tied).toBe(true)
    expect(saturated?.variance ?? 1).toBeLessThan(1e-9)
    expect(byId.get('live')?.tied).toBe(false)
  })

  it('does not flag an all-equal-but-low scenario as tied (room to improve)', () => {
    // Every candidate scores 0.5 identically: zero variance, but NOT saturated —
    // there is headroom, so it is not a wasted tie.
    const signals: ScenarioSignal[] = [{ scenarioId: 'hard-flat', scores: [0.5, 0.5, 0.5] }]
    const [score] = scoreDiscrimination(signals)
    expect(score!.variance).toBeLessThan(1e-9)
    expect(score!.tied).toBe(false)
  })

  it('breaks discrimination ties by lower meanScore (more headroom first)', () => {
    // Same spread (variance) but different difficulty: the harder one ranks first.
    // Dyadic values (±0.125 deviations) so the variances are bit-identical and the
    // meanScore tiebreak — not float noise — decides the order.
    const signals: ScenarioSignal[] = [
      { scenarioId: 'easy', scores: [0.5, 0.75] },
      { scenarioId: 'hard', scores: [0.125, 0.375] },
    ]
    const ranked = scoreDiscrimination(signals)
    expect(ranked[0]!.variance).toBeCloseTo(ranked[1]!.variance, 12)
    expect(ranked.map((s) => s.scenarioId)).toEqual(['hard', 'easy'])
  })

  it('honors a custom saturationCeiling', () => {
    const signals: ScenarioSignal[] = [{ scenarioId: 's', scores: [0.9, 0.9] }]
    expect(scoreDiscrimination(signals, { saturationCeiling: 0.8 })[0]!.tied).toBe(true)
    expect(scoreDiscrimination(signals, { saturationCeiling: 0.95 })[0]!.tied).toBe(false)
  })
})


