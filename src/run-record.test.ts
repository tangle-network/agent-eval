import { describe, expect, it } from 'vitest'

import { type RunRecord, RunRecordValidationError, validateRunRecord } from './run-record'

function base(): RunRecord {
  return {
    runId: 'r1',
    experimentId: 'exp',
    candidateId: 'cand',
    seed: 0,
    model: 'deepseek-v4-pro@2026-05-31',
    promptHash: 'sha256:r1',
    configHash: 'sha256:cfg',
    commitSha: 'abc1234',
    wallMs: 100,
    costUsd: 0.01,
    tokenUsage: { input: 100, output: 50 },
    splitTag: 'holdout',
    scenarioId: 'sA',
    outcome: { holdoutScore: 0.8, raw: {} },
  } as RunRecord
}

describe('RunRecord — optional realness verdict (corpus carries authenticity)', () => {
  it('round-trips a valid realness verdict', () => {
    const r = base()
    r.outcome.realness = { score: 0.9, gated: false }
    const out = validateRunRecord(r)
    expect(out.outcome.realness).toEqual({ score: 0.9, gated: false })
  })

  it('accepts a gated verdict with a reason', () => {
    const r = base()
    r.outcome.realness = { score: 0.05, gated: true, reason: 'fake shim, no real impl' }
    expect(validateRunRecord(r).outcome.realness?.gated).toBe(true)
  })

  it('is optional — a record without realness still validates', () => {
    expect(validateRunRecord(base()).outcome.realness).toBeUndefined()
  })

  it('rejects a non-finite score', () => {
    const r = base()
    ;(r.outcome as { realness: unknown }).realness = { score: Number.NaN, gated: false }
    expect(() => validateRunRecord(r)).toThrow(RunRecordValidationError)
  })

  it('rejects a non-boolean gated', () => {
    const r = base()
    ;(r.outcome as { realness: unknown }).realness = { score: 0.5, gated: 'yes' }
    expect(() => validateRunRecord(r)).toThrow(/gated must be a boolean/)
  })
})
