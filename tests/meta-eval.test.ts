import { describe, expect, it } from 'vitest'
import {
  calibrationCurve,
  correlationStudy,
  type DeploymentOutcome,
  InMemoryOutcomeStore,
} from '../src/meta-eval'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

async function seedRun(
  store: InMemoryTraceStore,
  score: number,
  outcomeStore: InMemoryOutcomeStore,
  retention: number,
): Promise<string> {
  const e = new TraceEmitter(store)
  await e.startRun({ scenarioId: 's' })
  await e.endRun({ pass: true, score })
  await outcomeStore.append({
    runId: e.runId,
    capturedAt: Date.now() + 1000,
    metrics: { retention_7d: retention },
  })
  return e.runId
}

describe('InMemoryOutcomeStore', () => {
  it('appends + retrieves by runId', async () => {
    const s = new InMemoryOutcomeStore()
    const o: DeploymentOutcome = { runId: 'r1', capturedAt: 1, metrics: { csat: 4.2 } }
    await s.append(o)
    expect((await s.forRun('r1'))[0].metrics.csat).toBe(4.2)
  })

  it('list filters by label + source', async () => {
    const s = new InMemoryOutcomeStore()
    await s.append({
      runId: 'a',
      capturedAt: 1,
      metrics: { r: 1 },
      labels: { cohort: 'beta' },
      source: 'prod',
    })
    await s.append({
      runId: 'b',
      capturedAt: 2,
      metrics: { r: 0 },
      labels: { cohort: 'alpha' },
      source: 'prod',
    })
    await s.append({ runId: 'c', capturedAt: 3, metrics: { r: 1 }, source: 'eval' })
    expect(await s.list({ label: { key: 'cohort', value: 'beta' } })).toHaveLength(1)
    expect(await s.list({ source: 'eval' })).toHaveLength(1)
  })
})

describe('correlationStudy', () => {
  it.each([
    {
      evalMetrics: [{ id: 'score' }, { id: 'score' }],
      outcomeMetrics: ['y'],
      duplicate: 'eval metric',
    },
    { evalMetrics: [{ id: 'score' }], outcomeMetrics: ['y', 'y'], duplicate: 'outcome metric' },
  ])(
    'refuses duplicate $duplicate declarations before they can multiply observations',
    async ({ evalMetrics, outcomeMetrics, duplicate }) => {
      await expect(
        correlationStudy(
          new InMemoryTraceStore(),
          new InMemoryOutcomeStore(),
          evalMetrics,
          outcomeMetrics,
        ),
      ).rejects.toThrow(`duplicate ${duplicate}`)
    },
  )

  it('refuses repeated run identities from a custom trace store', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    await seedRun(trace, 1, out, 1)
    const runs = await trace.listRuns()
    trace.listRuns = async () => [...runs, ...runs]
    await expect(correlationStudy(trace, out, [{ id: 'score' }], ['retention_7d'])).rejects.toThrow(
      /duplicate runId/,
    )
  })

  it('returns strong positive association between score and outcome', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    // Strongly correlated: high score → high retention
    for (let i = 0; i < 15; i++) {
      const score = 0.2 + i * 0.05
      const retention = 0.3 + i * 0.04 + (i % 3) * 0.01
      await seedRun(trace, score, out, retention)
    }
    const report = await correlationStudy(trace, out, [{ id: 'score' }], ['retention_7d'])
    expect(report.joinedSamples).toBe(15)
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0].pearson).toBeGreaterThan(0.85)
    expect(report.pairs[0].verdict).toBe('strong')
    expect(report.pairs[0].pearsonCi95?.lower).toBeGreaterThan(0)
  })

  it('returns weak verdict when uncorrelated', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    const noise = [0.4, 0.1, 0.9, 0.5, 0.2, 0.8, 0.3, 0.7, 0.6, 0.5]
    for (let i = 0; i < 10; i++) {
      await seedRun(trace, i * 0.1, out, noise[i])
    }
    const report = await correlationStudy(trace, out, [{ id: 'score' }], ['retention_7d'])
    expect(report.pairs[0].verdict).toBe('weak')
  })

  it('skips runs without outcomes', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    for (let i = 0; i < 5; i++) await seedRun(trace, i * 0.1, out, i * 0.1)
    // Run with no outcome
    const e = new TraceEmitter(trace)
    await e.startRun({ scenarioId: 'orphan' })
    await e.endRun({ pass: true, score: 0.5 })

    const report = await correlationStudy(trace, out, [{ id: 'score' }], ['retention_7d'])
    expect(report.skippedRuns).toBe(1)
    expect(report.joinedSamples).toBe(5)
  })

  it.each(['latest', 'mean', 'max'] as const)(
    'reduces only the requested outcome metric with %s',
    async (reduction) => {
      const trace = new InMemoryTraceStore()
      const out = new InMemoryOutcomeStore()
      for (let i = 0; i < 10; i++) {
        const runId = await seedRun(trace, i, out, 10 - i)
        await out.append({
          runId,
          capturedAt: Date.now() + 2_000,
          metrics: { retention_7d: 10 - i, csat: i },
        })
        await out.append({ runId, capturedAt: Date.now() + 3_000, metrics: { retention_7d: i } })
      }
      const rows = await out.list()
      out.list = async () => [
        ...rows,
        ...rows.map((row) => ({
          ...row,
          capturedAt: Date.now() + 4_000,
          metrics: { csat: Number.NaN },
        })),
      ]
      const report = await correlationStudy(trace, out, [{ id: 'score' }], ['csat'], { reduction })
      expect(report.pairs).toHaveLength(1)
      expect(report.pairs[0]).toMatchObject({ n: 10, pearson: 1, spearman: 1 })
      expect(report.joinedSamples).toBe(10)
    },
  )

  it('selects the last finite observation of each metric independently of insertion order', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    for (let i = 0; i < 10; i++) {
      const runId = await seedRun(trace, i, out, i)
      await out.append({ runId, capturedAt: Date.now() + 3_000, metrics: { other: -i, csat: i } })
      await out.append({ runId, capturedAt: Date.now() + 2_000, metrics: { csat: -i } })
    }
    const report = await correlationStudy(trace, out, [{ id: 'score' }], ['csat'])
    expect(report.pairs[0]?.pearson).toBe(1)
  })

  it('accounts for unusable joins and excludes outcomes captured before the run', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    await seedRun(trace, 0, out, 0)
    const missing = await seedRun(trace, 1, new InMemoryOutcomeStore(), 1)
    await out.append({ runId: missing, capturedAt: Date.now() + 1_000, metrics: { unrelated: 5 } })
    const before = await seedRun(trace, 2, new InMemoryOutcomeStore(), 2)
    await out.append({ runId: before, capturedAt: 1, metrics: { retention_7d: 2 } })
    const report = await correlationStudy(trace, out, [{ id: 'score' }], ['retention_7d'])
    expect(report.joinedSamples).toBe(1)
    expect(report.skippedRuns).toBe(2)
    expect(report.excludedPairs).toEqual([
      { evalMetric: 'score', outcomeMetric: 'retention_7d', n: 1, reason: 'insufficient_samples' },
    ])
  })

  it('reports constant observations as unestimable rather than perfect correlation', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    for (let i = 0; i < 8; i++) await seedRun(trace, 0, out, 0)
    const report = await correlationStudy(trace, out, [{ id: 'score' }], ['retention_7d'])
    expect(report.joinedSamples).toBe(8)
    expect(report.pairs).toEqual([])
    expect(report.excludedPairs[0]).toMatchObject({ n: 8, reason: 'constant_eval_metric' })
  })
})

describe('calibrationCurve', () => {
  it('uses the latest finite requested metric despite later unrelated or invalid observations', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    for (let i = 0; i < 10; i++) {
      const runId = await seedRun(trace, i / 10, out, i / 10)
      await out.append({ runId, capturedAt: Date.now() + 2_000, metrics: { other: 1 } })
    }
    const rows = await out.list()
    out.list = async () => [
      ...rows,
      ...rows.map((row) => ({
        ...row,
        capturedAt: Date.now() + 3_000,
        metrics: { retention_7d: Number.NaN },
      })),
    ]

    const report = await calibrationCurve(trace, out, { id: 'score' }, 'retention_7d', { bins: 5 })
    expect(report).toMatchObject({ n: 10, ece: 0 })
    expect(report!.bins.reduce((sum, bin) => sum + bin.n, 0)).toBe(10)
    expect(report!.bins[0]?.outcomeMean).toBe(0.05)
  })

  it('produces bins with ECE near 0 when eval = outcome identically', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    for (let i = 0; i < 20; i++) {
      const x = i / 20
      await seedRun(trace, x, out, x)
    }
    const report = await calibrationCurve(trace, out, { id: 'score' }, 'retention_7d', { bins: 5 })
    expect(report).not.toBeNull()
    expect(report!.ece).toBeLessThan(0.1)
  })

  it('high ECE when eval systematically overconfident', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    for (let i = 0; i < 20; i++) {
      const x = i / 20
      // eval says 0.9 but reality is 0.3 for high-eval cases
      await seedRun(trace, x, out, x * 0.3)
    }
    const report = await calibrationCurve(trace, out, { id: 'score' }, 'retention_7d', { bins: 5 })
    expect(report!.ece).toBeGreaterThan(0.2)
  })

  it('returns null when fewer than 2 paired samples', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    const report = await calibrationCurve(trace, out, { id: 'score' }, 'retention_7d')
    expect(report).toBeNull()
  })

  it('clips out-of-range scores while retaining every joined observation in the calibration error', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    await seedRun(trace, -1, out, 1)
    await seedRun(trace, 2, out, 0)
    const report = await calibrationCurve(trace, out, { id: 'score' }, 'retention_7d', {
      bins: 5,
      range: { lo: 0, hi: 1 },
    })
    expect(report).toMatchObject({ n: 2, ece: 1, maxGap: 1 })
    expect(report!.bins.reduce((sum, bin) => sum + bin.n, 0)).toBe(report!.n)
    expect(report!.bins.map((bin) => bin.evalMean)).toEqual([0, 1])
  })

  it.each([{}, { binning: 'equal-frequency', range: { lo: 0, hi: 1 } }] as const)(
    'measures a constant confident predictor with options %j',
    async (options) => {
      const trace = new InMemoryTraceStore()
      const out = new InMemoryOutcomeStore()
      await seedRun(trace, 1, out, 0)
      await seedRun(trace, 1, out, 0)
      const report = await calibrationCurve(trace, out, { id: 'score' }, 'retention_7d', options)
      expect(report).toMatchObject({ n: 2, ece: 1, maxGap: 1 })
      expect(report!.bins).toEqual([
        { lower: 1, upper: 1, n: 2, evalMean: 1, outcomeMean: 0, gap: 1 },
      ])
    },
  )

  it('makes the requested equal-frequency bins with balanced counts', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    for (let i = 0; i < 23; i++) await seedRun(trace, i / 23, out, i / 23)
    const report = await calibrationCurve(trace, out, { id: 'score' }, 'retention_7d', {
      bins: 10,
      binning: 'equal-frequency',
    })
    expect(report).toMatchObject({ n: 23, ece: 0 })
    expect(report!.bins).toHaveLength(10)
    expect(report!.bins.reduce((sum, bin) => sum + bin.n, 0)).toBe(23)
    expect(report!.bins.every((bin) => bin.n === 2 || bin.n === 3)).toBe(true)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid bin count %s before treating evidence as empty',
    async (bins) => {
      await expect(
        calibrationCurve(
          new InMemoryTraceStore(),
          new InMemoryOutcomeStore(),
          { id: 'score' },
          'y',
          {
            bins,
          },
        ),
      ).rejects.toThrow(/bins must be a positive safe integer/)
    },
  )

  it.each([
    { lo: 1, hi: 0 },
    { lo: Number.NaN, hi: 1 },
    { lo: 0, hi: Number.POSITIVE_INFINITY },
  ])('refuses invalid range %j before treating evidence as empty', async (range) => {
    await expect(
      calibrationCurve(new InMemoryTraceStore(), new InMemoryOutcomeStore(), { id: 'score' }, 'y', {
        range,
      }),
    ).rejects.toThrow(/range must have finite ordered bounds/)
  })
})

/**
 * A run whose LLM spans carry a known cost and output-token count, so a
 * metric other than `score` reads a value the score cannot be mistaken for.
 */
async function seedCostedRun(
  store: InMemoryTraceStore,
  score: number,
  outcomeStore: InMemoryOutcomeStore,
  retention: number,
  usage: { costUsd: number; outputTokens: number },
): Promise<void> {
  const e = new TraceEmitter(store)
  await e.startRun({ scenarioId: 's' })
  const call = await e.span({
    kind: 'llm',
    name: 'call',
    model: 'm',
    messages: [],
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
  })
  await call.end()
  await e.endRun({ pass: true, score })
  await outcomeStore.append({
    runId: e.runId,
    capturedAt: Date.now() + 1000,
    metrics: { retention_7d: retention },
  })
}

describe('built-in run metrics across the meta-eval entry points', () => {
  it('calibrates the metric the caller named, not the run score', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    // score and costUsd move in OPPOSITE directions: a curve built from the
    // score is monotonically increasing, one built from cost is decreasing.
    for (let i = 0; i < 20; i++) {
      const x = i / 20
      await seedCostedRun(trace, x, out, x, { costUsd: 1 - x, outputTokens: 100 + i })
    }
    const byCost = await calibrationCurve(trace, out, { id: 'costUsd' }, 'retention_7d', {
      bins: 4,
    })
    expect(byCost).not.toBeNull()
    const bins = byCost!.bins.filter((b) => b.n > 0)
    expect(bins.length).toBeGreaterThan(1)
    expect(bins[bins.length - 1]!.outcomeMean).toBeLessThan(bins[0]!.outcomeMean)
    expect(byCost!.evalMetric).toBe('costUsd')
  })

  it('correlates a token metric instead of dropping the pair', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    for (let i = 0; i < 12; i++) {
      await seedCostedRun(trace, 0.5, out, 0.2 + i * 0.05, {
        costUsd: 0.01,
        outputTokens: 100 + i * 10,
      })
    }
    const report = await correlationStudy(trace, out, [{ id: 'outputTokens' }], ['retention_7d'])
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0].n).toBe(12)
    expect(report.pairs[0].pearson).toBeGreaterThan(0.9)
  })

  it('refuses an unknown metric instead of reporting an empty study', async () => {
    const trace = new InMemoryTraceStore()
    const out = new InMemoryOutcomeStore()
    for (let i = 0; i < 5; i++) await seedRun(trace, i * 0.1, out, i * 0.1)
    await expect(
      correlationStudy(trace, out, [{ id: 'tokens' }], ['retention_7d']),
    ).rejects.toThrow(/unknown run metric 'tokens'/)
    await expect(calibrationCurve(trace, out, { id: 'tokens' }, 'retention_7d')).rejects.toThrow(
      /unknown run metric 'tokens'/,
    )
  })
})
