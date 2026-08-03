import { describe, expect, it } from 'vitest'
import type { CampaignResult } from '../src/campaign'
import { campaignCellJudgeDimensions } from '../src/campaign/run-record'
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
        costProvenance: { kind: 'observed', usd: 0.01 },
        tokenUsage: { input: 12, output: 4, cached: 3 },
        durationMs: 1_000,
        seed: 7,
        cached: false,
      },
      {
        cellId: 'cell-s2-r0',
        scenarioId: 's2',
        rep: 0,
        artifact: { text: 'b' },
        judgeScores: {
          j1: { composite: 0.8, dimensions: { clarity: 0.9 }, notes: 'partial evidence' },
          j2: { composite: 0, dimensions: { safety: 0 }, notes: 'failed', failed: true },
        },
        costUsd: 0,
        costProvenance: { kind: 'observed', usd: 0 },
        tokenUsage: { input: 7, output: 2 },
        durationMs: 50,
        seed: 8,
        cached: false,
        errorStage: 'judge',
        errorJudge: 'j2',
        error: 'judge threw',
      },
      {
        cellId: 'cell-s3-r0',
        scenarioId: 's3',
        rep: 0,
        artifact: null,
        judgeScores: {},
        costUsd: 0,
        costProvenance: { kind: 'observed', usd: 0 },
        tokenUsage: { input: 3, output: 1 },
        durationMs: 25,
        seed: 9,
        cached: false,
        errorStage: 'dispatch',
        error: 'worker crashed',
      },
      {
        cellId: 'cell-s4-r0',
        scenarioId: 's4',
        rep: 0,
        artifact: null,
        judgeScores: {},
        costUsd: 0,
        costProvenance: { kind: 'observed', usd: 0 },
        tokenUsage: { input: 0, output: 0 },
        durationMs: 10,
        seed: 10,
        cached: false,
        error: 'legacy unclassified failure',
      },
    ],
  } as unknown as CampaignResult

  it('produces one RunRecord per cell with mean-composite scores + dimensions', () => {
    const recs = campaignToRunRecords(campaign, ctx)
    expect(recs).toHaveLength(4)
    const first = recs[0]!
    expect(first.runId).toBe('cell-s1-r0')
    expect(first.scenarioId).toBe('s1')
    expect(first.candidateId).toBe('abc123') // defaults to manifestHash
    expect(first.seed).toBe(7)
    // mean of judge composites 0.8 + 0.6 = 0.7
    expect(first.outcome.searchScore).toBeCloseTo(0.7, 5)
    expect(first.outcome.raw['j1.clarity']).toBe(0.9)
    expect(first.outcome.raw['j2.safety']).toBe(0.5)
    expect(first.outcome.raw.generation).toBe(0)
    expect(first.tokenUsage).toEqual({ input: 12, output: 4, cached: 3 })
    expect(first.terminalOutcome).toBe('succeeded')
    expect(first.outcome.raw.execution_error_count).toBe(0)
    expect(first.failureMode).toBeUndefined()
  })

  it('separates judge, dispatch, and legacy unclassified errors', () => {
    const recs = campaignToRunRecords(campaign, {
      ...ctx,
      splitTag: 'holdout',
      candidateId: 'cand-x',
    })
    expect(recs[0]!.candidateId).toBe('cand-x')
    expect(recs[0]!.outcome.holdoutScore).toBeCloseTo(0.7, 5)
    expect(recs[0]!.outcome.searchScore).toBeUndefined()
    const judgeErrored = recs[1]!
    expect(judgeErrored.outcome.holdoutScore).toBeUndefined()
    expect(judgeErrored.outcome.searchScore).toBeUndefined()
    expect(judgeErrored.terminalOutcome).toBe('succeeded')
    expect(judgeErrored.outcome.raw.execution_error_count).toBe(0)
    expect(judgeErrored.outcome.raw.judge_error_count).toBe(1)
    expect(judgeErrored.outcome.raw['j1.clarity']).toBe(0.9)
    expect(judgeErrored.outcome.judgeScores).toMatchObject({
      perJudge: { j1: { clarity: 0.9 } },
      failedJudges: ['j2'],
    })
    expect(campaignCellJudgeDimensions(campaign.cells[1]!)).toEqual({
      j1: { clarity: 0.9 },
    })
    expect(judgeErrored.tokenUsage).toEqual({ input: 7, output: 2 })
    expect(judgeErrored.failureMode).toBeUndefined()

    const dispatchErrored = recs[2]!
    expect(dispatchErrored.outcome.holdoutScore).toBeUndefined()
    expect(dispatchErrored.terminalOutcome).toBe('failed')
    expect(dispatchErrored.terminalFailureReason).toBe('worker crashed')
    expect(dispatchErrored.outcome.raw.execution_error_count).toBe(1)
    expect(dispatchErrored.failureMode).toBeUndefined()

    const legacyErrored = recs[3]!
    expect(legacyErrored.outcome.holdoutScore).toBeUndefined()
    expect(legacyErrored.terminalOutcome).toBe('unknown')
    expect(legacyErrored.outcome.raw.execution_error_count).toBeUndefined()
    expect(legacyErrored.outcome.raw.unclassified_error_count).toBe(1)
    expect(legacyErrored.failureMode).toBeUndefined()
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
    taskScore: 0.83,
    valid: false,
    score: 0.83,
    durationMs: 800,
    startedAt: '2026-05-08T00:00:00Z',
    finishedAt: '2026-05-08T00:00:00.800Z',
  }

  it('maps an actual scored failure to a task score and failureMode', () => {
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
    expect(rec.outcome.raw.execution_error_count).toBe(0)
    expect(rec.failureMode).toBe('layer_test_fail')
  })

  it('keeps an all-error report unlabeled and records execution telemetry', () => {
    const rec = verificationReportToRunRecord(
      {
        layers: [
          {
            layer: 'transport',
            status: 'error',
            errorSource: 'execution',
            durationMs: 10,
            findings: [{ severity: 'major', message: 'connection reset' }],
          },
        ],
        passCount: 0,
        failCount: 0,
        skippedCount: 0,
        errorCount: 1,
        allPass: false,
        blendedScore: 0,
        valid: false,
        score: 0,
        durationMs: 10,
        startedAt: '2026-05-08T00:00:00Z',
        finishedAt: '2026-05-08T00:00:00.010Z',
      },
      { ...ctx, candidateId: 'all-error' },
    )

    expect(rec.outcome.searchScore).toBeUndefined()
    expect(rec.outcome.holdoutScore).toBeUndefined()
    expect(rec.outcome.raw.blended_score).toBeUndefined()
    expect(rec.outcome.raw.execution_error_count).toBe(1)
    expect(rec.outcome.raw.layer_error_count).toBe(1)
    expect(rec.failureMode).toBeUndefined()
    expect(rec.failureClass).toBeUndefined()
  })

  it('keeps an all-timeout report unlabeled and separates judge telemetry', () => {
    const rec = verificationReportToRunRecord(
      {
        layers: [
          {
            layer: 'semantic',
            status: 'timeout',
            errorSource: 'judge',
            durationMs: 500,
            findings: [{ severity: 'major', message: 'judge timed out' }],
          },
        ],
        passCount: 0,
        failCount: 0,
        skippedCount: 0,
        errorCount: 1,
        allPass: false,
        blendedScore: 0,
        valid: false,
        score: 0,
        durationMs: 500,
        startedAt: '2026-05-08T00:00:00Z',
        finishedAt: '2026-05-08T00:00:00.500Z',
      },
      { ...ctx, candidateId: 'all-timeout' },
    )

    expect(rec.outcome.searchScore).toBeUndefined()
    expect(rec.outcome.raw.execution_error_count).toBe(0)
    expect(rec.outcome.raw.judge_error_count).toBe(1)
    expect(rec.outcome.raw.layer_timeout_count).toBe(1)
    expect(rec.failureMode).toBeUndefined()
    expect(rec.failureClass).toBeUndefined()
  })

  it('keeps an unscored pass unlabeled', () => {
    const rec = verificationReportToRunRecord(
      {
        layers: [{ layer: 'lint', status: 'pass', durationMs: 20, findings: [] }],
        passCount: 1,
        failCount: 0,
        skippedCount: 0,
        errorCount: 0,
        allPass: false,
        blendedScore: 0,
        valid: false,
        score: 0,
        durationMs: 20,
        startedAt: '2026-05-08T00:00:00Z',
        finishedAt: '2026-05-08T00:00:00.020Z',
      },
      { ...ctx, candidateId: 'unscored-pass' },
    )

    expect(rec.outcome.searchScore).toBeUndefined()
    expect(rec.outcome.raw.blended_score).toBeUndefined()
    expect(rec.outcome.raw.unscored_layer_count).toBe(1)
    expect(rec.failureMode).toBeUndefined()
  })

  it('preserves partial panel diagnostics without emitting a task score', () => {
    const rec = verificationReportToRunRecord(
      {
        layers: [
          { layer: 'tests', status: 'pass', score: 0.8, durationMs: 80, findings: [] },
          {
            layer: 'semantic',
            status: 'error',
            errorSource: 'judge',
            durationMs: 100,
            findings: [{ severity: 'major', message: 'invalid judge response' }],
          },
        ],
        passCount: 1,
        failCount: 0,
        skippedCount: 0,
        errorCount: 1,
        allPass: false,
        blendedScore: 0.8,
        valid: false,
        score: 0,
        durationMs: 180,
        startedAt: '2026-05-08T00:00:00Z',
        finishedAt: '2026-05-08T00:00:00.180Z',
      },
      { ...ctx, candidateId: 'partial-panel' },
    )

    expect(rec.outcome.searchScore).toBeUndefined()
    expect(rec.outcome.raw.blended_score).toBeUndefined()
    expect(rec.outcome.raw['layer.tests']).toBe(0.8)
    expect(rec.outcome.raw.judge_error_count).toBe(1)
    expect(rec.failureMode).toBeUndefined()
    expect(rec.failureClass).toBeUndefined()
  })
})
