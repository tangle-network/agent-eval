import { describe, expect, it } from 'vitest'
import {
  type ScenarioSignal,
  scoreDiscrimination,
  selectDiscriminative,
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

describe('selectDiscriminative', () => {
  const mixed: ScenarioSignal[] = [
    { scenarioId: 'tie-a', scores: [1.0, 1.0, 1.0] },
    { scenarioId: 'tie-b', scores: [1.0, 1.0] },
    { scenarioId: 'live-lo', scores: [0.2, 0.4] },
    { scenarioId: 'live-hi', scores: [0.0, 1.0] },
  ]

  it('excludes saturated ties when enough non-tied scenarios exist', () => {
    const picked = selectDiscriminative(mixed, 2)
    expect(picked).toEqual(['live-hi', 'live-lo'])
    expect(picked).not.toContain('tie-a')
    expect(picked).not.toContain('tie-b')
  })

  it('falls back to least-saturated ties when non-tied < k', () => {
    const signals: ScenarioSignal[] = [
      { scenarioId: 'live', scores: [0.1, 0.9] },
      { scenarioId: 'tie-high', scores: [1.0, 1.0] },
      { scenarioId: 'tie-low', scores: [0.999, 0.999] },
    ]
    // Only 1 non-tied; k=2 must fill with the least-saturated tie (tie-low < tie-high).
    const picked = selectDiscriminative(signals, 2)
    expect(picked[0]!).toBe('live')
    expect(picked[1]!).toBe('tie-low')
    expect(picked).not.toContain('tie-high')
  })

  it('is deterministic: same input twice ⇒ identical output', () => {
    const a = selectDiscriminative(mixed, 3)
    const b = selectDiscriminative(mixed, 3)
    expect(a).toEqual(b)
  })

  it('throws if k < 1', () => {
    expect(() => selectDiscriminative(mixed, 0)).toThrow()
    expect(() => selectDiscriminative(mixed, -1)).toThrow()
  })

  it('returns all ids in discrimination order when k >= n', () => {
    const all = selectDiscriminative(mixed, mixed.length)
    expect(all).toHaveLength(mixed.length)
    expect([...all].sort()).toEqual(['live-hi', 'live-lo', 'tie-a', 'tie-b'])
    // Order matches scoreDiscrimination ranking, including ties (not dropped here).
    expect(all).toEqual(scoreDiscrimination(mixed).map((s) => s.scenarioId))
  })

  it('returns all ids when k exceeds n', () => {
    const all = selectDiscriminative(mixed, mixed.length + 5)
    expect(all).toHaveLength(mixed.length)
  })
})
