import { describe, expect, it } from 'vitest'
import { runCanaries } from '../src/canary'
import type { RunRecord } from '../src/run-record'

function rec(
  i: number,
  judge: { confidence: number; fallback?: boolean } | null,
  bucket: string | null = null,
): RunRecord {
  return {
    runId: `r${i}`,
    experimentId: 'exp',
    candidateId: 'cand',
    seed: i,
    model: 'claude-sonnet-4-6@2025-04-15',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'sha',
    wallMs: 1,
    costUsd: 0.001,
    tokenUsage: { input: 1, output: 1 },
    judgeMetadata: judge
      ? {
          model: 'judge-1@2025-01-01',
          promptVersion: 'v1',
          confidence: judge.confidence,
          fallback: judge.fallback ?? false,
        }
      : undefined,
    outcome: { holdoutScore: 0.5, raw: bucket ? { bucket: 1 } : {} },
    splitTag: 'holdout',
    failureMode: bucket ?? undefined,
  }
}

describe('runCanaries — silent_judge_fallback', () => {
  it('alerts after 3 consecutive fallbacks', () => {
    const runs: RunRecord[] = [
      rec(0, { confidence: 0.85 }),
      rec(1, { confidence: 0.3 }),
      rec(2, { confidence: 0.3 }),
      rec(3, { confidence: 0.3 }),
    ]
    const r = runCanaries(runs)
    expect(r.counts.silent_judge_fallback).toBe(1)
    expect(r.alerts[0]!.severity).toBe('error')
    expect(r.alerts[0]!.evidence.streakLength).toBe(3)
  })

  it('respects fallback boolean even when confidence varies', () => {
    const runs: RunRecord[] = [
      rec(0, { confidence: 0.9 }),
      rec(1, { confidence: 0.7, fallback: true }),
      rec(2, { confidence: 0.6, fallback: true }),
      rec(3, { confidence: 0.5, fallback: true }),
    ]
    const r = runCanaries(runs)
    expect(r.counts.silent_judge_fallback).toBe(1)
  })

  it('does not alert when fallbacks are isolated', () => {
    const runs: RunRecord[] = [
      rec(0, { confidence: 0.85 }),
      rec(1, { confidence: 0.3 }),
      rec(2, { confidence: 0.85 }),
      rec(3, { confidence: 0.3 }),
      rec(4, { confidence: 0.85 }),
    ]
    const r = runCanaries(runs)
    expect(r.counts.silent_judge_fallback).toBe(0)
  })

  it('respects custom constant + threshold', () => {
    const runs: RunRecord[] = [
      rec(0, { confidence: 0.5 }),
      rec(1, { confidence: 0.5 }),
    ]
    const r = runCanaries(runs, {
      silentFallback: { constant: 0.5, consecutiveThreshold: 2 },
    })
    expect(r.counts.silent_judge_fallback).toBe(1)
  })

  it('skips runs without judgeMetadata', () => {
    const runs: RunRecord[] = [
      rec(0, null),
      rec(1, null),
      rec(2, null),
    ]
    const r = runCanaries(runs)
    expect(r.counts.silent_judge_fallback).toBe(0)
  })
})

describe('runCanaries — judge_calibration_drift', () => {
  it('fires when recent confidences are systematically lower', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 50; i++) {
      runs.push(rec(i, { confidence: 0.85 + (i % 5) * 0.01 }))
    }
    for (let i = 50; i < 70; i++) {
      runs.push(rec(i, { confidence: 0.4 + (i % 5) * 0.01 }))
    }
    const r = runCanaries(runs, {
      calibrationDrift: { historyWindow: 50, recentWindow: 20, ksAlpha: 0.05, minRecent: 10 },
    })
    expect(r.counts.judge_calibration_drift).toBe(1)
    const evidence = r.alerts.find((a) => a.kind === 'judge_calibration_drift')!.evidence as Record<string, number>
    expect(evidence.recentMean).toBeLessThan(evidence.historyMean!)
  })

  it('does not fire when recent matches historical', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 70; i++) {
      runs.push(rec(i, { confidence: 0.8 + (i % 7) * 0.01 }))
    }
    const r = runCanaries(runs)
    expect(r.counts.judge_calibration_drift).toBe(0)
  })

  it('skips when sample is too small', () => {
    const runs: RunRecord[] = [rec(0, { confidence: 0.5 }), rec(1, { confidence: 0.5 })]
    const r = runCanaries(runs)
    expect(r.counts.judge_calibration_drift).toBe(0)
  })
})

describe('runCanaries — distribution_shift', () => {
  it('fires when recent bucket mix differs', () => {
    const runs: RunRecord[] = []
    // History: 70 runs evenly split 'A'/'B'.
    for (let i = 0; i < 70; i++) {
      runs.push(rec(i, { confidence: 0.8 }, i % 2 === 0 ? 'A' : 'B'))
    }
    // Recent: 20 runs all in bucket 'C'.
    for (let i = 70; i < 90; i++) {
      runs.push(rec(i, { confidence: 0.8 }, 'C'))
    }
    const r = runCanaries(runs, {
      distributionShift: {
        category: (run) => run.failureMode ?? null,
        chiSquareAlpha: 0.05,
        historyWindow: 70,
        recentWindow: 20,
        minRecent: 10,
      },
    })
    expect(r.counts.distribution_shift).toBe(1)
  })

  it('skipped entirely when no category fn is provided', () => {
    const runs = Array.from({ length: 100 }, (_, i) => rec(i, { confidence: 0.8 }, 'A'))
    const r = runCanaries(runs)
    expect(r.counts.distribution_shift).toBe(0)
  })

  it('does not fire on similar mixes', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 90; i++) {
      runs.push(rec(i, { confidence: 0.8 }, i % 3 === 0 ? 'A' : 'B'))
    }
    const r = runCanaries(runs, {
      distributionShift: {
        category: (run) => run.failureMode ?? null,
        chiSquareAlpha: 0.05,
        historyWindow: 70,
        recentWindow: 20,
        minRecent: 10,
      },
    })
    expect(r.counts.distribution_shift).toBe(0)
  })
})
