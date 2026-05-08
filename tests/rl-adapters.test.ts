import { describe, expect, it } from 'vitest'
import {
  trialToRunRecord,
  trialsToRunRecords,
  variantAggregateToRunRecord,
  verificationReportToRunRecord,
} from '../src/rl/run-record-adapters'
import type { TrialResult, VariantAggregate } from '../src/prompt-evolution'
import type { VerificationReport } from '../src/multi-layer-verifier'

const ctx = {
  experimentId: 'exp-1',
  model: 'claude-sonnet-4-6@2025-04-15',
  commitSha: 'cafebabe',
  promptHash: 'p'.repeat(64),
  configHash: 'c'.repeat(64),
}

const trial: TrialResult = {
  variantId: 'v1',
  scenarioId: 's1',
  rep: 0,
  ok: true,
  score: 0.7,
  cost: 0.01,
  durationMs: 1_000,
  metrics: { tool_recovery: 0.9 },
}

describe('trialToRunRecord', () => {
  it('produces a paper-grade RunRecord shape from a TrialResult', () => {
    const rec = trialToRunRecord(trial, ctx)
    expect(rec.runId).toMatch(/^run-/)
    expect(rec.experimentId).toBe('exp-1')
    expect(rec.candidateId).toBe('v1')
    expect(rec.seed).toBe(0)
    expect(rec.commitSha).toBe('cafebabe')
    expect(rec.outcome.searchScore).toBe(0.7)
    expect(rec.outcome.holdoutScore).toBeUndefined()
    expect(rec.outcome.raw.tool_recovery).toBe(0.9)
    expect(rec.outcome.raw.duration_ms).toBe(1_000)
    expect(rec.outcome.raw.cost_unknown).toBeUndefined()
    expect(rec.failureMode).toBeUndefined()
  })

  it('flags cost_unknown when the trial does not record a cost', () => {
    const rec = trialToRunRecord({ ...trial, cost: undefined }, ctx)
    expect(rec.outcome.raw.cost_unknown).toBe(1)
    expect(rec.costUsd).toBe(0)
  })

  it('routes scores into holdoutScore when splitTag=holdout', () => {
    const rec = trialToRunRecord(trial, { ...ctx, splitTag: 'holdout' })
    expect(rec.outcome.holdoutScore).toBe(0.7)
    expect(rec.outcome.searchScore).toBeUndefined()
    expect(rec.splitTag).toBe('holdout')
  })

  it('marks failed trials with a failureMode', () => {
    const rec = trialToRunRecord({ ...trial, ok: false, error: 'sandbox crashed' }, ctx)
    expect(rec.failureMode).toBe('optimizer_trial_error')
  })

  it('accepts callable hash extractors for per-trial hashes', () => {
    const rec = trialToRunRecord(trial, {
      ...ctx,
      promptHash: (t) => 'a'.repeat(64),
      configHash: (t) => 'b'.repeat(64),
    })
    expect(rec.promptHash).toBe('a'.repeat(64))
    expect(rec.configHash).toBe('b'.repeat(64))
  })

  it('trialsToRunRecords maps an array', () => {
    const recs = trialsToRunRecords([trial, { ...trial, rep: 1, score: 0.8 }], ctx)
    expect(recs).toHaveLength(2)
    expect(recs[1]?.seed).toBe(1)
    expect(recs[1]?.outcome.searchScore).toBe(0.8)
  })
})

describe('verificationReportToRunRecord', () => {
  const report: VerificationReport = {
    layers: [
      { layer: 'install', status: 'pass', score: 1, durationMs: 100, findings: [] },
      { layer: 'typecheck', status: 'pass', score: 1, durationMs: 200, findings: [], diagnostics: { errors: 0, warnings: 2 } },
      { layer: 'test', status: 'fail', score: 0.6, durationMs: 500, findings: [{ severity: 'major', message: 'one test failing' }], reason: '7 of 10 tests passed' },
    ],
    passCount: 2, failCount: 1, skippedCount: 0, errorCount: 0,
    allPass: false,
    blendedScore: 0.83,
    durationMs: 800,
    startedAt: '2026-05-08T00:00:00Z',
    finishedAt: '2026-05-08T00:00:00.800Z',
  }

  it('encodes per-layer scores into outcome.raw and identifies failureMode', () => {
    const rec = verificationReportToRunRecord(report, { ...ctx, candidateId: 'v1' })
    expect(rec.candidateId).toBe('v1')
    expect(rec.outcome.searchScore).toBe(0.83)
    expect(rec.outcome.raw['layer.install']).toBe(1)
    expect(rec.outcome.raw['layer.typecheck']).toBe(1)
    expect(rec.outcome.raw['layer.test']).toBe(0.6)
    expect(rec.outcome.raw['layer_test_pass']).toBe(0)
    expect(rec.outcome.raw['layer_install_pass']).toBe(1)
    expect(rec.outcome.raw['layer.typecheck.errors']).toBe(0)
    expect(rec.outcome.raw['layer.typecheck.warnings']).toBe(2)
    expect(rec.failureMode).toBe('layer_test_fail')
  })
})

describe('variantAggregateToRunRecord', () => {
  it('produces an aggregate-level RunRecord with raw metrics carried through', () => {
    const agg: VariantAggregate = {
      variantId: 'v1',
      meanScore: 0.72,
      meanCost: 0.012,
      meanDurationMs: 1_100,
      okRate: 0.95,
      scenarios: [],
      metrics: { tool_recovery: 0.88, judge_intent: 0.7 },
    }
    const rec = variantAggregateToRunRecord(agg, ctx)
    expect(rec.runId).toBe('agg-v1-exp-1')
    expect(rec.outcome.searchScore).toBe(0.72)
    expect(rec.outcome.raw.tool_recovery).toBe(0.88)
    expect(rec.outcome.raw.ok_rate).toBe(0.95)
  })
})
