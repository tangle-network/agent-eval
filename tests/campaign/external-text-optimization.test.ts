import { describe, expect, it } from 'vitest'
import {
  createExternalTextEvaluator,
  describeExternalScenario,
} from '../../src/campaign/external-text-optimization'
import type { OptimizationMethodInput } from '../../src/campaign/presets/compare-optimization-methods'
import { createRunCostLedger, inMemoryCampaignStorage } from '../../src/campaign/storage'
import type { Scenario } from '../../src/campaign/types'

interface TestScenario extends Scenario {
  prompt: string
}

describe('external text optimization', () => {
  it('rejects oversized serialized scenario context', () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    expect(() =>
      describeExternalScenario(scenario, 'test optimizer', 10, () => ({
        prompt: 'x'.repeat(100),
      })),
    ).toThrow("test optimizer scenario 'train' exceeds maxEvidenceChars")
  })

  it('rejects oversized serialized evaluation evidence', async () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({ storage, runDir: 'run/cost' })
    const input: OptimizationMethodInput<TestScenario, { text: string }> = {
      baselineSurface: 'baseline',
      trainScenarios: [scenario],
      selectionScenarios: [],
      dispatchWithSurface: async () => ({ text: 'x'.repeat(1_000) }),
      judges: [
        {
          name: 'quality',
          dimensions: [{ key: 'quality', description: 'quality' }],
          score: () => ({ dimensions: { quality: 1 }, composite: 1 }),
        },
      ],
      runDir: 'run',
      seed: 42,
      runOptions: { storage, expectUsage: 'off' },
      costLedger,
    }
    const evaluate = createExternalTextEvaluator({
      input,
      label: 'test optimizer',
      runDir: 'run',
      costPhase: 'test',
      costLedger,
      scenarioById: new Map([[scenario.id, scenario]]),
      maxCandidateChars: 10_000,
      maxEvidenceChars: 200,
      describeArtifact: (artifact) => artifact,
    })

    await expect(evaluate({ candidate: 'candidate', exampleId: scenario.id })).rejects.toThrow(
      "test optimizer evaluation evidence for 'train' exceeds maxEvidenceChars",
    )
  })
})
