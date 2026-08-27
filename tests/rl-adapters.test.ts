import { describe, expect, it } from 'vitest'
import type { CampaignResult } from '../src/campaign'
import type { VerificationReport } from '../src/multi-layer-verifier'
import { campaignToRunRecords, verificationReportToRunRecord } from '../src/rl/run-record-adapters'

const ctx = {
  experimentId: 'exp-1',
  model: 'claude-sonnet-4-6@2025-04-15',
  commitSha: 'cafebabe',
  promptHash: 'p'.repeat(64),
  configHash: 'c'.repeat(64),
}

describe('campaignToRunRecords', () => {
  // The adapter only reads cells + manifestHash; a partial campaign is enough.
  const campaign = {
    manifestHash: 'abc123',
    cells: [
      {
        cellId: 'cell-s1-r0',
        scenarioId: 's1',
        rep: 0,
        generation: 0,
        artifact: { text: 'a' },
        judgeScores: {
          j1: { composite: 0.8, dimensions: { clarity: 0.9 }, notes: '' },
          j2: { composite: 0.6, dimensions: { safety: 0.5 }, notes: '' },
        },
        costUsd: 0.01,
        durationMs: 1_000,
        seed: 7,
        cached: false,
      },
      {
        cellId: 'cell-s2-r0',
        scenarioId: 's2',
        rep: 0,
        artifact: { text: 'b' },
        judgeScores: {},
        costUsd: 0,
        durationMs: 50,
        seed: 8,
        cached: false,
        error: 'judge threw',
      },
    ],
  } as unknown as CampaignResult

  it('produces one RunRecord per cell with mean-composite scores + dimensions', () => {
    const recs = campaignToRunRecords(campaign, ctx)
    expect(recs).toHaveLength(2)
    const first = recs[0]!
    expect(first.runId).toBe('cell-s1-r0')
    expect(first.scenarioId).toBe('s1')
    expect(first.candidateId).toBe('abc123') // defaults to manifestHash
    expect(first.seed).toBe(7)
    // mean of judge composites 0.8 + 0.6 = 0.7
    expect(first.outcome.searchScore).toBeCloseTo(0.7, 5)
    expect(first.outcome.raw['dim.clarity']).toBe(0.9)
    expect(first.outcome.raw['dim.safety']).toBe(0.5)
    expect(first.outcome.raw.generation).toBe(0)
    expect(first.failureMode).toBeUndefined()
  })

  it('routes scores to holdoutScore + marks errored cells', () => {
    const recs = campaignToRunRecords(campaign, {
      ...ctx,
      splitTag: 'holdout',
      candidateId: 'cand-x',
    })
    expect(recs[0]!.candidateId).toBe('cand-x')
    expect(recs[0]!.outcome.holdoutScore).toBeCloseTo(0.7, 5)
    expect(recs[0]!.outcome.searchScore).toBeUndefined()
    // errored cell: zero score, failureMode set, still emitted (not dropped)
    expect(recs[1]!.outcome.holdoutScore).toBe(0)
    expect(recs[1]!.failureMode).toBe('cell_error')
  })
})

describe('verificationReportToRunRecord', () => {
  const report: VerificationReport = {
    layers: [
      { layer: 'install', status: 'pass', score: 1, durationMs: 100, findings: [] },
      {
        layer: 'typecheck',
        status: 'pass',
        score: 1,
        durationMs: 200,
        findings: [],
        diagnostics: { errors: 0, warnings: 2 },
      },
      {
        layer: 'test',
        status: 'fail',
        score: 0.6,
        durationMs: 500,
        findings: [{ severity: 'major', message: 'one test failing' }],
        reason: '7 of 10 tests passed',
      },
    ],
    passCount: 2,
    failCount: 1,
    skippedCount: 0,
    errorCount: 0,
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
    expect(rec.outcome.raw.layer_test_pass).toBe(0)
    expect(rec.outcome.raw.layer_install_pass).toBe(1)
    expect(rec.outcome.raw['layer.typecheck.errors']).toBe(0)
    expect(rec.outcome.raw['layer.typecheck.warnings']).toBe(2)
    expect(rec.failureMode).toBe('layer_test_fail')
  })
})
