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
  it('returns strong positive correlation when eval score predicts outcome — regression: framework without this is ornamental', async () => {
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
    expect(report.pairs[0].pearsonCi95.lower).toBeGreaterThan(0)
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
})

describe('calibrationCurve', () => {
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
