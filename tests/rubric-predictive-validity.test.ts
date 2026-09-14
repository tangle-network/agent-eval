import { describe, expect, it } from 'vitest'
import { InMemoryOutcomeStore } from '../src/meta-eval/outcome-store'
import {
  type OutcomeMetricSpec,
  rubricPredictiveValidity,
} from '../src/meta-eval/rubric-predictive-validity'
import type { RunRecord } from '../src/run-record'

function rec(runId: string, rubrics: Record<string, number>, score = 0.5): RunRecord {
  return {
    runId,
    experimentId: 'exp',
    candidateId: 'c',
    seed: 0,
    model: 'm@1',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'abcd',
    wallMs: 1_000,
    costUsd: 0.01,
    tokenUsage: { input: 1, output: 1 },
    outcome: {
      holdoutScore: score,
      raw: rubrics,
    },
    splitTag: 'holdout',
  }
}

describe('rubricPredictiveValidity', () => {
  it('ranks aligned rubrics above weak ones by desired outcome direction', async () => {
    const runs: RunRecord[] = []
    const outcomes = new InMemoryOutcomeStore()
    // load-bearing rubric: monotonic with revenue. decorative rubric: random.
    for (let i = 0; i < 30; i++) {
      const id = `run-${i}`
      const loadBearing = i / 30
      const decorative = ((i * 13 + 7) % 11) / 11
      runs.push(rec(id, { load_bearing: loadBearing, decorative }))
      await outcomes.append({
        runId: id,
        capturedAt: Date.now(),
        metrics: { revenue: loadBearing * 100 + ((i * 7) % 5) / 5 },
      })
    }
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: [{ id: 'revenue', direction: 'higher-is-better' }],
      rubrics: ['load_bearing', 'decorative'],
      seed: 1,
    })
    expect(report.ranked[0]?.rubric).toBe('load_bearing')
    expect(report.ranked[0]?.verdict).toBe('aligned')
    expect(report.ranked[1]?.rubric).toBe('decorative')
    expect(report.ranked[1]?.verdict).toBe('weak')
  })

  it('discovers rubrics from outcome.raw when the caller does not declare them', async () => {
    const runs = [
      rec('a', { score_x: 0.1, score_y: 0.9 }),
      rec('b', { score_x: 0.2, score_y: 0.8 }),
      rec('c', { score_x: 0.3, score_y: 0.7 }),
      rec('d', { score_x: 0.4, score_y: 0.6 }),
      rec('e', { score_x: 0.5, score_y: 0.5 }),
      rec('f', { score_x: 0.6, score_y: 0.4 }),
      rec('g', { score_x: 0.7, score_y: 0.3 }),
      rec('h', { score_x: 0.8, score_y: 0.2 }),
    ]
    const outcomes = new InMemoryOutcomeStore()
    for (const r of runs) {
      await outcomes.append({
        runId: r.runId,
        capturedAt: Date.now(),
        metrics: { csat: r.outcome.raw.score_x! * 5 },
      })
    }
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: [{ id: 'csat', direction: 'higher-is-better' }],
      seed: 1,
    })
    const rubrics = report.ranked.map((r) => r.rubric).sort()
    expect(rubrics).toEqual(['score_x', 'score_y'])
    // score_x is monotone with csat → high |spearman|
    const sx = report.ranked.find((r) => r.rubric === 'score_x')!
    expect(Math.abs(sx.spearman)).toBeGreaterThan(0.9)
  })

  it('drops pairs below minSamples and reports rubrics-without-data', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs = [rec('a', { thin: 0.1 }), rec('b', { thin: 0.2 })]
    await outcomes.append({ runId: 'a', capturedAt: Date.now(), metrics: { x: 1 } })
    await outcomes.append({ runId: 'b', capturedAt: Date.now(), metrics: { x: 2 } })
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: [{ id: 'x', direction: 'higher-is-better' }],
      rubrics: ['thin', 'absent'],
      minSamples: 4,
      seed: 1,
    })
    expect(report.pairs).toEqual([]) // thin had only 2 samples; absent had none
    expect(report.rubricsWithoutData).toEqual(['absent'])
    expect(report.excludedPairs).toEqual([
      expect.objectContaining({ rubric: 'thin', n: 2, reason: 'insufficient_samples' }),
      expect.objectContaining({ rubric: 'absent', n: 0, reason: 'insufficient_samples' }),
    ])
  })

  it('skips runs with no joined outcome', async () => {
    const runs = [rec('a', { x: 0.1 }), rec('b', { x: 0.2 }), rec('c', { x: 0.3 })]
    const outcomes = new InMemoryOutcomeStore()
    await outcomes.append({ runId: 'a', capturedAt: Date.now(), metrics: { y: 1 } })
    // b and c have no outcome rows.
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: [{ id: 'y', direction: 'higher-is-better' }],
      rubrics: ['x'],
      minSamples: 3,
      seed: 1,
    })
    expect(report.joinedSamples).toBe(1)
    expect(report.skippedRuns).toBe(2)
  })

  it('marks negative association with a desired increase as inverse', async () => {
    const runs: RunRecord[] = []
    const outcomes = new InMemoryOutcomeStore()
    // anti-correlated rubric: rubric=i, revenue=-i.
    for (let i = 0; i < 20; i++) {
      runs.push(rec(`r-${i}`, { antiCorrelated: i }))
      await outcomes.append({ runId: `r-${i}`, capturedAt: Date.now(), metrics: { revenue: -i } })
    }
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: [{ id: 'revenue', direction: 'higher-is-better' }],
      rubrics: ['antiCorrelated'],
      seed: 1,
    })
    const r = report.ranked[0]!
    expect(r.spearman).toBeLessThan(-0.9)
    expect(r.verdict).toBe('inverse')
    expect(r.alignedSpearman).toBe(-1)
    expect(r.alignedSpearmanCi95?.upper).toBeLessThan(0)
  })

  it('aligns a lower-is-better outcome while preserving raw negative association', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs = Array.from({ length: 12 }, (_, i) => rec(`r-${i}`, { quality: i }))
    for (const [i, run] of runs.entries()) {
      await outcomes.append({
        runId: run.runId,
        capturedAt: 1,
        metrics: { failure_rate: 1 - i / 12 },
      })
    }
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: [{ id: 'failure_rate', direction: 'lower-is-better' }],
    })
    expect(report.pairs[0]).toMatchObject({
      spearman: -1,
      alignedSpearman: 1,
      outcomeDirection: 'lower-is-better',
      verdict: 'aligned',
    })
    expect(report.pairs[0]?.spearmanCi95?.upper).toBeLessThan(0)
    expect(report.pairs[0]?.alignedSpearmanCi95?.lower).toBeGreaterThan(0)
  })

  it('distinguishes missing scores, missing outcomes, measured zeros, and constant observations', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs = Array.from({ length: 8 }, (_, i) => rec(`r-${i}`, { varying: i, constant: 0 }))
    for (const [i, run] of runs.entries()) {
      await outcomes.append({ runId: run.runId, capturedAt: 1, metrics: { measured: i, fixed: 0 } })
    }
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      rubrics: ['varying', 'constant', 'missing'],
      outcomeMetrics: [
        { id: 'measured', direction: 'higher-is-better' },
        { id: 'fixed', direction: 'higher-is-better' },
        { id: 'absent', direction: 'higher-is-better' },
      ],
    })
    expect(report.joinedSamples).toBe(8)
    expect(report.skippedRuns).toBe(0)
    expect(report.rubricsWithoutData).toEqual(['missing'])
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]).toMatchObject({ rubric: 'varying', outcome: 'measured', n: 8 })
    expect(report.excludedPairs).toHaveLength(8)
    expect(report.excludedPairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rubric: 'varying',
          outcome: 'absent',
          reason: 'insufficient_samples',
          n: 0,
        }),
        expect.objectContaining({
          rubric: 'varying',
          outcome: 'fixed',
          reason: 'constant_outcome',
          n: 8,
        }),
        expect.objectContaining({
          rubric: 'constant',
          outcome: 'measured',
          reason: 'constant_rubric',
          n: 8,
        }),
      ]),
    )
  })

  it('excludes later non-finite and unrelated metrics without losing the last valid zero', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs = Array.from({ length: 8 }, (_, i) => rec(`r-${i}`, { quality: i }))
    for (const [i, run] of runs.entries()) {
      await outcomes.append({ runId: run.runId, capturedAt: 1, metrics: { error: -i, success: i } })
      await outcomes.append({ runId: run.runId, capturedAt: 2, metrics: { error: 100 } })
    }
    const rows = await outcomes.list()
    outcomes.list = async () => [
      ...rows,
      ...rows.map((row) => ({
        ...row,
        capturedAt: 3,
        metrics: { success: Number.NaN },
      })),
    ]
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: [{ id: 'success', direction: 'higher-is-better' }],
    })
    expect(report.pairs[0]).toMatchObject({ n: 8, spearman: 1, verdict: 'aligned' })
  })

  it('counts a run with only unrelated outcome keys as skipped', async () => {
    const outcomes = new InMemoryOutcomeStore()
    await outcomes.append({ runId: 'a', capturedAt: 1, metrics: { other: 1 } })
    const report = await rubricPredictiveValidity({
      runs: [rec('a', { quality: 0 })],
      outcomes,
      outcomeMetrics: [{ id: 'success', direction: 'higher-is-better' }],
    })
    expect(report.joinedSamples).toBe(0)
    expect(report.skippedRuns).toBe(1)
    expect(report.excludedPairs[0]?.n).toBe(0)
    expect(report.rubricsWithoutData).toEqual([])
  })

  it('rejects duplicated run ids instead of treating copied observations as independent runs', async () => {
    await expect(
      rubricPredictiveValidity({
        runs: [rec('a', { quality: 0 }), rec('a', { quality: 0 })],
        outcomes: new InMemoryOutcomeStore(),
        outcomeMetrics: [{ id: 'success', direction: 'higher-is-better' }],
      }),
    ).rejects.toThrow(/duplicate runId/)
  })

  it('propagates outcome-store failure rather than returning an empty successful study', async () => {
    const outcomes = new InMemoryOutcomeStore()
    outcomes.list = async () => {
      throw new Error('outcome store unavailable')
    }
    await expect(
      rubricPredictiveValidity({
        runs: [],
        outcomes,
        outcomeMetrics: [{ id: 'success', direction: 'higher-is-better' }],
      }),
    ).rejects.toThrow('outcome store unavailable')
  })

  it('keeps the declared metric direction and run observations fixed while reading outcomes', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs = Array.from({ length: 8 }, (_, i) => rec(`r-${i}`, { quality: i }))
    for (const [i, run] of runs.entries()) {
      await outcomes.append({ runId: run.runId, capturedAt: 1, metrics: { success: i } })
    }
    const outcomeMetrics: OutcomeMetricSpec[] = [{ id: 'success', direction: 'higher-is-better' }]
    const rubrics = ['quality']
    const rows = await outcomes.list()
    outcomes.list = async () => {
      outcomeMetrics[0]!.direction = 'lower-is-better'
      rubrics[0] = 'changed'
      for (const run of runs) run.outcome.raw.quality = 0
      runs.push(rec('new-run', { quality: 0 }))
      return rows
    }
    const report = await rubricPredictiveValidity({ runs, outcomes, outcomeMetrics, rubrics })
    expect(report.outcomeMetrics).toEqual([{ id: 'success', direction: 'higher-is-better' }])
    expect(report.pairs[0]).toMatchObject({ rubric: 'quality', verdict: 'aligned', n: 8 })
    expect(report.joinedSamples + report.skippedRuns).toBe(8)
  })
})
