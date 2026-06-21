import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defineAgentEval,
  type JudgeConfig,
  type Scenario,
  type SurfaceProposer,
} from '../src/contract'

interface CopyScenario extends Scenario {
  brief: string
}

interface CopyArtifact {
  surface: string
  text: string
  score: number
}

const scenarios: CopyScenario[] = [
  { id: 's1', kind: 'copy', brief: 'landing headline' },
  { id: 's2', kind: 'copy', brief: 'email subject' },
  { id: 's3', kind: 'copy', brief: 'tweet' },
  { id: 's4', kind: 'copy', brief: 'empty state' },
]

const agent = async (surface: unknown, scenario: CopyScenario): Promise<CopyArtifact> => {
  const textSurface = String(surface)
  return {
    surface: textSurface,
    text: `${textSurface}: ${scenario.brief}`,
    score: textSurface.includes('better') ? 0.9 : 0.3,
  }
}

const judge: JudgeConfig<CopyArtifact, CopyScenario> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'synthetic quality score' }],
  score: ({ artifact }) => ({
    dimensions: { quality: artifact.score },
    composite: artifact.score,
    notes: '',
  }),
}

const proposer: SurfaceProposer = {
  kind: 'test-proposer',
  propose: async ({ currentSurface }) => [
    {
      surface: `${String(currentSurface)} better`,
      label: 'better',
      rationale: 'synthetic surface improves the deterministic score',
    },
  ],
}

describe('defineAgentEval', () => {
  it('evaluates the default baseline surface without requiring runEval wiring', async () => {
    const evalKit = defineAgentEval({
      scenarios,
      agent,
      judge,
      baselineSurface: 'base',
      expectUsage: 'off',
    })

    const result = await evalKit.evaluate()

    expect(result.cells).toHaveLength(scenarios.length)
    expect(result.cells.map((cell) => cell.artifact.surface)).toEqual([
      'base',
      'base',
      'base',
      'base',
    ])
    expect(result.aggregates.byJudge.quality?.mean).toBeCloseTo(0.3)
  })

  it('keeps default evaluate runs in memory instead of writing mem directories', async () => {
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), 'define-agent-eval-'))

    try {
      process.chdir(dir)
      const evalKit = defineAgentEval({
        scenarios,
        agent,
        judge,
        baselineSurface: 'base',
        expectUsage: 'off',
      })

      await evalKit.evaluate()

      expect(existsSync(join(dir, 'mem:'))).toBe(false)
    } finally {
      process.chdir(previousCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lets evaluate callers override the candidate surface and judges', async () => {
    const strictJudge: JudgeConfig<CopyArtifact, CopyScenario> = {
      name: 'strict',
      dimensions: [{ key: 'strict', description: 'requires the better surface' }],
      score: ({ artifact }) => ({
        dimensions: { strict: artifact.surface.includes('better') ? 1 : 0 },
        composite: artifact.surface.includes('better') ? 1 : 0,
        notes: '',
      }),
    }
    const evalKit = defineAgentEval({
      scenarios,
      agent,
      judge,
      baselineSurface: 'base',
      expectUsage: 'off',
    })

    const result = await evalKit.evaluate({
      surface: 'candidate better',
      judges: [strictJudge],
    })

    expect(result.cells.every((cell) => cell.artifact.surface === 'candidate better')).toBe(true)
    expect(result.aggregates.byJudge.strict?.mean).toBe(1)
    expect(result.aggregates.byJudge.quality).toBeUndefined()
  })

  it('runs selfImprove and merges budget overrides without dropping default knobs', async () => {
    const evalKit = defineAgentEval({
      scenarios,
      agent,
      judge,
      baselineSurface: 'base',
      proposer,
      budget: { generations: 1, populationSize: 2, holdoutFraction: 0.5 },
      expectUsage: 'off',
    })

    const result = await evalKit.improve({
      budget: { populationSize: 1 },
    })

    expect(result.generationsExplored).toBe(1)
    expect(result.winner.surface).toBe('base better')
    expect(result.lift).toBeGreaterThan(0)
  })
})
