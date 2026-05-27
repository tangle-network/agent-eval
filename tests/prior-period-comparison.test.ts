/**
 * analyzeRuns({ baselineRuns }) — prior-period comparison.
 *
 * The customer-conversion primitive: "did my last change help?" with a
 * falsifiable answer. Welch CI on the delta + Cohen's d effect size +
 * significance flag (p < 0.05 AND |d| >= 0.2). Surfaces regressed +
 * improved metric names, fires critical/investigate or low/ship
 * recommendations accordingly.
 */

import { describe, expect, it } from 'vitest'
import { analyzeRuns } from '../src/contract'
import type { RunRecord } from '../src/run-record'

function makeRun(opts: {
  id: string
  experimentId?: string
  composite: number
  cost?: number
  wallMs?: number
  judges?: Record<string, Record<string, number>>
}): RunRecord {
  const perJudge = opts.judges ?? { default: { quality: opts.composite } }
  const perDimMean: Record<string, number> = {}
  for (const dims of Object.values(perJudge)) {
    for (const [d, v] of Object.entries(dims)) {
      perDimMean[d] = (perDimMean[d] ?? 0) + v / Object.keys(perJudge).length
    }
  }
  return {
    runId: opts.id,
    experimentId: opts.experimentId ?? 'exp',
    candidateId: 'c',
    seed: 0,
    model: 'm@v',
    promptHash: 'sha256:p',
    configHash: 'sha256:c',
    commitSha: 'abc',
    wallMs: opts.wallMs ?? 100,
    costUsd: opts.cost ?? 0.01,
    tokenUsage: { input: 100, output: 50 },
    outcome: {
      holdoutScore: opts.composite,
      raw: {},
      judgeScores: { perJudge, perDimMean, composite: opts.composite },
    },
    splitTag: 'holdout',
  }
}

describe('analyzeRuns — prior-period comparison', () => {
  it('does not produce a comparison block when baselineRuns is omitted', async () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      makeRun({ id: `r-${i}`, composite: 0.7 + i * 0.01 }),
    )
    const report = await analyzeRuns({ runs })
    expect(report.priorPeriodComparison).toBeUndefined()
  })

  it('produces a comparison block when baselineRuns is provided', async () => {
    const current = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `cur-${i}`, composite: 0.8 + (i % 3) * 0.01 }),
    )
    const baseline = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `bas-${i}`, composite: 0.7 + (i % 3) * 0.01 }),
    )
    const report = await analyzeRuns({ runs: current, baselineRuns: baseline })
    const ppc = report.priorPeriodComparison
    expect(ppc).toBeDefined()
    expect(ppc!.baselineN).toBe(30)
    expect(ppc!.currentN).toBe(30)
    expect(ppc!.metrics.composite).toBeDefined()
    expect(ppc!.metrics.composite!.delta).toBeCloseTo(0.1, 1)
    expect(ppc!.metrics.composite!.significant).toBe(true)
    expect(ppc!.improvedMetrics).toContain('composite')
    expect(ppc!.regressedMetrics).not.toContain('composite')
  })

  it('flags regressed metrics when current is significantly worse', async () => {
    const current = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `cur-${i}`, composite: 0.55 + (i % 3) * 0.01 }),
    )
    const baseline = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `bas-${i}`, composite: 0.85 + (i % 3) * 0.01 }),
    )
    const report = await analyzeRuns({
      runs: current,
      baselineRuns: baseline,
      baselineLabel: 'vs prior 7 days',
    })
    const ppc = report.priorPeriodComparison!
    expect(ppc.windowLabel).toBe('vs prior 7 days')
    expect(ppc.regressedMetrics).toContain('composite')
    expect(ppc.improvedMetrics).not.toContain('composite')

    // Recommendation engine fires critical/investigate on regression.
    const critical = report.recommendations.find(
      (r) => r.priority === 'critical' && r.title.includes('composite regressed'),
    )
    expect(critical).toBeDefined()
    expect(critical!.detail).toMatch(/Welch CI95/)
    expect(critical!.detail).toMatch(/Cohen's d/)
  })

  it('treats cost + duration as lower-is-better (higher current = regression)', async () => {
    const current = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `cur-${i}`, composite: 0.8, cost: 0.5 + (i % 3) * 0.01 }),
    )
    const baseline = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `bas-${i}`, composite: 0.8, cost: 0.1 + (i % 3) * 0.01 }),
    )
    const report = await analyzeRuns({ runs: current, baselineRuns: baseline })
    const ppc = report.priorPeriodComparison!
    // Cost went UP (worse for the customer) — should land in regressedMetrics.
    expect(ppc.regressedMetrics).toContain('cost')
    expect(ppc.improvedMetrics).not.toContain('cost')
  })

  it('treats lower duration as improved', async () => {
    const current = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `cur-${i}`, composite: 0.8, wallMs: 50 + (i % 3) * 2 }),
    )
    const baseline = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `bas-${i}`, composite: 0.8, wallMs: 200 + (i % 3) * 2 }),
    )
    const report = await analyzeRuns({ runs: current, baselineRuns: baseline })
    const ppc = report.priorPeriodComparison!
    // Duration went DOWN (faster) — should land in improvedMetrics.
    expect(ppc.improvedMetrics).toContain('duration')
    expect(ppc.regressedMetrics).not.toContain('duration')
  })

  it('does NOT flag as significant when the delta is within noise', async () => {
    // Same distribution mean, just different RNG-ish variance — no real change.
    const current = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `cur-${i}`, composite: 0.7 + ((i * 7) % 5) * 0.005 }),
    )
    const baseline = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `bas-${i}`, composite: 0.7 + ((i * 11) % 5) * 0.005 }),
    )
    const report = await analyzeRuns({ runs: current, baselineRuns: baseline })
    const ppc = report.priorPeriodComparison!
    // Neither significantly improved nor regressed — both lists empty for composite.
    expect(ppc.regressedMetrics).not.toContain('composite')
    expect(ppc.improvedMetrics).not.toContain('composite')
    expect(ppc.metrics.composite!.significant).toBe(false)
  })

  it('produces per-dimension comparisons when judge scores are present in both', async () => {
    const judgesCur = { default: { clarity: 0.9, concision: 0.8 } }
    const judgesBas = { default: { clarity: 0.5, concision: 0.8 } }
    const current = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `cur-${i}`, composite: 0.85, judges: judgesCur }),
    )
    const baseline = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `bas-${i}`, composite: 0.65, judges: judgesBas }),
    )
    const report = await analyzeRuns({ runs: current, baselineRuns: baseline })
    const ppc = report.priorPeriodComparison!
    expect(ppc.metrics['dim.clarity']).toBeDefined()
    expect(ppc.metrics['dim.clarity']!.delta).toBeCloseTo(0.4, 1)
    expect(ppc.improvedMetrics).toContain('dim.clarity')
    // concision unchanged — should not be in either list as significant
    expect(ppc.improvedMetrics).not.toContain('dim.concision')
    expect(ppc.regressedMetrics).not.toContain('dim.concision')
  })

  it('returns undefined comparison when either window is empty', async () => {
    const runs = [makeRun({ id: 'r-0', composite: 0.5 })]
    const report = await analyzeRuns({ runs, baselineRuns: [] })
    expect(report.priorPeriodComparison).toBeUndefined()
  })

  it('reports CI that brackets the true delta when distributions are normal-ish', async () => {
    // Construct deterministic data with known mean delta = 0.1
    const current = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `cur-${i}`, composite: 0.7 + ((i * 13) % 11) / 200 }),
    )
    const baseline = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `bas-${i}`, composite: 0.6 + ((i * 13) % 11) / 200 }),
    )
    const report = await analyzeRuns({ runs: current, baselineRuns: baseline })
    const d = report.priorPeriodComparison!.metrics.composite!
    expect(d.delta).toBeCloseTo(0.1, 2)
    expect(d.ci95[0]).toBeLessThan(d.delta)
    expect(d.ci95[1]).toBeGreaterThan(d.delta)
    expect(d.ci95[0]).toBeGreaterThan(0) // significant positive
  })

  it('fires a low/ship recommendation on a significant improvement', async () => {
    const current = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `cur-${i}`, composite: 0.85 + (i % 3) * 0.005 }),
    )
    const baseline = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `bas-${i}`, composite: 0.65 + (i % 3) * 0.005 }),
    )
    const report = await analyzeRuns({ runs: current, baselineRuns: baseline })
    const ship = report.recommendations.find(
      (r) => r.kind === 'ship' && r.title.includes('composite improved'),
    )
    expect(ship).toBeDefined()
    expect(ship!.priority).toBe('low')
  })
})
