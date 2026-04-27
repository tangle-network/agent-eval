import { describe, expect, it } from 'vitest'
import {
  paperTable,
  paretoFigure,
  gainDistributionFigure,
} from '../src/paper-report'
import type { RunRecord } from '../src/run-record'
import type { GateDecision } from '../src/promotion-gate'

function rec(
  candidateId: string,
  seed: number,
  splitTag: 'search' | 'holdout',
  score: number,
  costUsd = 0.01,
  experimentId = 'exp1',
): RunRecord {
  return {
    runId: `${candidateId}-${seed}-${splitTag}`,
    experimentId,
    candidateId,
    seed,
    model: 'claude-sonnet-4-6@2025-04-15',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'abcd',
    wallMs: 1000,
    costUsd,
    tokenUsage: { input: 100, output: 100 },
    outcome:
      splitTag === 'holdout'
        ? { holdoutScore: score, raw: {} }
        : { searchScore: score, raw: {} },
    splitTag,
  }
}

describe('paperTable', () => {
  it('returns one row per candidate on the configured split', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 6; i++) {
      runs.push(rec('A', i, 'holdout', 0.5 + i * 0.01))
      runs.push(rec('B', i, 'holdout', 0.6 + i * 0.01))
    }
    const t = paperTable(runs, { split: 'holdout' })
    expect(t.rows).toHaveLength(2)
    expect(t.rows.map((r) => r.candidateId).sort()).toEqual(['A', 'B'])
    expect(t.markdown).toContain('Paper Table')
    expect(t.markdown).toContain('| A |')
    expect(t.markdown).toContain('| B |')
  })

  it('computes BH-adjusted q-values and Cohen\'s d versus comparator', () => {
    const runs: RunRecord[] = []
    // baseline: ~0.5; cand: ~0.7 — strong, paired
    for (let i = 0; i < 8; i++) {
      runs.push(rec('baseline', i, 'holdout', 0.5 + i * 0.001))
      runs.push(rec('cand', i, 'holdout', 0.7 + i * 0.001))
    }
    const t = paperTable(runs, { comparator: 'baseline', split: 'holdout' })
    const cand = t.rows.find((r) => r.candidateId === 'cand')!
    expect(cand.qValue).toBeLessThan(0.05)
    expect(cand.cohensD).toBeGreaterThan(0.8)
    const base = t.rows.find((r) => r.candidateId === 'baseline')!
    expect(Number.isNaN(base.qValue)).toBe(true)
  })

  it('skips candidates with no runs on the requested split', () => {
    const runs = [rec('A', 0, 'search', 0.8), rec('A', 1, 'search', 0.81)]
    const t = paperTable(runs, { split: 'holdout' })
    expect(t.rows).toHaveLength(0)
  })
})

describe('paretoFigure', () => {
  it('marks dominators on-frontier and dominated points off-frontier', () => {
    const runs: RunRecord[] = [
      // Dominated: high cost, low score.
      rec('expensive_bad', 0, 'holdout', 0.5, 1.0),
      rec('expensive_bad', 1, 'holdout', 0.5, 1.0),
      // Frontier: cheap, high score.
      rec('cheap_good', 0, 'holdout', 0.8, 0.05),
      rec('cheap_good', 1, 'holdout', 0.8, 0.05),
    ]
    const f = paretoFigure(runs, { split: 'holdout' })
    const cheap = f.points.find((p) => p.candidateId === 'cheap_good')!
    const expensive = f.points.find((p) => p.candidateId === 'expensive_bad')!
    expect(cheap.onFrontier).toBe(true)
    expect(expensive.onFrontier).toBe(false)
  })

  it('overlays gate decisions when provided', () => {
    const runs = [rec('cand', 0, 'holdout', 0.8, 0.1)]
    const decision: GateDecision = {
      promote: true,
      candidateId: 'cand',
      baselineId: 'base',
      evidence: {
        productiveRuns: 5,
        medianPairedDelta: 0.1,
        pairedCI: { low: 0.05, high: 0.15 },
        pairedPValue: 0.01,
        searchScore: 0.85,
        holdoutScore: 0.8,
        overfitGap: 0.05,
        baselineOverfitGap: 0.05,
      },
      reason: 'ok',
      rejectionCode: null,
    }
    const f = paretoFigure(runs, { gateDecisions: { cand: decision } })
    const p = f.points[0]!
    expect(p.gate).toBe('promote')
  })
})

describe('gainDistributionFigure', () => {
  it('returns empty bins when no pairs match', () => {
    const runs = [rec('cand', 0, 'holdout', 0.7), rec('baseline', 1, 'holdout', 0.5)]
    const f = gainDistributionFigure(runs, 'cand', 'baseline')
    expect(f.n).toBe(0)
    expect(f.bins).toHaveLength(0)
  })

  it('histogram count matches pair count', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 12; i++) {
      runs.push(rec('cand', i, 'holdout', 0.6 + (i % 3) * 0.05))
      runs.push(rec('baseline', i, 'holdout', 0.5))
    }
    const f = gainDistributionFigure(runs, 'cand', 'baseline', { seed: 1, bins: 5 })
    expect(f.n).toBe(12)
    const total = f.bins.reduce((s, b) => s + b.count, 0)
    expect(total).toBe(12)
    expect(f.median).toBeGreaterThan(0)
    expect(f.ci.high).toBeGreaterThanOrEqual(f.ci.low)
  })

  it('rejects bins ≤ 0', () => {
    const runs = [rec('a', 0, 'holdout', 0.5), rec('b', 0, 'holdout', 0.5)]
    expect(() => gainDistributionFigure(runs, 'a', 'b', { bins: 0 })).toThrow()
  })
})
