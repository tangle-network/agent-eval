import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsLabeledScenarioStore } from '../labeled-store/fs-adapter'
import { inMemoryCampaignStorage } from '../storage'
import type { Gate, JudgeConfig, Scenario } from '../types'
import { runImprovementLoop } from './run-improvement-loop'

interface TestScenario extends Scenario {
  kind: 'test'
}

interface TestArtifact {
  surface: string
}

const quality: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'candidate quality' }],
  score: ({ artifact }) => {
    const composite =
      artifact.surface === 'CANDIDATE' ? 1 : artifact.surface === 'NEUTRALIZED' ? 0.5 : 0
    return {
      composite,
      dimensions: { quality: composite },
      notes: '',
    }
  },
}

describe('runImprovementLoop labeled-store isolation', () => {
  it('keeps every final arm out of the capture store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-eval-final-capture-'))
    const labeledStore = new FsLabeledScenarioStore({ root: join(root, 'labeled') })
    const searchScenario: TestScenario = { id: 'search-1', kind: 'test' }
    const finalScenario: TestScenario = { id: 'final-1', kind: 'test' }
    const finalSurfaces: string[] = []
    const gate: Gate<TestArtifact, TestScenario> = {
      name: 'hold',
      async decide() {
        return {
          decision: 'hold',
          reasons: ['test only'],
          contributingGates: [],
        }
      },
    }

    try {
      await runImprovementLoop({
        scenarios: [searchScenario],
        holdoutScenarios: [finalScenario],
        baselineSurface: 'BASELINE',
        dispatchWithSurface: async (surface, scenario) => {
          if (scenario.id === finalScenario.id) finalSurfaces.push(String(surface))
          return { surface: String(surface) }
        },
        judges: [quality],
        proposer: {
          kind: 'fixed-candidate',
          async propose() {
            return ['CANDIDATE']
          },
        },
        populationSize: 1,
        maxGenerations: 1,
        gate,
        neutralize: () => 'NEUTRALIZED',
        autoOnPromote: 'none',
        runDir: join(root, 'first-run'),
        storage: inMemoryCampaignStorage(),
        resumable: false,
        expectUsage: 'off',
        labeledStore,
        captureSource: 'eval-run',
        captureSourceVersionHash: 'capture-integrity-test',
      })

      expect(finalSurfaces.sort()).toEqual(['BASELINE', 'CANDIDATE', 'NEUTRALIZED'].sort())

      const recordsAfterFinal = await labeledStore.sample({
        count: 100,
        split: 'train',
        capturedBefore: '9999-12-31T23:59:59.999Z',
      })
      expect(recordsAfterFinal.map((record) => record.scenario.id).sort()).toEqual([
        searchScenario.id,
        searchScenario.id,
      ])
      expect(recordsAfterFinal.map((record) => record.scenario.id)).not.toContain(finalScenario.id)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
