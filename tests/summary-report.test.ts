import { describe, expect, it } from 'vitest'
import {
  summaryTable,
  paretoChart,
  gainHistogram,
  researchReport,
} from '../src/summary-report'
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

describe('summaryTable', () => {
  it('returns one row per candidate on the configured split', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 6; i++) {
      runs.push(rec('A', i, 'holdout', 0.5 + i * 0.01))
      runs.push(rec('B', i, 'holdout', 0.6 + i * 0.01))
    }
    const t = summaryTable(runs, { split: 'holdout' })
    expect(t.rows).toHaveLength(2)
    expect(t.rows.map((r) => r.candidateId).sort()).toEqual(['A', 'B'])
    expect(t.markdown).toContain('Summary Table')
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
    const t = summaryTable(runs, { comparator: 'baseline', split: 'holdout' })
    const cand = t.rows.find((r) => r.candidateId === 'cand')!
    expect(cand.qValue).toBeLessThan(0.05)
    expect(cand.cohensD).toBeGreaterThan(0.8)
    const base = t.rows.find((r) => r.candidateId === 'baseline')!
    expect(Number.isNaN(base.qValue)).toBe(true)
  })

  it('skips candidates with no runs on the requested split', () => {
    const runs = [rec('A', 0, 'search', 0.8), rec('A', 1, 'search', 0.81)]
    const t = summaryTable(runs, { split: 'holdout' })
    expect(t.rows).toHaveLength(0)
  })
})

describe('paretoChart', () => {
  it('marks dominators on-frontier and dominated points off-frontier', () => {
    const runs: RunRecord[] = [
      // Dominated: high cost, low score.
      rec('expensive_bad', 0, 'holdout', 0.5, 1.0),
      rec('expensive_bad', 1, 'holdout', 0.5, 1.0),
      // Frontier: cheap, high score.
      rec('cheap_good', 0, 'holdout', 0.8, 0.05),
      rec('cheap_good', 1, 'holdout', 0.8, 0.05),
    ]
    const f = paretoChart(runs, { split: 'holdout' })
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
    const f = paretoChart(runs, { gateDecisions: { cand: decision } })
    const p = f.points[0]!
    expect(p.gate).toBe('promote')
  })
})

describe('gainHistogram', () => {
  it('returns empty bins when no pairs match', () => {
    const runs = [rec('cand', 0, 'holdout', 0.7), rec('baseline', 1, 'holdout', 0.5)]
    const f = gainHistogram(runs, 'cand', 'baseline')
    expect(f.n).toBe(0)
    expect(f.bins).toHaveLength(0)
  })

  it('histogram count matches pair count', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 12; i++) {
      runs.push(rec('cand', i, 'holdout', 0.6 + (i % 3) * 0.05))
      runs.push(rec('baseline', i, 'holdout', 0.5))
    }
    const f = gainHistogram(runs, 'cand', 'baseline', { seed: 1, bins: 5 })
    expect(f.n).toBe(12)
    const total = f.bins.reduce((s, b) => s + b.count, 0)
    expect(total).toBe(12)
    expect(f.median).toBeGreaterThan(0)
    expect(f.ci.high).toBeGreaterThanOrEqual(f.ci.low)
  })

  it('rejects bins ≤ 0', () => {
    const runs = [rec('a', 0, 'holdout', 0.5), rec('b', 0, 'holdout', 0.5)]
    expect(() => gainHistogram(runs, 'a', 'b', { bins: 0 })).toThrow()
  })
})

describe('researchReport', () => {
  it('promotes the strongest coding-bench candidate when paired holdout evidence is decisive', async () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 24; i++) {
      runs.push(rec('baseline', i, 'holdout', 0.55 + i * 0.001, 0.08, `coding-task-${i}`))
      runs.push(rec('tool_repair_v2', i, 'holdout', 0.72 + i * 0.001, 0.10, `coding-task-${i}`))
      runs.push(rec('cheap_fast', i, 'holdout', 0.58 + i * 0.001, 0.02, `coding-task-${i}`))
    }

    const report = await researchReport(runs, {
      title: 'Coding Vertical Bench Report',
      comparator: 'baseline',
      generatedAt: '2026-05-03T00:00:00.000Z',
      seed: 1,
    })

    expect(report.kind).toBe('agent-eval-research-report')
    expect(report.recommendation.decision).toBe('promote')
    expect(report.recommendation.candidateId).toBe('tool_repair_v2')
    const tr = report.candidates.find((c) => c.candidateId === 'tool_repair_v2')!
    expect(tr.decision).toBe('promote')
    expect(tr.prGreaterThanZero).not.toBeNull()
    expect(tr.prGreaterThanZero!).toBeGreaterThan(0.95)
    expect(tr.mde).not.toBeNull()
    expect(Number.isFinite(tr.mde!)).toBe(true)
    expect(report.runFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(report.markdown).toContain('## Executive Summary')
    expect(report.markdown).toContain('## Candidate Decision Table')
    expect(report.markdown).toContain('## Methodology')
    expect(report.markdown).toContain('Pr(Δ>0)')
    expect(report.markdown).toContain('```json')
    expect(report.html).toContain('<table>')
    expect(report.charts.pareto.points).toHaveLength(3)
    expect(report.charts.gains).toHaveLength(2)
    expect(report.methodology.assumptions.length).toBeGreaterThan(0)
    expect(report.methodology.citations.some((c) => c.includes('Benjamini'))).toBe(true)
  })

  it('returns needs_more_data when paired coding runs are below the configured floor and reports an actionable MDE', async () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 8; i++) {
      runs.push(rec('baseline', i, 'holdout', 0.5 + i * 0.005, 0.05, `task-${i}`))
      runs.push(rec('candidate', i, 'holdout', 0.7 + i * 0.005, 0.05, `task-${i}`))
    }

    const report = await researchReport(runs, {
      comparator: 'baseline',
      minPairs: 20,
      generatedAt: '2026-05-03T00:00:00.000Z',
      seed: 1,
    })

    expect(report.recommendation.decision).toBe('needs_more_data')
    const c = report.candidates.find((c) => c.candidateId === 'candidate')!
    expect(c.decision).toBe('needs_more_data')
    expect(c.pairedN).toBe(8)
    expect(c.mde).not.toBeNull()
    expect(c.decisionReason).toContain('minimum detectable effect')
    expect(report.recommendation.nextActions.some((a) => /collect at least \d+ more matched/i.test(a))).toBe(true)
  })

  it('hard-floors below 6 pairs regardless of minPairs', async () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 4; i++) {
      runs.push(rec('baseline', i, 'holdout', 0.5, 0.05, `task-${i}`))
      runs.push(rec('candidate', i, 'holdout', 0.7, 0.05, `task-${i}`))
    }
    const report = await researchReport(runs, {
      comparator: 'baseline',
      minPairs: 1, // would-be override
      generatedAt: '2026-05-03T00:00:00.000Z',
      seed: 1,
    })
    expect(report.recommendation.decision).toBe('needs_more_data')
    expect(report.candidates.find((c) => c.candidateId === 'candidate')?.decisionReason).toContain('hard floor')
  })

  it('returns equivalent when paired-delta CI is fully inside ROPE', async () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 30; i++) {
      runs.push(rec('baseline', i, 'holdout', 0.6 + (i % 3) * 0.001, 0.05, `task-${i}`))
      runs.push(rec('candidate', i, 'holdout', 0.6 + (i % 3) * 0.001 + 0.0005, 0.05, `task-${i}`))
    }
    const report = await researchReport(runs, {
      comparator: 'baseline',
      rope: { low: -0.02, high: 0.02 },
      generatedAt: '2026-05-03T00:00:00.000Z',
      seed: 1,
    })
    const c = report.candidates.find((c) => c.candidateId === 'candidate')!
    expect(c.decision).toBe('equivalent')
    expect(c.prInRope).not.toBeNull()
    expect(c.prInRope!).toBeGreaterThan(0.9)
    expect(report.markdown).toContain('ROPE')
  })

  it('rejects on a held-out gate verdict even when the paired stats look favourable', async () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 24; i++) {
      runs.push(rec('baseline', i, 'holdout', 0.5 + i * 0.001, 0.08, `task-${i}`))
      runs.push(rec('candidate', i, 'holdout', 0.7 + i * 0.001, 0.10, `task-${i}`))
    }
    const decision: GateDecision = {
      promote: false,
      candidateId: 'candidate',
      baselineId: 'baseline',
      evidence: {
        productiveRuns: 24,
        medianPairedDelta: 0.2,
        pairedCI: { low: 0.18, high: 0.22 },
        pairedPValue: 0.001,
        searchScore: 0.7,
        holdoutScore: 0.7,
        overfitGap: 0.2,
        baselineOverfitGap: 0.05,
      },
      reason: 'overfit',
      rejectionCode: 'overfit_gap',
    }
    const report = await researchReport(runs, {
      comparator: 'baseline',
      gateDecisions: { candidate: decision },
      generatedAt: '2026-05-03T00:00:00.000Z',
      seed: 1,
    })
    const c = report.candidates.find((c) => c.candidateId === 'candidate')!
    expect(c.decision).toBe('reject')
    expect(c.decisionReason).toMatch(/Held-out gate/)
  })

  it('produces a deterministic run fingerprint and embeds preregistration hash when supplied', async () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 20; i++) {
      runs.push(rec('baseline', i, 'holdout', 0.5, 0.05, `task-${i}`))
      runs.push(rec('candidate', i, 'holdout', 0.7, 0.05, `task-${i}`))
    }
    const a = await researchReport(runs, { comparator: 'baseline', generatedAt: 'fixed', seed: 1, preregistrationHash: 'abc123' })
    const b = await researchReport(runs.slice().reverse(), { comparator: 'baseline', generatedAt: 'fixed', seed: 1, preregistrationHash: 'abc123' })
    expect(a.runFingerprint).toBe(b.runFingerprint)
    expect(a.preregistrationHash).toBe('abc123')
    expect(a.markdown).toContain('abc123')
    expect(a.markdown).toContain('Preregistered analysis: abc123…')
  })

  it('surfaces failure clusters as rollout risks and next actions', async () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 24; i++) {
      runs.push(rec('baseline', i, 'holdout', 0.6, 0.05, `task-${i}`))
      runs.push(rec('candidate', i, 'holdout', 0.61, 0.05, `task-${i}`))
    }

    const report = await researchReport(runs, {
      comparator: 'baseline',
      generatedAt: '2026-05-03T00:00:00.000Z',
      failureClusters: {
        totalFailures: 4,
        totalRuns: 48,
        clusters: [{
          failureClass: 'tool_recovery_failure',
          toolName: 'shell',
          runCount: 4,
          scenarioIds: ['task-1', 'task-2'],
          exampleRunId: 'candidate-1-holdout',
          exampleError: 'patch failed',
        }],
      },
      seed: 1,
    })

    expect(report.recommendation.risks.join('\n')).toContain('tool_recovery_failure')
    expect(report.markdown).toContain('## Failure Clusters')
    expect(report.markdown).toContain('patch failed')
  })
})
