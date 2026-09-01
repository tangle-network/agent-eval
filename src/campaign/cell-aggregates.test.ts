import { describe, expect, it } from 'vitest'
import type { CostLedgerSummary } from '../cost-ledger'
import { computeAggregates } from './cell-aggregates'
import type { CampaignCellResult, JudgeConfig } from './types'

const emptyCost: CostLedgerSummary = {
  totalCalls: 0,
  pendingCalls: 0,
  unresolvedCalls: 0,
  reservedCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalCostUsd: 0,
  costProvenance: { kind: 'observed', usd: 0 },
  byChannel: [],
  unpricedModels: [],
  fullyPriced: true,
  usageComplete: true,
  accountingComplete: true,
  incompleteReasons: [],
}

const judge: JudgeConfig<unknown> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'task quality' }],
  score: () => ({ composite: 0, dimensions: { quality: 0 }, notes: '' }),
}

/** One scored cell per supplied composite, all on the same scenario. */
function cells(scenarioId: string, composites: number[]): CampaignCellResult<unknown>[] {
  return composites.map((composite, rep) => ({
    cellId: `${scenarioId}:${rep}`,
    scenarioId,
    rep,
    artifact: {},
    judgeScores: {
      quality: { composite, dimensions: { quality: composite }, notes: '' },
    },
    costUsd: 0,
    costProvenance: { kind: 'observed', usd: 0 },
    tokenUsage: { input: 0, output: 0 },
    durationMs: 1,
    seed: 42,
    cached: false,
  }))
}

describe('computeAggregates distribution', () => {
  it('records the order statistics of the scores the mean was taken over', () => {
    const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
    const aggregates = computeAggregates(cells('s1', scores), [judge], 42, emptyCost)

    const byJudge = aggregates.byJudge.quality
    expect(byJudge).toBeDefined()
    // Nearest-rank quantiles: the ceil(q·n)-th order statistic, so every
    // reported quantile is a value the campaign actually measured.
    expect(byJudge?.distribution).toEqual({
      n: 10,
      min: 0.1,
      p50: 0.5,
      p90: 0.9,
      max: 1,
      sum: scores.reduce((a, b) => a + b, 0),
    })
    expect(byJudge?.distribution.n).toBe(byJudge?.n)
    expect(aggregates.byScenario.s1?.distribution).toEqual(byJudge?.distribution)
  })

  it('separates a bimodal cell from a tight cell that has the same mean', () => {
    const bimodal = computeAggregates(cells('bimodal', [0, 0, 0, 1, 1, 1]), [judge], 42, emptyCost)
    const tight = computeAggregates(
      cells('tight', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      [judge],
      42,
      emptyCost,
    )

    expect(bimodal.byJudge.quality?.mean).toBeCloseTo(0.5, 12)
    expect(tight.byJudge.quality?.mean).toBeCloseTo(0.5, 12)

    expect(bimodal.byJudge.quality?.distribution.min).toBe(0)
    expect(bimodal.byJudge.quality?.distribution.max).toBe(1)
    expect(tight.byJudge.quality?.distribution.min).toBe(0.5)
    expect(tight.byJudge.quality?.distribution.max).toBe(0.5)
    expect(bimodal.byJudge.quality?.distribution).not.toEqual(tight.byJudge.quality?.distribution)
    expect(bimodal.byScenario.bimodal?.distribution).not.toEqual(
      tight.byScenario.tight?.distribution,
    )
  })

  it('shows the outlier that carried the mean', () => {
    const aggregates = computeAggregates(
      cells('outlier', [0, 0, 0, 0, 0, 0, 0, 0, 0, 5]),
      [judge],
      42,
      emptyCost,
    )

    expect(aggregates.byJudge.quality?.mean).toBeCloseTo(0.5, 12)
    expect(aggregates.byJudge.quality?.distribution.p50).toBe(0)
    expect(aggregates.byJudge.quality?.distribution.p90).toBe(0)
    expect(aggregates.byJudge.quality?.distribution.max).toBe(5)
  })

  it('keeps a per-scenario distribution for every scenario in the campaign', () => {
    const aggregates = computeAggregates(
      [...cells('low', [0, 0.2]), ...cells('high', [0.8, 1])],
      [judge],
      42,
      emptyCost,
    )

    expect(aggregates.byScenario.low?.distribution.max).toBe(0.2)
    expect(aggregates.byScenario.high?.distribution.min).toBe(0.8)
    // The judge aggregate spans both scenarios.
    expect(aggregates.byJudge.quality?.distribution.n).toBe(4)
    expect(aggregates.byJudge.quality?.distribution.min).toBe(0)
    expect(aggregates.byJudge.quality?.distribution.max).toBe(1)
  })

  it('records no aggregate at all for a judge that produced no score', () => {
    const failed = cells('s1', [0.5]).map((cell) => ({
      ...cell,
      errorStage: 'dispatch' as const,
      error: 'dispatch failed',
    }))
    const aggregates = computeAggregates(failed, [judge], 42, emptyCost)

    // An absent aggregate is the honest record of an unmeasured judge; a
    // zero-filled distribution would read as a measured all-zero series.
    expect(aggregates.byJudge.quality).toBeUndefined()
    expect(aggregates.byScenario.s1).toBeUndefined()
    expect(aggregates.cellsDispatchFailed).toBe(1)
  })

  it('summarizes a single score without inventing spread', () => {
    const aggregates = computeAggregates(cells('s1', [0.75]), [judge], 42, emptyCost)

    expect(aggregates.byJudge.quality?.distribution).toEqual({
      n: 1,
      min: 0.75,
      p50: 0.75,
      p90: 0.75,
      max: 0.75,
      sum: 0.75,
    })
  })
})
