import { describe, expect, it } from 'vitest'
import { AxGepaSteeringOptimizer, PairwiseSteeringOptimizer } from '../src/steering-optimizer'
import type { SteeringOptimizationRow } from '../src/steering-optimizer'

describe('steering optimizer', () => {
  it('ranks variants by aggregate score', () => {
    const result = new PairwiseSteeringOptimizer().optimize(rows())
    expect(result.recommendedVariantId).toBe('strong')
    expect(result.rankings[0]?.variantId).toBe('strong')
  })

  it('fails closed to skipped ax mode when data is insufficient', async () => {
    const result = await new AxGepaSteeringOptimizer({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5.4-mini',
      minRows: 10,
    }).optimize(rows())
    expect(result.backend).toBe('ax-gepa')
    expect(result.skipped).toBe(true)
    expect(result.recommendedVariantId).toBe('strong')
  })
})

function rows(): SteeringOptimizationRow[] {
  return [
    row('weak', 's1', 2),
    row('strong', 's1', 8),
    row('weak', 's2', 3),
    row('strong', 's2', 9),
  ]
}

function row(variantId: string, scenarioId: string, rank: number): SteeringOptimizationRow {
  return {
    variantId,
    scenarioId,
    bundle: { id: variantId, coderPrompt: variantId },
    metadata: { seed_preview: `task ${scenarioId}`, split: 'train' },
    score: {
      success: rank / 10,
      goalProgress: rank / 10,
      repoGroundedness: 0.9,
      driftPenalty: 0.1,
      toolUseQuality: 0.9,
      patchQuality: 0.9,
      testReality: 0.9,
      costUsd: 0.1,
      wallSeconds: 1,
    },
  }
}
