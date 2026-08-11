import { describe, expect, it } from 'vitest'
import { campaignCellCostProvenance, campaignCellToRunRecord } from '../../src/campaign/run-record'
import type { CampaignCellResult } from '../../src/campaign/types'

function cell(
  overrides: Partial<CampaignCellResult<{ ok: true }>> = {},
): CampaignCellResult<{ ok: true }> {
  return {
    cellId: 'scenario:0',
    scenarioId: 'scenario',
    rep: 0,
    artifact: { ok: true },
    judgeScores: {},
    costUsd: 0,
    costProvenance: { kind: 'observed', usd: 0 },
    tokenUsage: { input: 1, output: 1 },
    durationMs: 10,
    seed: 1,
    cached: false,
    ...overrides,
  }
}

describe('campaign cost provenance', () => {
  it('marks an incomplete token subtotal and omits a misleading efficiency ratio', () => {
    const record = campaignCellToRunRecord(
      cell({
        costUsd: 2,
        costProvenance: { kind: 'observed', usd: 2 },
        tokenUsage: { input: 7, output: 3, tokensKnown: false },
      }),
      {
        runId: 'run',
        experimentId: 'experiment',
        candidateId: 'candidate',
        model: 'test-model@2026-08-03',
        promptHash: 'prompt',
        configHash: 'config',
        commitSha: 'a'.repeat(40),
        splitTag: 'search',
      },
    )

    expect(record.tokenUsage).toEqual({ input: 7, output: 3, tokensKnown: false })
    expect(record.outcome.raw.tokens_known).toBe(0)
    expect(record.outcome.raw.tokens_per_dollar).toBeUndefined()
  })

  it('retains an observed subtotal beside a caller-supplied estimated total', () => {
    const record = campaignCellToRunRecord(
      cell({
        costUsd: 2,
        costProvenance: { kind: 'uncaptured', usd: null },
      }),
      {
        runId: 'run',
        experimentId: 'experiment',
        candidateId: 'candidate',
        model: 'test-model@2026-08-03',
        promptHash: 'prompt',
        configHash: 'config',
        commitSha: 'a'.repeat(40),
        splitTag: 'search',
        defaultCostUsd: 5,
      },
    )

    expect(record.costUsd).toBe(5)
    expect(record.costProvenance).toEqual({ kind: 'estimated', usd: 5 })
    expect(record.outcome.raw).toMatchObject({
      cost_usd: 5,
      cost_known_subtotal_usd: 2,
      cost_observed: 0,
      cost_estimated: 1,
      cost_uncaptured: 0,
    })
  })

  it.each([
    {
      name: 'a non-finite known subtotal',
      value: cell({ costUsd: Number.POSITIVE_INFINITY }),
      message: 'invalid costUsd',
    },
    {
      name: 'missing provenance',
      value: { ...cell(), costProvenance: undefined },
      message: 'has no costProvenance',
    },
    {
      name: 'a non-null uncaptured total',
      value: cell({
        costProvenance: { kind: 'uncaptured', usd: 1 } as never,
      }),
      message: 'invalid uncaptured costProvenance',
    },
    {
      name: 'an unknown provenance kind',
      value: cell({ costProvenance: { kind: 'guessed', usd: 1 } as never }),
      message: 'invalid costProvenance',
    },
    {
      name: 'a provenance total inconsistent with the cell subtotal',
      value: cell({ costUsd: 2, costProvenance: { kind: 'observed', usd: 1 } }),
      message: 'costUsd inconsistent with costProvenance',
    },
  ])('rejects $name', ({ value, message }) => {
    expect(() => campaignCellCostProvenance(value as never)).toThrow(message)
  })
})
