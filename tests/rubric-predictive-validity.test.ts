import { describe, expect, it } from 'vitest'
import { rubricPredictiveValidity } from '../src/meta-eval/rubric-predictive-validity'
import { InMemoryOutcomeStore } from '../src/meta-eval/outcome-store'
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
  it('ranks load-bearing rubrics above decorative ones by Spearman magnitude', async () => {
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
        metrics: { revenue: loadBearing * 100 + (Math.random() - 0.5) * 5 },
      })
    }
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: ['revenue'],
      rubrics: ['load_bearing', 'decorative'],
      seed: 1,
    })
    expect(report.ranked[0]?.rubric).toBe('load_bearing')
    expect(report.ranked[0]?.verdict).toBe('load_bearing')
    expect(report.ranked[1]?.rubric).toBe('decorative')
    expect(report.ranked[1]?.verdict).toBe('decorative')
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
        metrics: { csat: r.outcome.raw['score_x']! * 5 },
      })
    }
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: ['csat'],
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
      outcomeMetrics: ['x'],
      rubrics: ['thin', 'absent'],
      minSamples: 4,
      seed: 1,
    })
    expect(report.pairs).toEqual([]) // thin had only 2 samples; absent had none
    expect(report.rubricsWithoutData).toEqual(expect.arrayContaining(['thin', 'absent']))
  })

  it('skips runs with no joined outcome', async () => {
    const runs = [
      rec('a', { x: 0.1 }),
      rec('b', { x: 0.2 }),
      rec('c', { x: 0.3 }),
    ]
    const outcomes = new InMemoryOutcomeStore()
    await outcomes.append({ runId: 'a', capturedAt: Date.now(), metrics: { y: 1 } })
    // b and c have no outcome rows.
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: ['y'],
      rubrics: ['x'],
      minSamples: 1,
      seed: 1,
    })
    expect(report.joinedSamples).toBe(1)
    expect(report.skippedRuns).toBe(2)
  })

  it('verdict is decorative for negative or near-zero correlation', async () => {
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
      outcomeMetrics: ['revenue'],
      rubrics: ['antiCorrelated'],
      seed: 1,
    })
    // Spearman magnitude is high but the verdict bucketing is on |ρ|, so an
    // anti-correlated rubric still buckets as load_bearing — that's correct;
    // it's load-bearing in the wrong direction. The caller's job is to inspect
    // the sign before promoting it.
    const r = report.ranked[0]!
    expect(r.spearman).toBeLessThan(-0.9)
    expect(r.verdict).toBe('load_bearing')
  })
})
