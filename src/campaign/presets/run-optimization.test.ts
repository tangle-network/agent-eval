import { describe, expect, it } from 'vitest'
import { runCampaign } from '../run-campaign'
import { type CampaignStorage, inMemoryCampaignStorage } from '../storage'
import { surfaceHash } from '../surface-identity'
import type {
  CampaignResult,
  JudgeConfig,
  MutableSurface,
  Scenario,
  SurfaceProposer,
} from '../types'
import { runOptimization } from './run-optimization'

interface TestScenario extends Scenario {
  kind: 'test'
  prompt: string
}

interface TestArtifact {
  surface: string
}

const scenarios: TestScenario[] = [{ id: 'task', kind: 'test', prompt: 'original' }]

const qualityJudge: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'candidate quality' }],
  score: ({ artifact }) => {
    const composite = artifact.surface === 'CANDIDATE' ? 1 : 0
    return { composite, dimensions: { quality: composite }, notes: '' }
  },
}

async function measureBaseline(
  measuredScenarios: TestScenario[] = scenarios,
): Promise<CampaignResult<TestArtifact, TestScenario>> {
  return runCampaign({
    scenarios: measuredScenarios,
    dispatch: async (_scenario, ctx) => {
      await ctx.artifacts.write('baseline.txt', 'exact baseline artifact')
      return { surface: 'BASELINE' }
    },
    dispatchRef: 'test:premeasured-baseline',
    judges: [qualityJudge],
    seed: 7,
    reps: 1,
    resumable: false,
    runDir: '/premeasured/source',
    storage: inMemoryCampaignStorage(),
    tracing: 'off',
    expectUsage: 'off',
  })
}

function proposer(onPropose?: () => void): SurfaceProposer {
  return {
    kind: 'fixed-candidate',
    async propose() {
      onPropose?.()
      return ['CANDIDATE']
    },
  }
}

function trackingStorage(): { storage: CampaignStorage; accesses: string[] } {
  const inner = inMemoryCampaignStorage()
  const accesses: string[] = []
  return {
    accesses,
    storage: {
      ensureDir(path) {
        accesses.push(path)
        inner.ensureDir(path)
      },
      exists(path) {
        accesses.push(path)
        return inner.exists(path)
      },
      read(path) {
        accesses.push(path)
        return inner.read(path)
      },
      write(path, content) {
        accesses.push(path)
        inner.write(path, content)
      },
      append(path, content, expectedBytes) {
        accesses.push(path)
        return inner.append!(path, content, expectedBytes)
      },
    },
  }
}

describe('runOptimization premeasured baseline', () => {
  it('skips baseline dispatch and cache while preserving the exact campaign', async () => {
    const baseline = await measureBaseline()
    const dispatches: MutableSurface[] = []
    const { storage, accesses } = trackingStorage()
    let analyzedRunDir: string | undefined
    let analyzedCampaign: CampaignResult<TestArtifact, TestScenario> | undefined

    const result = await runOptimization({
      baselineSurface: 'BASELINE',
      premeasuredBaseline: {
        surfaceHash: surfaceHash('BASELINE'),
        campaign: baseline,
      },
      scenarios,
      dispatchWithSurface: async (surface) => {
        dispatches.push(surface)
        return { surface: String(surface) }
      },
      dispatchRef: 'test:continuation',
      judges: [qualityJudge],
      proposer: proposer(),
      populationSize: 1,
      maxGenerations: 1,
      analyzeGeneration: async (input) => {
        analyzedRunDir = input.runDir
        analyzedCampaign = input.candidates[0]?.campaign
        return []
      },
      seed: 7,
      reps: 1,
      runDir: '/continuation',
      storage,
      tracing: 'off',
      expectUsage: 'off',
    })

    expect(dispatches).toEqual(['CANDIDATE'])
    expect(result.winnerSurface).toBe('CANDIDATE')
    expect(result.baselineCampaign).toBe(baseline)
    expect(result.baselineCampaign.artifactsByPath).toBe(baseline.artifactsByPath)
    expect(analyzedRunDir).toBe(baseline.runDir)
    expect(analyzedCampaign).toBe(baseline)
    expect(Object.keys(result.baselineCampaign.artifactsByPath)).toEqual(['task:0/baseline.txt'])
    expect(accesses.filter((path) => path.startsWith('/continuation/baseline'))).toEqual([])
  })

  it('keeps the existing measured-baseline behavior by default', async () => {
    const dispatches: MutableSurface[] = []

    await runOptimization({
      baselineSurface: 'BASELINE',
      scenarios,
      dispatchWithSurface: async (surface) => {
        dispatches.push(surface)
        return { surface: String(surface) }
      },
      dispatchRef: 'test:default-baseline',
      judges: [qualityJudge],
      proposer: proposer(),
      populationSize: 1,
      maxGenerations: 1,
      seed: 7,
      reps: 1,
      resumable: false,
      runDir: '/default-baseline',
      storage: inMemoryCampaignStorage(),
      tracing: 'off',
      expectUsage: 'off',
    })

    expect(dispatches).toEqual(['BASELINE', 'CANDIDATE'])
  })

  it('rejects an incomplete imported campaign before proposing or dispatching', async () => {
    const baseline = await measureBaseline()
    let proposalCalls = 0
    let dispatchCalls = 0

    await expect(
      runOptimization({
        baselineSurface: 'BASELINE',
        premeasuredBaseline: {
          surfaceHash: surfaceHash('BASELINE'),
          campaign: { ...baseline, cells: [] },
        },
        scenarios,
        dispatchWithSurface: async () => {
          dispatchCalls += 1
          return { surface: 'CANDIDATE' }
        },
        judges: [qualityJudge],
        proposer: proposer(() => {
          proposalCalls += 1
        }),
        populationSize: 1,
        maxGenerations: 1,
        seed: 7,
        reps: 1,
        runDir: '/reject-incomplete',
        storage: inMemoryCampaignStorage(),
        tracing: 'off',
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/premeasured baseline is incomplete.*missing campaign cell/)
    expect(proposalCalls).toBe(0)
    expect(dispatchCalls).toBe(0)
  })

  it('runs the normal judge completeness check on an imported campaign', async () => {
    const baseline = await measureBaseline()
    const withoutJudgeScores: CampaignResult<TestArtifact, TestScenario> = {
      ...baseline,
      cells: baseline.cells.map((cell) => ({ ...cell, judgeScores: {} })),
    }

    await expect(
      runOptimization({
        baselineSurface: 'BASELINE',
        premeasuredBaseline: {
          surfaceHash: surfaceHash('BASELINE'),
          campaign: withoutJudgeScores,
        },
        scenarios,
        dispatchWithSurface: async () => ({ surface: 'CANDIDATE' }),
        judges: [qualityJudge],
        proposer: proposer(),
        populationSize: 1,
        maxGenerations: 1,
        seed: 7,
        reps: 1,
        runDir: '/reject-missing-judge',
        storage: inMemoryCampaignStorage(),
        tracing: 'off',
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/premeasured baseline is incomplete.*no successful finite judge score/)
  })

  it('rejects an imported campaign measured on a different scenario payload', async () => {
    const baseline = await measureBaseline()

    await expect(
      runOptimization({
        baselineSurface: 'BASELINE',
        premeasuredBaseline: {
          surfaceHash: surfaceHash('BASELINE'),
          campaign: baseline,
        },
        scenarios: [{ ...scenarios[0]!, prompt: 'changed' }],
        dispatchWithSurface: async () => ({ surface: 'CANDIDATE' }),
        judges: [qualityJudge],
        proposer: proposer(),
        populationSize: 1,
        maxGenerations: 1,
        seed: 7,
        reps: 1,
        runDir: '/reject-wrong-scenario',
        storage: inMemoryCampaignStorage(),
        tracing: 'off',
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/premeasured baseline split does not match the requested scenarios/)
  })

  it('rejects an imported campaign bound to another surface', async () => {
    const baseline = await measureBaseline()

    await expect(
      runOptimization({
        baselineSurface: 'BASELINE',
        premeasuredBaseline: {
          surfaceHash: surfaceHash('OTHER'),
          campaign: baseline,
        },
        scenarios,
        dispatchWithSurface: async () => ({ surface: 'CANDIDATE' }),
        judges: [qualityJudge],
        proposer: proposer(),
        populationSize: 1,
        maxGenerations: 1,
        seed: 7,
        reps: 1,
        runDir: '/reject-wrong-surface',
        storage: inMemoryCampaignStorage(),
        tracing: 'off',
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/premeasured baseline surface hash does not match baselineSurface/)
  })

  it('rejects an imported campaign measured with another seed', async () => {
    const baseline = await measureBaseline()

    await expect(
      runOptimization({
        baselineSurface: 'BASELINE',
        premeasuredBaseline: {
          surfaceHash: surfaceHash('BASELINE'),
          campaign: baseline,
        },
        scenarios,
        dispatchWithSurface: async () => ({ surface: 'CANDIDATE' }),
        judges: [qualityJudge],
        proposer: proposer(),
        populationSize: 1,
        maxGenerations: 1,
        seed: 8,
        reps: 1,
        runDir: '/reject-wrong-seed',
        storage: inMemoryCampaignStorage(),
        tracing: 'off',
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/premeasured baseline seed 7 does not match requested seed 8/)
  })
})

describe('runOptimization candidate concurrency', () => {
  it('runs candidate campaigns in parallel without changing result order', async () => {
    let active = 0
    let maxActive = 0
    const wideProposer: SurfaceProposer = {
      kind: 'wide',
      async propose() {
        return ['CANDIDATE', 'CANDIDATE-2', 'CANDIDATE-3']
      },
    }

    const result = await runOptimization({
      baselineSurface: 'BASELINE',
      scenarios,
      dispatchWithSurface: async (surface) => {
        if (surface !== 'BASELINE') {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 10))
          active -= 1
        }
        return { surface: String(surface) }
      },
      judges: [qualityJudge],
      proposer: wideProposer,
      populationSize: 3,
      candidateConcurrency: 2,
      maxConcurrency: 1,
      maxGenerations: 1,
      runDir: '/parallel-candidates',
      storage: inMemoryCampaignStorage(),
      tracing: 'off',
      expectUsage: 'off',
    })

    expect(maxActive).toBe(2)
    expect(result.generations[0]?.surfaces.map((entry) => entry.surface)).toEqual([
      'CANDIDATE',
      'CANDIDATE-2',
      'CANDIDATE-3',
    ])
    expect(result.winnerSurface).toBe('CANDIDATE')
  })
})
