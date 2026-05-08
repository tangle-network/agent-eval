import { describe, expect, it } from 'vitest'
import {
  extractVerifiableReward,
  extractVerifiableRewardsFromRecords,
  filterDeterministicallyRewarded,
} from '../src/rl/verifiable-reward'
import type { VerificationReport } from '../src/multi-layer-verifier'
import type { RunRecord } from '../src/run-record'

function report(layers: VerificationReport['layers']): VerificationReport {
  const passCount = layers.filter((l) => l.status === 'pass').length
  return {
    layers, passCount,
    failCount: layers.filter((l) => l.status === 'fail').length,
    skippedCount: 0, errorCount: 0,
    allPass: passCount === layers.length,
    blendedScore: layers.reduce((s, l) => s + (l.score ?? 0), 0) / Math.max(1, layers.length),
    durationMs: 100,
    startedAt: 'a', finishedAt: 'b',
  }
}

describe('extractVerifiableReward', () => {
  it('returns deterministic reward when a single test layer fires', () => {
    const r = extractVerifiableReward(report([
      { layer: 'test', status: 'pass', score: 0.9, durationMs: 100, findings: [] },
    ]))
    expect(r?.value).toBe(0.9)
    expect(r?.source).toBe('test')
    expect(r?.determinism).toBe('deterministic')
    expect(r?.confidence).toBe(1)
  })

  it('returns composite when multiple deterministic layers contribute', () => {
    const r = extractVerifiableReward(report([
      { layer: 'compile', status: 'pass', score: 1, durationMs: 50, findings: [] },
      { layer: 'test', status: 'pass', score: 0.8, durationMs: 100, findings: [] },
    ]))
    expect(r?.source).toBe('composite')
    expect(r?.determinism).toBe('deterministic')
    expect(r?.value).toBeCloseTo(0.9, 5)
    expect(r?.breakdown?.test).toBe(0.8)
    expect(r?.breakdown?.compile).toBe(1)
  })

  it('falls back to judge when no deterministic layer is present', () => {
    const r = extractVerifiableReward(report([
      { layer: 'semantic_judge', status: 'pass', score: 0.7, durationMs: 100, findings: [] },
    ]))
    expect(r?.source).toBe('judge')
    expect(r?.determinism).toBe('probabilistic')
    expect(r?.confidence).toBeLessThan(1)
  })

  it('returns null when fallbackToJudge=false and only probabilistic layers exist', () => {
    const r = extractVerifiableReward(report([
      { layer: 'semantic_judge', status: 'pass', score: 0.7, durationMs: 100, findings: [] },
    ]), { fallbackToJudge: false })
    expect(r).toBeNull()
  })
})

describe('extractVerifiableRewardsFromRecords', () => {
  function rec(layerScores: Record<string, number>, primary = 0.5): RunRecord {
    const raw: Record<string, number> = {}
    for (const [k, v] of Object.entries(layerScores)) raw[`layer.${k}`] = v
    return {
      runId: `r-${Math.random()}`,
      experimentId: 'e', candidateId: 'c', seed: 0,
      model: 'm@1', promptHash: 'p'.repeat(64), configHash: 'c'.repeat(64),
      commitSha: 'abcd', wallMs: 1, costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
      outcome: { holdoutScore: primary, raw },
      splitTag: 'holdout',
    }
  }

  it('recovers per-layer scores from outcome.raw and produces deterministic rewards', () => {
    const out = extractVerifiableRewardsFromRecords([rec({ test: 0.9 })])
    expect(out[0]?.reward?.source).toBe('test')
    expect(out[0]?.reward?.determinism).toBe('deterministic')
    expect(out[0]?.reward?.value).toBe(0.9)
  })

  it('filterDeterministicallyRewarded keeps only deterministic-rewarded runs', () => {
    const filtered = filterDeterministicallyRewarded([
      rec({ test: 0.9 }),
      rec({}, 0.7),  // judge-only fallback would be probabilistic
    ])
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.reward.source).toBe('test')
  })
})
