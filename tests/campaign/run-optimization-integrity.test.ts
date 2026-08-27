import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type JudgeConfig,
  type ProposeContext,
  runOptimization,
  type Scenario,
  surfaceHash,
} from '../../src/campaign/index'

interface TestScenario extends Scenario {
  id: string
  kind: 'integrity'
}

interface TestArtifact {
  text: string
}

const scenarios: TestScenario[] = [
  { id: 'a', kind: 'integrity' },
  { id: 'b', kind: 'integrity' },
]

function scoreJudge(
  score: (surface: string, scenarioId: string) => number,
): JudgeConfig<TestArtifact, TestScenario> {
  return {
    name: 'score',
    dimensions: [{ key: 'quality', description: 'quality' }],
    score: ({ artifact, scenario }) => {
      const value = score(artifact.text, scenario.id)
      return { composite: value, dimensions: { quality: value }, notes: '' }
    },
  }
}

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'optimization-integrity-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

describe('runOptimization selection integrity', () => {
  it('fails before spending when legacy promoteTopK requests multiple incumbents', async () => {
    let dispatchCalls = 0
    await expect(
      runOptimization<TestScenario, TestArtifact>({
        scenarios,
        baselineSurface: 'BASE',
        dispatchWithSurface: async (surface) => {
          dispatchCalls += 1
          return { text: String(surface) }
        },
        judges: [scoreJudge(() => 0.5)],
        proposer: { kind: 'unused', propose: async () => ['CANDIDATE'] },
        populationSize: 1,
        maxGenerations: 1,
        promoteTopK: 2,
        expectUsage: 'off',
        runDir,
      }),
    ).rejects.toThrow(/promoteTopK must be 1/)
    expect(dispatchCalls).toBe(0)
  })

  it('attributes every measured delta to the complete incumbent it mutated', async () => {
    const seen: Array<{
      baseline: number | undefined
      baselineSplit: 'search' | undefined
      incumbent: number | undefined
      incumbentSplit: 'search' | undefined
    }> = []
    const result = await runOptimization<TestScenario, TestArtifact>({
      scenarios,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [
        scoreJudge((surface) => {
          if (surface === 'WINNER') return 0.8
          if (surface === 'LOSER') return 0.2
          return 0.4
        }),
      ],
      proposer: {
        kind: 'credit-assignment-probe',
        async propose(ctx: ProposeContext) {
          seen.push({
            baseline: ctx.baselineOutcome?.composite,
            baselineSplit: ctx.baselineOutcome?.split,
            incumbent: ctx.incumbentOutcome?.composite,
            incumbentSplit: ctx.incumbentOutcome?.split,
          })
          return [ctx.generation === 0 ? 'WINNER' : 'LOSER']
        },
      },
      populationSize: 1,
      maxGenerations: 2,
      promoteTopK: 1,
      expectUsage: 'off',
      runDir,
    })

    expect(seen).toEqual([
      {
        baseline: 0.4,
        baselineSplit: 'search',
        incumbent: 0.4,
        incumbentSplit: 'search',
      },
      {
        baseline: 0.4,
        baselineSplit: 'search',
        incumbent: 0.8,
        incumbentSplit: 'search',
      },
    ])
    expect(result.generations[0]!.record.candidates[0]).toMatchObject({
      parentSurfaceHash: surfaceHash('BASE'),
      observedDeltaFromParent: 0.4,
    })
    expect(result.generations[1]!.record.candidates[0]).toMatchObject({
      parentSurfaceHash: surfaceHash('WINNER'),
    })
    expect(result.generations[1]!.record.candidates[0]!.observedDeltaFromParent).toBeCloseTo(-0.6)
    expect(result.winnerSurface).toBe('WINNER')
  })

  it('keeps the global incumbent as currentSurface after a complete candidate regresses', async () => {
    const seen: string[] = []
    const result = await runOptimization<TestScenario, TestArtifact>({
      scenarios,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [scoreJudge((surface) => (surface === 'BASE' ? 0.9 : 0.1))],
      proposer: {
        kind: 'regression-probe',
        async propose(ctx: ProposeContext) {
          seen.push(String(ctx.currentSurface))
          return ctx.generation === 0 ? ['LOSER'] : []
        },
      },
      populationSize: 1,
      maxGenerations: 2,
      promoteTopK: 1,
      expectUsage: 'off',
      runDir,
    })

    expect(seen).toEqual(['BASE', 'BASE'])
    expect(result.generations).toHaveLength(1)
    expect(result.generations[0]!.record.promoted).toEqual([])
    expect(result.winnerSurface).toBe('BASE')
    expect(result.winnerSurfaceHash).toBe(surfaceHash('BASE'))
  })

  it('retains an incomplete candidate but excludes it from promotion, winner, and Pareto', async () => {
    const judge: JudgeConfig<TestArtifact, TestScenario> = {
      name: 'partial',
      dimensions: [{ key: 'quality', description: 'quality' }],
      score: ({ artifact, scenario }) => {
        if (artifact.text === 'PARTIAL' && scenario.id === 'b') throw new Error('missing b')
        const value = artifact.text === 'PARTIAL' ? 0.9 : 0.5
        return { composite: value, dimensions: { quality: value }, notes: '' }
      },
    }
    const result = await runOptimization<TestScenario, TestArtifact>({
      scenarios,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      proposer: { kind: 'partial', propose: async () => ['PARTIAL'] },
      populationSize: 1,
      maxGenerations: 1,
      promoteTopK: 1,
      expectUsage: 'off',
      runDir,
    })

    const generation = result.generations[0]!
    const candidate = generation.record.candidates[0]!
    expect(candidate.composite).toBe(0.9)
    expect(candidate.eligibleForPromotion).toBe(false)
    expect(candidate.coverage).toEqual({
      expectedCells: 2,
      scorableCells: 1,
      unscorableCells: [{ cellId: 'b:0', reason: "judge 'partial' failed: missing b" }],
    })
    expect(generation.record.promoted).toEqual([])
    expect(generation.surfaces[0]!.campaign.aggregates.cellsFailed).toBe(1)
    expect(result.winnerSurface).toBe('BASE')
    expect(result.paretoFrontier.map((parent) => parent.surface)).toEqual(['BASE'])
  })

  it('aborts before proposal when the baseline lacks a designed scorable cell', async () => {
    let proposeCalls = 0
    const judge: JudgeConfig<TestArtifact, TestScenario> = {
      name: 'baseline-failure',
      dimensions: [{ key: 'quality', description: 'quality' }],
      score: ({ scenario }) => {
        if (scenario.id === 'b') throw new Error('baseline b unavailable')
        return { composite: 0.5, dimensions: { quality: 0.5 }, notes: '' }
      },
    }

    await expect(
      runOptimization<TestScenario, TestArtifact>({
        scenarios,
        baselineSurface: 'BASE',
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        proposer: {
          kind: 'must-not-run',
          async propose() {
            proposeCalls += 1
            return ['CANDIDATE']
          },
        },
        populationSize: 1,
        maxGenerations: 1,
        expectUsage: 'off',
        runDir,
      }),
    ).rejects.toThrow(/baseline is incomplete \(1\/2 designed cells scorable\).*b:0/)
    expect(proposeCalls).toBe(0)
  })

  it('rejects mixed finite and non-finite judge results before proposal', async () => {
    let proposeCalls = 0
    const invalid: JudgeConfig<TestArtifact, TestScenario> = {
      name: 'invalid',
      dimensions: [{ key: 'quality', description: 'quality' }],
      score: () => ({ composite: Number.NaN, dimensions: { quality: Number.NaN }, notes: '' }),
    }

    await expect(
      runOptimization<TestScenario, TestArtifact>({
        scenarios,
        baselineSurface: 'BASE',
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [scoreJudge(() => 0.5), invalid],
        proposer: {
          kind: 'must-not-run',
          async propose() {
            proposeCalls += 1
            return ['CANDIDATE']
          },
        },
        populationSize: 1,
        maxGenerations: 1,
        expectUsage: 'off',
        runDir,
      }),
    ).rejects.toThrow(/baseline is incomplete.*non-finite judge score: invalid/)
    expect(proposeCalls).toBe(0)
  })

  it('does not retain an earlier judge reward when a later judge fails the cell', async () => {
    const first: JudgeConfig<TestArtifact, TestScenario> = {
      name: 'first',
      dimensions: [{ key: 'quality', description: 'quality' }],
      score: ({ artifact }) => {
        const value = artifact.text === 'PARTIAL' ? 0.99 : 0.5
        return { composite: value, dimensions: { quality: value }, notes: '' }
      },
    }
    const second: JudgeConfig<TestArtifact, TestScenario> = {
      name: 'second',
      dimensions: [{ key: 'safety', description: 'safety' }],
      score: ({ artifact, scenario }) => {
        if (artifact.text === 'PARTIAL' && scenario.id === 'b') {
          throw new Error('second judge unavailable')
        }
        return { composite: 0.5, dimensions: { safety: 0.5 }, notes: '' }
      },
    }
    const result = await runOptimization<TestScenario, TestArtifact>({
      scenarios,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [first, second],
      proposer: { kind: 'partial', propose: async () => ['PARTIAL'] },
      populationSize: 1,
      maxGenerations: 1,
      promoteTopK: 1,
      expectUsage: 'off',
      runDir,
    })

    const generation = result.generations[0]!
    const failedCell = generation.surfaces[0]!.campaign.cells.find((cell) => cell.cellId === 'b:0')!
    expect(failedCell.judgeScores.first?.composite).toBe(0.99)
    expect(failedCell.error).toContain('second judge unavailable')
    expect(generation.record.candidates[0]!.eligibleForPromotion).toBe(false)
    expect(generation.record.promoted).toEqual([])
    expect(result.winnerSurface).toBe('BASE')
  })

  it('retains the incumbent when every candidate in consecutive generations is incomplete', async () => {
    const seen: string[] = []
    const judge: JudgeConfig<TestArtifact, TestScenario> = {
      name: 'partial',
      dimensions: [{ key: 'quality', description: 'quality' }],
      score: ({ artifact, scenario }) => {
        if (artifact.text.startsWith('PARTIAL') && scenario.id === 'b') {
          throw new Error('missing b')
        }
        return { composite: 0.5, dimensions: { quality: 0.5 }, notes: '' }
      },
    }
    const result = await runOptimization<TestScenario, TestArtifact>({
      scenarios,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      proposer: {
        kind: 'all-incomplete',
        async propose(ctx: ProposeContext) {
          seen.push(String(ctx.currentSurface))
          return [`PARTIAL-${ctx.generation}`]
        },
      },
      populationSize: 1,
      maxGenerations: 2,
      promoteTopK: 1,
      expectUsage: 'off',
      runDir,
    })

    expect(seen).toEqual(['BASE', 'BASE'])
    expect(result.generations.map((generation) => generation.record.promoted)).toEqual([[], []])
    expect(result.winnerSurface).toBe('BASE')
    expect(result.paretoFrontier.map((parent) => parent.surface)).toEqual(['BASE'])
  })
})
