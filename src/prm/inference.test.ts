import { describe, expect, it } from 'vitest'
import type { TraceStore } from '../trace/store'
import { prmBestOfN, prmEnsembleBestOfN } from './inference'
import type { PrmGradedTrace, PrmGrader } from './rubric'

const fakeStore = {} as TraceStore

function tracedTrace(runId: string, score: number): PrmGradedTrace {
  return { runId, steps: [], aggregateScore: score, gradedCount: 0, ungradedCount: 0 }
}

interface ConcurrencyMeter {
  peak: number
  active: number
}

/**
 * Grader stub that records peak concurrent `grade` calls against a shared
 * meter and assigns a score per runId. A shared meter lets multiple graders
 * report the true simultaneous in-flight count across the whole pool. Each
 * call yields a few times so concurrency is observable.
 */
function makeTrackingGrader(
  scores: Record<string, number>,
  meter: ConcurrencyMeter = { peak: 0, active: 0 },
): PrmGrader & { meter: ConcurrencyMeter } {
  const state = { meter } as PrmGrader & { meter: ConcurrencyMeter }
  state.grade = async (_store: TraceStore, runId: string): Promise<PrmGradedTrace> => {
    meter.active++
    if (meter.active > meter.peak) meter.peak = meter.active
    for (let i = 0; i < 5; i++) await Promise.resolve()
    meter.active--
    return tracedTrace(runId, scores[runId] ?? 0)
  }
  return state
}

/** Grader whose `grade` always rejects — models an unrecoverable LLM failure. */
function makeFailingGrader(message: string): PrmGrader {
  const state = {} as PrmGrader
  state.grade = async (): Promise<PrmGradedTrace> => {
    throw new Error(message)
  }
  return state
}

describe('prmBestOfN bounded concurrency', () => {
  it('caps concurrent grade calls at the configured concurrency', async () => {
    const grader = makeTrackingGrader({})
    const runIds = Array.from({ length: 10 }, (_, i) => `run-${i}`)

    const result = await prmBestOfN(fakeStore, grader, runIds, { concurrency: 2 })

    expect(result.ranked).toHaveLength(10)
    // OLD behavior (Promise.all over all runIds) peaks at 10.
    expect(grader.meter.peak).toBeLessThanOrEqual(2)
    expect(grader.meter.peak).toBeGreaterThan(0)
  })

  it('still picks the highest-scoring candidate as winner', async () => {
    const grader = makeTrackingGrader({ 'run-0': 0.1, 'run-1': 0.9, 'run-2': 0.5 })
    const result = await prmBestOfN(fakeStore, grader, ['run-0', 'run-1', 'run-2'], {
      concurrency: 2,
    })
    expect(result.winner.runId).toBe('run-1')
  })
})

describe('prmEnsembleBestOfN bounded concurrency + isolation', () => {
  it('caps concurrent grade calls across the flattened graderxrunId product', async () => {
    const scores = { 'run-0': 0.2, 'run-1': 0.8, 'run-2': 0.5 }
    const meter: ConcurrencyMeter = { peak: 0, active: 0 }
    const g1 = makeTrackingGrader(scores, meter)
    const g2 = makeTrackingGrader(scores, meter)
    const g3 = makeTrackingGrader(scores, meter)
    const runIds = ['run-0', 'run-1', 'run-2']

    const result = await prmEnsembleBestOfN(fakeStore, [g1, g2, g3], runIds, { concurrency: 2 })

    expect(result.ranked).toHaveLength(3)
    // OLD nested Promise.all fired 3 graders x 3 runIds = 9 calls at once.
    // The shared meter measures the true simultaneous in-flight count across
    // the whole flattened pool; it must never exceed the configured bound.
    expect(meter.peak).toBeLessThanOrEqual(2)
    expect(meter.peak).toBeGreaterThan(0)
  })

  it('one grader failing on a candidate does not void the ensemble (allSettled)', async () => {
    const scores = { 'run-0': 0.2, 'run-1': 0.9, 'run-2': 0.4 }
    const good = makeTrackingGrader(scores)
    // Second grader rejects on every candidate; the ensemble must survive.
    const flaky = makeFailingGrader('rate limited')
    const runIds = ['run-0', 'run-1', 'run-2']

    const result = await prmEnsembleBestOfN(fakeStore, [good, flaky], runIds, { concurrency: 4 })

    // OLD behavior: nested Promise.all rejects the whole call on the first
    // grader failure. New behavior: the surviving grader still produces a vote.
    expect(result.ranked).toHaveLength(3)
    expect(result.winner.runId).toBe('run-1')
  })

  it('throws only when every grader fails on every candidate', async () => {
    const runIds = ['run-0', 'run-1']
    await expect(
      prmEnsembleBestOfN(
        fakeStore,
        [makeFailingGrader('boom-a'), makeFailingGrader('boom-b')],
        runIds,
      ),
    ).rejects.toThrow(/every grader failed/)
  })
})
