import { describe, expect, it } from 'vitest'
import { inMemoryCampaignStorage } from '../campaign/storage'
import type { JudgeConfig, Scenario } from '../campaign/types'
import type { EvaluationClaim } from '../experiment/claim'
import { selfImprove } from './self-improve'

interface FixedCase extends Scenario {
  sourceId: string
}

const scenarios: FixedCase[] = ['train', 'selection', 'final-a', 'final-b'].map((id) => ({
  id,
  kind: 'fixture',
  sourceId: 'one-fixed-source',
}))
const claim: EvaluationClaim = {
  use: 'development',
  population: { id: 'fixed', description: 'These fixed regression cases' },
  samplingFrame: 'Fixed regression roster',
  independentUnit: 'sourceId',
  generalization: 'fixed-roster',
}
const judge: JudgeConfig<{ quality: number }, FixedCase> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'Observed fixture quality' }],
  score: ({ artifact }) => ({
    composite: artifact.quality,
    dimensions: { quality: artifact.quality },
    notes: '',
  }),
}

describe('fixed-roster development splits', () => {
  it.each(['explicit', 'automatic'] as const)(
    'keeps one-source development usable with %s partitions',
    async (partition) => {
      let optimized = 0
      const result = await selfImprove({
        scenarios,
        claim,
        judge,
        baselineSurface: 'BASE',
        ...(partition === 'explicit'
          ? {
              selectionScenarios: [scenarios[1]!],
              budget: { holdoutScenarios: scenarios.slice(2) },
            }
          : {}),
        agent: async (surface) => ({ quality: surface === 'BASE' ? 0 : 1 }),
        method: {
          name: 'fixed',
          optimize: async (input) => {
            optimized += 1
            expect(input.trainScenarios.length).toBeGreaterThan(0)
            expect(input.selectionScenarios.length).toBeGreaterThan(0)
            const trainIds = new Set(input.trainScenarios.map((scenario) => scenario.id))
            expect(input.selectionScenarios.every((scenario) => !trainIds.has(scenario.id))).toBe(
              true,
            )
            return {
              winnerSurface: 'SELECTED',
              cost: {
                totalCostUsd: 0,
                costProvenance: { kind: 'observed', usd: 0 },
                accountingComplete: true,
                incompleteReasons: [],
              },
            }
          },
        },
        model: 'fixture@2026-09-13',
        expectUsage: 'off',
        storage: inMemoryCampaignStorage(),
        runDir: `mem://fixed-roster-${partition}`,
      })

      expect(optimized).toBe(1)
      expect(result.winner.surface).toBe('SELECTED')
      expect(result.lift).toBe(1)
      expect(result.gateDecision).toBe('hold')
      expect(result.finalEvidence).toBeUndefined()
      expect(
        result.raw.gateResult.contributingGates.find(
          (check) => check.name === 'heldout-significance',
        )?.detail,
      ).toMatchObject({ n: 1, observationUnit: 'registered', fewRuns: true })
    },
  )
})
