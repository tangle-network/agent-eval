import { describe, expect, it } from 'vitest'
import {
  observationsFromRunRecords,
  thompsonCurriculum,
  varianceBasedCurriculum,
} from '../src/rl/active-curriculum'
import type { CellObservation } from '../src/rl/active-curriculum'
import type { RunRecord } from '../src/run-record'

describe('varianceBasedCurriculum', () => {
  it('allocates more budget to higher-variance cells (Neyman-style)', () => {
    const obs: CellObservation[] = [
      // High-variance cell: scores all over the place
      { variantId: 'a', scenarioId: 's1', score: 0.1 },
      { variantId: 'a', scenarioId: 's1', score: 0.9 },
      { variantId: 'a', scenarioId: 's1', score: 0.2 },
      { variantId: 'a', scenarioId: 's1', score: 0.8 },
      // Low-variance cell: stable around 0.5
      { variantId: 'a', scenarioId: 's2', score: 0.49 },
      { variantId: 'a', scenarioId: 's2', score: 0.50 },
      { variantId: 'a', scenarioId: 's2', score: 0.51 },
      { variantId: 'a', scenarioId: 's2', score: 0.50 },
    ]
    const allocation = varianceBasedCurriculum(
      obs,
      [{ variantId: 'a', scenarioId: 's1' }, { variantId: 'a', scenarioId: 's2' }],
      { budget: 100, floorPerCell: 1 },
    )
    const high = allocation.find((a) => a.scenarioId === 's1')!
    const low = allocation.find((a) => a.scenarioId === 's2')!
    expect(high.count).toBeGreaterThan(low.count)
    expect(high.reason).toContain('variance')
  })

  it('respects the floor when budget is tight relative to cell count', () => {
    const cells = Array.from({ length: 20 }, (_, i) => ({ variantId: 'a', scenarioId: `s-${i}` }))
    const allocation = varianceBasedCurriculum([], cells, { budget: 10, floorPerCell: 1 })
    expect(allocation.every((a) => a.count >= 1)).toBe(true)
  })

  it('upweights under-sampled cells via the 1/sqrt(n) tie-break term', () => {
    const obs: CellObservation[] = [
      { variantId: 'a', scenarioId: 'old', score: 0.5 },
      { variantId: 'a', scenarioId: 'old', score: 0.5 },
      { variantId: 'a', scenarioId: 'old', score: 0.5 },
      { variantId: 'a', scenarioId: 'old', score: 0.5 },
      { variantId: 'a', scenarioId: 'old', score: 0.5 },
    ]
    const allocation = varianceBasedCurriculum(
      obs,
      [{ variantId: 'a', scenarioId: 'old' }, { variantId: 'a', scenarioId: 'new' }],
      { budget: 50, floorPerCell: 1 },
    )
    const newCell = allocation.find((a) => a.scenarioId === 'new')!
    const oldCell = allocation.find((a) => a.scenarioId === 'old')!
    // The under-sampled "new" cell should get at least as much as the
    // well-sampled "old" cell because the weight gets the 1/sqrt(n) boost.
    expect(newCell.count).toBeGreaterThanOrEqual(oldCell.count)
  })
})

describe('thompsonCurriculum', () => {
  it('concentrates budget on cells whose posterior straddles the decision threshold', () => {
    const obs: CellObservation[] = [
      // Borderline cell — half pass, half fail near threshold
      ...Array.from({ length: 4 }, () => ({ variantId: 'a', scenarioId: 'borderline', score: 0.55, pass: true })),
      ...Array.from({ length: 4 }, () => ({ variantId: 'a', scenarioId: 'borderline', score: 0.45, pass: false })),
      // Clearly-passing cell
      ...Array.from({ length: 8 }, () => ({ variantId: 'a', scenarioId: 'easy', score: 0.95, pass: true })),
      // Clearly-failing cell
      ...Array.from({ length: 8 }, () => ({ variantId: 'a', scenarioId: 'hard', score: 0.10, pass: false })),
    ]
    const allocation = thompsonCurriculum(
      obs,
      [
        { variantId: 'a', scenarioId: 'borderline' },
        { variantId: 'a', scenarioId: 'easy' },
        { variantId: 'a', scenarioId: 'hard' },
      ],
      { budget: 90, decisionThreshold: 0.5, seed: 42 },
    )
    const borderline = allocation.find((a) => a.scenarioId === 'borderline')!
    const easy = allocation.find((a) => a.scenarioId === 'easy')!
    const hard = allocation.find((a) => a.scenarioId === 'hard')!
    expect(borderline.count).toBeGreaterThan(easy.count)
    expect(borderline.count).toBeGreaterThan(hard.count)
  })

  it('produces deterministic allocations under a fixed seed', () => {
    const obs: CellObservation[] = [
      { variantId: 'a', scenarioId: 's', score: 0.5, pass: true },
      { variantId: 'a', scenarioId: 's', score: 0.5, pass: false },
    ]
    const cells = [{ variantId: 'a', scenarioId: 's' }]
    const a = thompsonCurriculum(obs, cells, { budget: 10, seed: 7 })
    const b = thompsonCurriculum(obs, cells, { budget: 10, seed: 7 })
    expect(a).toEqual(b)
  })
})

describe('observationsFromRunRecords', () => {
  function rec(scenarioId: string, score: number): RunRecord {
    return {
      runId: `r-${scenarioId}-${score}`,
      experimentId: 'e', candidateId: 'a', seed: 0,
      model: 'm@1', promptHash: 'p'.repeat(64), configHash: 'c'.repeat(64),
      commitSha: 'abcd', wallMs: 1, costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
      outcome: { holdoutScore: score, raw: {} },
      splitTag: 'holdout',
      scenarioId,
    }
  }

  it('extracts (variant, scenario, score) tuples and tags pass/fail', () => {
    const obs = observationsFromRunRecords([
      rec('s1', 0.7),
      rec('s2', 0.3),
    ])
    expect(obs).toHaveLength(2)
    expect(obs.find((o) => o.scenarioId === 's1')?.pass).toBe(true)
    expect(obs.find((o) => o.scenarioId === 's2')?.pass).toBe(false)
  })

  it('skips records without scenarioId', () => {
    const recs = [rec('s1', 0.5), { ...rec('s1', 0.5), scenarioId: undefined }]
    const obs = observationsFromRunRecords(recs)
    expect(obs).toHaveLength(1)
  })
})
