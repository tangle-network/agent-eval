import { describe, expect, it } from 'vitest'
import { buildAgentProfileCell } from '../src/agent-profile-cell'
import {
  isRunRecord,
  parseRunRecordSafe,
  type RunRecord,
  RunRecordValidationError,
  resolveRunCostProvenance,
  roundTripRunRecord,
  validateRunRecord,
} from '../src/run-record'

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const base: RunRecord = {
    runId: '11111111-2222-3333-4444-555555555555',
    experimentId: 'exp-routing-v0.15',
    candidateId: 'baseline',
    seed: 1,
    model: 'claude-sonnet-4-6@2025-04-15',
    promptHash: 'a'.repeat(64),
    configHash: 'b'.repeat(64),
    commitSha: 'cafebabe',
    wallMs: 1234,
    queueMs: 5,
    costUsd: 0.0123,
    tokenUsage: { input: 1000, output: 250, cached: 50 },
    judgeMetadata: {
      model: 'claude-sonnet-4-6@2025-04-15',
      promptVersion: 'v3',
      confidence: 0.82,
      fallback: false,
    },
    outcome: { searchScore: 0.7, holdoutScore: 0.65, raw: { f1: 0.65, exact: 0.6 } },
    splitTag: 'holdout',
  }
  return { ...base, ...overrides, outcome: overrides.outcome ?? base.outcome }
}

describe('validateRunRecord — happy path', () => {
  it('accepts a fully-populated record', () => {
    const r = makeRecord()
    expect(validateRunRecord(r)).toBe(r)
  })

  it('accepts records with only searchScore on the outcome', () => {
    const r = makeRecord({
      splitTag: 'search',
      outcome: { searchScore: 0.8, raw: { f1: 0.8 } },
    })
    expect(() => validateRunRecord(r)).not.toThrow()
  })

  it('round-trips through JSON without losing fields', () => {
    const r = makeRecord()
    const out = roundTripRunRecord(r)
    expect(out).toEqual(r)
  })

  it('accepts an agentProfile cell that matches model and promptHash', async () => {
    const agentProfile = await buildAgentProfileCell({
      profileId: 'gtm-founder-v1',
      sourceProfile: { kind: 'agent-interface-profile', profile: { name: 'gtm-agent' } },
      harness: { id: 'gtm-agent-eval', version: '0.3.0' },
      model: 'claude-sonnet-4-6@2025-04-15',
      promptHash: 'a'.repeat(64),
    })
    const r = makeRecord({ agentProfile })
    expect(validateRunRecord(r).agentProfile?.cellId).toBe(agentProfile.cellId)
    expect(roundTripRunRecord(r).agentProfile).toEqual(agentProfile)
  })

  it('isRunRecord returns true for a valid record', () => {
    expect(isRunRecord(makeRecord())).toBe(true)
  })

  it('parseRunRecordSafe returns ok=true on success', () => {
    const result = parseRunRecordSafe(makeRecord())
    expect(result.ok).toBe(true)
  })

  it('round-trips observed, estimated, and uncaptured cost provenance', () => {
    const observed = makeRecord({
      costUsd: 0,
      costProvenance: { kind: 'observed', usd: 0 },
    })
    const estimated = makeRecord({
      costUsd: 0.04,
      costProvenance: { kind: 'estimated', usd: 0.04 },
    })
    const uncaptured = makeRecord({
      costUsd: 0,
      costProvenance: { kind: 'uncaptured', usd: null },
    })

    expect(roundTripRunRecord(observed).costProvenance).toEqual({ kind: 'observed', usd: 0 })
    expect(roundTripRunRecord(estimated).costProvenance).toEqual({
      kind: 'estimated',
      usd: 0.04,
    })
    expect(roundTripRunRecord(uncaptured).costProvenance).toEqual({
      kind: 'uncaptured',
      usd: null,
    })
  })

  it('resolves conservative provenance for legacy cost records', () => {
    expect(resolveRunCostProvenance(makeRecord({ costUsd: 0.02 })).kind).toBe('observed')
    expect(
      resolveRunCostProvenance(
        makeRecord({ costUsd: 0.02, outcome: { holdoutScore: 1, raw: { cost_estimated: 1 } } }),
      ).kind,
    ).toBe('estimated')
    expect(resolveRunCostProvenance(makeRecord({ costUsd: 0 })).kind).toBe('uncaptured')
  })
})

describe('validateRunRecord — mandatory field enforcement', () => {
  const FIELDS_TO_DROP: Array<keyof RunRecord> = [
    'runId',
    'experimentId',
    'candidateId',
    'seed',
    'model',
    'promptHash',
    'configHash',
    'commitSha',
    'wallMs',
    'costUsd',
    'tokenUsage',
    'outcome',
    'splitTag',
  ]
  for (const field of FIELDS_TO_DROP) {
    it(`throws when "${String(field)}" is missing`, () => {
      const r = makeRecord() as Record<string, unknown>
      delete r[field as string]
      expect(() => validateRunRecord(r)).toThrow(RunRecordValidationError)
    })
  }

  it('throws when outcome has neither searchScore nor holdoutScore', () => {
    const r = makeRecord({ outcome: { raw: {} } })
    expect(() => validateRunRecord(r)).toThrow(/searchScore or holdoutScore/)
  })

  it('throws on bare model alias without snapshot', () => {
    expect(() => validateRunRecord(makeRecord({ model: 'claude-sonnet-4' }))).toThrow(/snapshot/i)
  })

  it('accepts OpenAI-style date suffix (gpt-4o-2024-11-20)', () => {
    expect(() => validateRunRecord(makeRecord({ model: 'gpt-4o-2024-11-20' }))).not.toThrow()
  })

  it('accepts compact YYYYMMDD suffix (claude-x-20250415)', () => {
    expect(() => validateRunRecord(makeRecord({ model: 'claude-x-20250415' }))).not.toThrow()
  })

  it('throws on non-numeric raw entry', () => {
    const r = makeRecord({
      outcome: {
        holdoutScore: 0.5,
        // string sneaks past TS but the validator catches it.
        raw: { broken: 'not a number' as unknown as number },
      },
    })
    expect(() => validateRunRecord(r)).toThrow(/finite number/)
  })

  it('throws on non-finite numeric (NaN, Infinity)', () => {
    expect(() => validateRunRecord(makeRecord({ wallMs: Number.NaN }))).toThrow(/finite/)
    expect(() => validateRunRecord(makeRecord({ wallMs: Number.POSITIVE_INFINITY }))).toThrow(
      /finite/,
    )
  })

  it('rejects negative duration, queue time, and cost', () => {
    expect(() => validateRunRecord(makeRecord({ wallMs: -1 }))).toThrow(/non-negative/)
    expect(() => validateRunRecord(makeRecord({ queueMs: -1 }))).toThrow(/non-negative/)
    expect(() => validateRunRecord(makeRecord({ costUsd: -0.01 }))).toThrow(/non-negative/)
  })

  it('rejects impossible token usage', () => {
    for (const tokenUsage of [
      { input: -1, output: 1 },
      { input: 1, output: -1 },
      { input: 1, output: 1, reasoning: -1 },
      { input: 1, output: 1, cached: -1 },
      { input: 1, output: 1, cacheWrite: -1 },
    ]) {
      expect(() => validateRunRecord(makeRecord({ tokenUsage }))).toThrow(/non-negative/)
    }
    expect(() =>
      validateRunRecord(makeRecord({ tokenUsage: { input: 1, output: 2, reasoning: 3 } })),
    ).toThrow(/subset of output/)
  })

  it('rejects unknown splitTag', () => {
    const r = makeRecord() as Record<string, unknown>
    r.splitTag = 'train'
    expect(() => validateRunRecord(r)).toThrow(/splitTag/)
  })

  it('rejects an unknown failureClass', () => {
    const r = makeRecord() as Record<string, unknown>
    r.failureClass = 'made_up_failure'
    expect(() => validateRunRecord(r)).toThrow(/failureClass must be one of/)
  })

  it('rejects empty string in mandatory fields', () => {
    expect(() => validateRunRecord(makeRecord({ runId: '' }))).toThrow()
    expect(() => validateRunRecord(makeRecord({ commitSha: '' }))).toThrow()
  })

  it('rejects judgeMetadata.fallback as a non-boolean', () => {
    const r = makeRecord({
      judgeMetadata: {
        model: 'claude-sonnet-4-6@2025-04-15',
        promptVersion: 'v1',
        confidence: 0.5,
        fallback: 'no' as unknown as boolean,
      },
    })
    expect(() => validateRunRecord(r)).toThrow(/fallback must be boolean/)
  })

  it('rejects cost provenance that contradicts costUsd', () => {
    expect(() =>
      validateRunRecord(
        makeRecord({ costUsd: 0, costProvenance: { kind: 'estimated', usd: 0.03 } }),
      ),
    ).toThrow(/must equal costUsd/)
    expect(() =>
      validateRunRecord(
        makeRecord({ costUsd: 0.03, costProvenance: { kind: 'uncaptured', usd: null } }),
      ),
    ).toThrow(/sentinel 0/)
    expect(() =>
      validateRunRecord(
        makeRecord({ costUsd: -0.03, costProvenance: { kind: 'observed', usd: -0.03 } }),
      ),
    ).toThrow(/non-negative/)
  })

  it('rejects an agentProfile cell that contradicts the executed model or prompt', async () => {
    const agentProfile = await buildAgentProfileCell({
      profileId: 'gtm-founder-v1',
      sourceProfile: { kind: 'agent-interface-profile', profile: { name: 'gtm-agent' } },
      harness: { id: 'gtm-agent-eval', version: '0.3.0' },
      model: 'claude-sonnet-4-6@2025-04-15',
      promptHash: 'a'.repeat(64),
    })
    expect(() =>
      validateRunRecord(makeRecord({ model: 'gpt-4o-2024-11-20', agentProfile })),
    ).toThrow(/does not match model/)
    expect(() =>
      validateRunRecord(makeRecord({ promptHash: 'b'.repeat(64), agentProfile })),
    ).toThrow(/does not match promptHash/)
  })

  it('parseRunRecordSafe returns ok=false on validation error', () => {
    const r = makeRecord({ runId: '' })
    const result = parseRunRecordSafe(r)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(RunRecordValidationError)
    }
  })

  it('isRunRecord returns false for malformed input', () => {
    expect(isRunRecord(null)).toBe(false)
    expect(isRunRecord(42)).toBe(false)
    expect(isRunRecord({})).toBe(false)
    expect(isRunRecord({ runId: 'x' })).toBe(false)
  })
})

describe('validateRunRecord — judgeScores', () => {
  const fullJudgeScores = {
    perJudge: {
      'kimi-k2.6@2026-04-01': { helpfulness: 0.8, clarity: 0.75 },
      'glm-5.1@2026-04-02': { helpfulness: 0.85, clarity: 0.7 },
    },
    perDimMean: { helpfulness: 0.825, clarity: 0.725 },
    composite: 0.775,
  }

  it('accepts a fully-populated judgeScores block', () => {
    const r = makeRecord({
      outcome: { holdoutScore: 0.775, raw: {}, judgeScores: fullJudgeScores },
    })
    expect(() => validateRunRecord(r)).not.toThrow()
  })

  it('round-trips judgeScores through JSON', () => {
    const r = makeRecord({
      outcome: { holdoutScore: 0.775, raw: {}, judgeScores: fullJudgeScores },
    })
    const out = roundTripRunRecord(r)
    expect(out.outcome.judgeScores).toEqual(fullJudgeScores)
  })

  it('accepts judgeScores with failedJudges and notes', () => {
    const r = makeRecord({
      outcome: {
        holdoutScore: 0.5,
        raw: {},
        judgeScores: {
          ...fullJudgeScores,
          failedJudges: ['dead-judge@2026-01-01'],
          notes: 'panel split on clarity',
        },
      },
    })
    expect(() => validateRunRecord(r)).not.toThrow()
  })

  it('throws on non-finite per-judge score (NaN as silent zero is the bug class we ban)', () => {
    const r = makeRecord({
      outcome: {
        holdoutScore: 0.5,
        raw: {},
        judgeScores: {
          perJudge: { 'k@2026-01-01': { helpfulness: Number.NaN } },
          perDimMean: { helpfulness: 0.5 },
          composite: 0.5,
        },
      },
    })
    expect(() => validateRunRecord(r)).toThrow(/finite/)
  })

  it('throws when composite is missing', () => {
    const r = makeRecord({
      outcome: {
        holdoutScore: 0.5,
        raw: {},
        judgeScores: {
          perJudge: { 'k@2026-01-01': { helpfulness: 0.5 } },
          perDimMean: { helpfulness: 0.5 },
        } as unknown as import('../src/run-record').JudgeScoresRecord,
      },
    })
    expect(() => validateRunRecord(r)).toThrow(/composite/)
  })

  it('throws when failedJudges contains a non-string', () => {
    const r = makeRecord({
      outcome: {
        holdoutScore: 0.5,
        raw: {},
        judgeScores: {
          ...fullJudgeScores,
          failedJudges: [42 as unknown as string],
        },
      },
    })
    expect(() => validateRunRecord(r)).toThrow(/failedJudges/)
  })
})
