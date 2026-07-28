import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inMemoryCampaignStorage } from '../storage'
import type { Gate, JudgeConfig, Scenario, SurfaceProposer } from '../types'
import { runImprovementLoop } from './run-improvement-loop'

interface TestScenario extends Scenario {
  kind: 'test'
  phase: 'search' | 'final'
  privateText: string
}

const SEARCH_OUTPUT = 'SEARCH_TRACE_TEXT'
const SEARCH_NOTE = 'SEARCH_JUDGE_NOTE'
const SEARCH_ERROR = 'SEARCH_ERROR_TEXT'
const FINAL_SCENARIO = 'FINAL_SCENARIO_TEXT'
const FINAL_OUTPUT = 'FINAL_ARTIFACT_TEXT'
const FINAL_NOTE = 'FINAL_JUDGE_NOTE'

describe('runImprovementLoop proposal isolation', () => {
  it('shows search failures to later proposals but never exposes final-case data', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'proposal-isolation-'))
    const proposalContexts: string[] = []
    const proposer: SurfaceProposer = {
      kind: 'context-inspector',
      async propose(context) {
        proposalContexts.push(JSON.stringify(context))
        return context.generation === 0 ? ['CANDIDATE'] : []
      },
    }
    const judge: JudgeConfig<string, TestScenario> = {
      name: 'quality',
      dimensions: [{ key: 'quality', description: 'candidate quality' }],
      score: ({ artifact, scenario }) => {
        const composite = artifact === SEARCH_OUTPUT ? 0.8 : 0.5
        return {
          composite,
          dimensions: { quality: composite },
          notes:
            scenario.phase === 'final' ? FINAL_NOTE : artifact === SEARCH_OUTPUT ? SEARCH_NOTE : '',
        }
      },
    }
    const releaseDecision: Gate<string, TestScenario> = {
      name: 'not-reached-for-baseline-winner',
      async decide() {
        throw new Error('release decision should not run')
      },
    }

    try {
      await runImprovementLoop({
        scenarios: [
          { id: 'search-success', kind: 'test', phase: 'search', privateText: 'search data' },
          { id: 'search-failure', kind: 'test', phase: 'search', privateText: 'search data' },
        ],
        holdoutScenarios: [
          { id: 'final-case', kind: 'test', phase: 'final', privateText: FINAL_SCENARIO },
        ],
        baselineSurface: 'BASELINE',
        dispatchWithSurface: async (surface, scenario) => {
          if (
            surface === 'CANDIDATE' &&
            scenario.phase === 'search' &&
            scenario.id === 'search-failure'
          ) {
            throw new Error(SEARCH_ERROR)
          }
          if (scenario.phase === 'final') return FINAL_OUTPUT
          return surface === 'CANDIDATE' ? SEARCH_OUTPUT : String(surface)
        },
        judges: [judge],
        proposer,
        populationSize: 1,
        maxGenerations: 2,
        gate: releaseDecision,
        autoOnPromote: 'none',
        runDir,
        storage: inMemoryCampaignStorage(),
        resumable: false,
        expectUsage: 'off',
      })

      expect(proposalContexts).toHaveLength(2)
      expect(proposalContexts[1]).toContain(SEARCH_OUTPUT)
      expect(proposalContexts[1]).toContain(SEARCH_NOTE)
      expect(proposalContexts[1]).toContain(SEARCH_ERROR)
      for (const context of proposalContexts) {
        expect(context).not.toContain(FINAL_SCENARIO)
        expect(context).not.toContain(FINAL_OUTPUT)
        expect(context).not.toContain(FINAL_NOTE)
      }
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
