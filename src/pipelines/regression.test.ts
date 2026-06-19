import { describe, expect, it } from 'vitest'
import type { LlmSpan, Run } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { regressionView } from './regression'

function run(runId: string, patch: Partial<Run> = {}): Run {
  return { runId, scenarioId: 's', startedAt: 1000, status: 'completed', ...patch }
}

function llm(runId: string, patch: Partial<LlmSpan>): LlmSpan {
  return {
    spanId: `${runId}-llm`,
    runId,
    kind: 'llm',
    name: 'llm.call',
    startedAt: 1000,
    model: 'm',
    messages: [],
    ...patch,
  }
}

function metricMean(report: Awaited<ReturnType<typeof regressionView>>, metric: string) {
  const m = report.metrics.find((x) => x.metric === metric)
  if (!m) throw new Error(`metric ${metric} not in report`)
  return { baselineMean: m.baselineMean, candidateMean: m.candidateMean }
}

describe('regressionView defaultExtract metric mapping', () => {
  it('extracts the correct scalar for each metric name (score/pass/durationMs)', async () => {
    const store = new InMemoryTraceStore()
    const tag = (v: string) => ({ tags: { slice: v } })
    await store.appendRun(
      run('b1', { ...tag('base'), outcome: { score: 0.4, pass: false }, endedAt: 1500 }),
    )
    await store.appendRun(
      run('b2', { ...tag('base'), outcome: { score: 0.6, pass: false }, endedAt: 1700 }),
    )
    await store.appendRun(
      run('c1', { ...tag('cand'), outcome: { score: 0.8, pass: true }, endedAt: 1900 }),
    )
    await store.appendRun(
      run('c2', { ...tag('cand'), outcome: { score: 1.0, pass: true }, endedAt: 2100 }),
    )

    const report = await regressionView(
      store,
      [
        { metric: 'score', higherIsBetter: true },
        { metric: 'pass', higherIsBetter: true },
        { metric: 'durationMs', higherIsBetter: false },
      ],
      {
        baseline: { tag: { key: 'slice', value: 'base' } },
        candidate: { tag: { key: 'slice', value: 'cand' } },
      },
    )

    expect(metricMean(report, 'score')).toEqual({ baselineMean: 0.5, candidateMean: 0.9 })
    // pass maps true->1, false->0
    expect(metricMean(report, 'pass')).toEqual({ baselineMean: 0, candidateMean: 1 })
    // durationMs = endedAt - startedAt (startedAt 1000)
    expect(metricMean(report, 'durationMs')).toEqual({ baselineMean: 600, candidateMean: 1000 })
  })

  it('maps costUsd and inputTokens from aggregated llm spans', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun(run('b1', { tags: { slice: 'base' } }))
    await store.appendRun(run('b2', { tags: { slice: 'base' } }))
    await store.appendRun(run('c1', { tags: { slice: 'cand' } }))
    await store.appendRun(run('c2', { tags: { slice: 'cand' } }))
    await store.appendSpan(llm('b1', { costUsd: 0.1, inputTokens: 100 }))
    await store.appendSpan(llm('b2', { costUsd: 0.3, inputTokens: 300 }))
    await store.appendSpan(llm('c1', { costUsd: 0.5, inputTokens: 500 }))
    await store.appendSpan(llm('c2', { costUsd: 0.7, inputTokens: 700 }))

    const report = await regressionView(
      store,
      [
        { metric: 'costUsd', higherIsBetter: false },
        { metric: 'inputTokens', higherIsBetter: false },
      ],
      {
        baseline: { tag: { key: 'slice', value: 'base' } },
        candidate: { tag: { key: 'slice', value: 'cand' } },
      },
    )
    expect(metricMean(report, 'costUsd')).toEqual({ baselineMean: 0.2, candidateMean: 0.6 })
    expect(metricMean(report, 'inputTokens')).toEqual({ baselineMean: 200, candidateMean: 600 })
  })

  it('maps failureClass to 1 for success runs and 0 otherwise', async () => {
    const store = new InMemoryTraceStore()
    // success: completed with pass != false
    await store.appendRun(run('b1', { tags: { slice: 'base' }, outcome: { pass: true } }))
    await store.appendRun(run('b2', { tags: { slice: 'base' }, outcome: { pass: true } }))
    // non-success: explicit failureClass
    await store.appendRun(
      run('c1', {
        tags: { slice: 'cand' },
        outcome: { pass: false, failureClass: 'reasoning_error' },
      }),
    )
    await store.appendRun(
      run('c2', {
        tags: { slice: 'cand' },
        outcome: { pass: false, failureClass: 'reasoning_error' },
      }),
    )
    const report = await regressionView(store, [{ metric: 'failureClass', higherIsBetter: true }], {
      baseline: { tag: { key: 'slice', value: 'base' } },
      candidate: { tag: { key: 'slice', value: 'cand' } },
    })
    expect(metricMean(report, 'failureClass')).toEqual({ baselineMean: 1, candidateMean: 0 })
  })

  it('drops null samples (unknown metric / missing scalar) instead of counting them as 0', async () => {
    const store = new InMemoryTraceStore()
    // Two runs WITH a score, plus runs that produce null for `score`
    // (no outcome.score). The null runs must be DROPPED, so the mean is
    // computed over only the present scores — NOT diluted toward 0.
    await store.appendRun(run('b1', { tags: { slice: 'base' }, outcome: { score: 0.8 } }))
    await store.appendRun(run('b2', { tags: { slice: 'base' }, outcome: { score: 0.8 } }))
    await store.appendRun(run('b3', { tags: { slice: 'base' } })) // null score -> dropped
    await store.appendRun(run('c1', { tags: { slice: 'cand' }, outcome: { score: 0.9 } }))
    await store.appendRun(run('c2', { tags: { slice: 'cand' }, outcome: { score: 0.9 } }))
    await store.appendRun(run('c3', { tags: { slice: 'cand' } })) // null score -> dropped

    const report = await regressionView(store, [{ metric: 'score', higherIsBetter: true }], {
      baseline: { tag: { key: 'slice', value: 'base' } },
      candidate: { tag: { key: 'slice', value: 'cand' } },
    })
    // If the null run were counted as 0, baselineMean would be (0.8+0.8+0)/3 = 0.533.
    // Correct (dropped) mean is 0.8.
    const { baselineMean, candidateMean } = metricMean(report, 'score')
    expect(baselineMean).toBeCloseTo(0.8, 10)
    expect(candidateMean).toBeCloseTo(0.9, 10)
  })

  it('throws for an unknown metric because all samples extract to null and get dropped', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun(run('b1', { tags: { slice: 'base' }, outcome: { score: 1 } }))
    await store.appendRun(run('c1', { tags: { slice: 'cand' }, outcome: { score: 1 } }))
    // 'banana' is not a known metric -> defaultExtract returns null for every
    // run -> extractAll yields [] -> compareToBaseline needs >=2 samples.
    await expect(
      regressionView(store, [{ metric: 'banana', higherIsBetter: true }], {
        baseline: { tag: { key: 'slice', value: 'base' } },
        candidate: { tag: { key: 'slice', value: 'cand' } },
      }),
    ).rejects.toThrow(/banana/)
  })
})
