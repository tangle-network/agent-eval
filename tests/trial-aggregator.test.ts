import { describe, it, expect } from 'vitest'
import { aggregateTrialsByMode } from '../src/trial-aggregator'
import type { TrialResult } from '../src/prompt-evolution'

function trial(over: Partial<TrialResult>): TrialResult {
  return {
    variantId: 'v1',
    scenarioId: 's1',
    rep: 0,
    ok: true,
    score: 0.8,
    cost: 0,
    durationMs: 100,
    ...over,
  }
}

describe('aggregateTrialsByMode — replaces silent-zero composite corruption', () => {
  it('zero-fill mode: failed judges count as score=0 (legacy back-compat)', () => {
    const trials = [
      trial({ rep: 0, score: 0.8, judgeSucceeded: true }),
      trial({ rep: 1, score: 0.0, judgeSucceeded: false, judgeError: 'aborted' }),
      trial({ rep: 2, score: 0.7, judgeSucceeded: true }),
    ]
    const agg = aggregateTrialsByMode(trials, { mode: 'zero-fill' })
    // Mean over all 3 including the 0
    expect(agg.meanScore).toBeCloseTo((0.8 + 0.0 + 0.7) / 3, 5)
    expect(agg.countedTrials).toBe(3)
    expect(agg.excludedFailedTrials).toBe(1)
  })

  it('exclude-failed mode: drops failed-judge trials from the mean (the fix)', () => {
    const trials = [
      trial({ rep: 0, score: 0.8, judgeSucceeded: true }),
      trial({ rep: 1, score: 0.0, judgeSucceeded: false, judgeError: 'aborted' }),
      trial({ rep: 2, score: 0.7, judgeSucceeded: true }),
    ]
    const agg = aggregateTrialsByMode(trials, { mode: 'exclude-failed' })
    expect(agg.meanScore).toBeCloseTo((0.8 + 0.7) / 2, 5)
    expect(agg.countedTrials).toBe(2)
    expect(agg.excludedFailedTrials).toBe(1)
    expect(agg.totalTrials).toBe(3)
  })

  it('strict-fail mode: refuses the aggregate when any judge failed', () => {
    const trials = [
      trial({ rep: 0, score: 0.8, judgeSucceeded: true }),
      trial({ rep: 1, score: 0.0, judgeSucceeded: false, judgeError: 'aborted at stream' }),
      trial({ rep: 2, score: 0.7, judgeSucceeded: true }),
    ]
    const agg = aggregateTrialsByMode(trials, { mode: 'strict-fail' })
    expect(agg.strictFailure).toBeDefined()
    expect(agg.strictFailure!.failedCount).toBe(1)
    expect(agg.strictFailure!.firstError).toBe('aborted at stream')
    expect(agg.countedTrials).toBe(0)
  })

  it('strict-fail mode produces a valid aggregate when no judges failed', () => {
    const trials = [
      trial({ rep: 0, score: 0.8, judgeSucceeded: true }),
      trial({ rep: 1, score: 0.7, judgeSucceeded: true }),
    ]
    const agg = aggregateTrialsByMode(trials, { mode: 'strict-fail' })
    expect(agg.strictFailure).toBeUndefined()
    expect(agg.meanScore).toBeCloseTo(0.75, 5)
    expect(agg.countedTrials).toBe(2)
  })

  it('treats undefined judgeSucceeded as success (back-compat with legacy adapters)', () => {
    const trials = [
      trial({ rep: 0, score: 0.8 }), // no judgeSucceeded set
      trial({ rep: 1, score: 0.7 }), // no judgeSucceeded set
    ]
    const agg = aggregateTrialsByMode(trials, { mode: 'exclude-failed' })
    expect(agg.meanScore).toBeCloseTo(0.75, 5)
    expect(agg.countedTrials).toBe(2)
    expect(agg.excludedFailedTrials).toBe(0)
  })

  it('always excludes hard-errored trials (agent crash) regardless of mode', () => {
    const trials = [
      trial({ rep: 0, score: 0.8 }),
      trial({ rep: 1, score: 0, error: 'agent process crashed' }),
      trial({ rep: 2, score: 0.7 }),
    ]
    const zf = aggregateTrialsByMode(trials, { mode: 'zero-fill' })
    expect(zf.meanScore).toBeCloseTo(0.75, 5)
    expect(zf.countedTrials).toBe(2)
    expect(zf.totalTrials).toBe(3)
  })

  it('averages metrics over counted trials in exclude-failed mode', () => {
    const trials = [
      trial({ rep: 0, score: 0.8, judgeSucceeded: true, metrics: { judge: 0.8, struct: 0.9 } }),
      trial({ rep: 1, score: 0.0, judgeSucceeded: false, metrics: { judge: 0, struct: 0.9 } }),
      trial({ rep: 2, score: 0.7, judgeSucceeded: true, metrics: { judge: 0.7, struct: 0.85 } }),
    ]
    const agg = aggregateTrialsByMode(trials, { mode: 'exclude-failed' })
    expect(agg.metrics.judge).toBeCloseTo((0.8 + 0.7) / 2, 5)
    expect(agg.metrics.struct).toBeCloseTo((0.9 + 0.85) / 2, 5)
  })

  it('the bug we are fixing: zero-fill vs exclude-failed produce different conclusions', () => {
    // Today's tax/gtm: real signal at 0.78 on the 1 trial that worked, 0 on 2 aborted
    const trials = [
      trial({ rep: 0, score: 0.78, judgeSucceeded: true }),
      trial({ rep: 1, score: 0.0, judgeSucceeded: false, judgeError: 'aborted' }),
      trial({ rep: 2, score: 0.0, judgeSucceeded: false, judgeError: 'aborted' }),
    ]
    const zf = aggregateTrialsByMode(trials, { mode: 'zero-fill' })
    const ef = aggregateTrialsByMode(trials, { mode: 'exclude-failed' })
    expect(zf.meanScore).toBeCloseTo(0.26, 2)   // corrupted — looks like regression
    expect(ef.meanScore).toBeCloseTo(0.78, 2)   // honest — 1 trial of signal, but real
    expect(ef.excludedFailedTrials).toBe(2)     // explicit about what we did NOT count
  })
})
