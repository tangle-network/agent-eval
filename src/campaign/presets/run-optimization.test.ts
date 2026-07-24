import { describe, expect, it } from 'vitest'
import { runCampaign } from '../run-campaign'
import { campaignMeanComposite, compareRankKeys } from '../score-utils'
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

describe('runOptimization fail-closed winner selection (gen-4 regression)', () => {
  // Six improvement-set instances, two replicates each — the shape swe-arena's
  // gate scores. `resolved` per (surface, instance, rep) reproduces gen-4:
  //   claude: i1 TT, i2 TT, i3 TF   → fail-closed 2 (i1,i2), per-cell mean 5/12
  //   merge : i1 TT, i2 TF, i3 FT, i4 TF, i5 FT → fail-closed 1 (i1), mean 6/12
  // The ship-gate counts an instance resolved only when BOTH reps resolve, so
  // claude (2 fail-closed) beats baseline (1) and must win; merge (1 fail-closed,
  // == baseline) must NOT. But merge has the higher per-cell MEAN (0.500 > 0.417),
  // so the historical scalar-mean selector promotes merge — the inverted pick
  // that made the run report rejected-no-gain when a real 2-vs-1 gain existed.
  const sweScenarios: TestScenario[] = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'].map((id) => ({
    id,
    kind: 'test',
    prompt: id,
  }))
  // `T`/`F` per rep0/rep1; absent surface ⇒ all false.
  const RESOLVE: Record<string, Record<string, [boolean, boolean]>> = {
    BASELINE: { i6: [true, true] }, // fail-closed 1, mean 2/12
    CLAUDE: { i1: [true, true], i2: [true, true], i3: [true, false] }, // fail-closed 2, mean 5/12
    MERGE: {
      i1: [true, true],
      i2: [true, false],
      i3: [false, true],
      i4: [true, false],
      i5: [false, true],
    }, // fail-closed 1, mean 6/12
  }
  interface SweArtifact {
    surface: string
    resolved: boolean
  }
  const resolvedJudge: JudgeConfig<SweArtifact, TestScenario> = {
    name: 'resolved',
    dimensions: [{ key: 'resolved', description: 'instance resolved' }],
    score: ({ artifact }) => {
      const composite = artifact.resolved ? 1 : 0
      return { composite, dimensions: { resolved: composite }, notes: '' }
    },
  }
  const twoCandidateProposer: SurfaceProposer = {
    kind: 'gen4-two-candidate',
    async propose() {
      return ['CLAUDE', 'MERGE']
    },
  }
  /** Instances where EVERY replicate cell scored composite === 1 — the same
   *  fail-closed AND-across-reps reduction swe-arena's ship-gate uses. */
  function failClosedResolvedCount(campaign: CampaignResult<SweArtifact, TestScenario>): number {
    const byScenario = new Map<string, number[]>()
    for (const cell of campaign.cells) {
      const scores = Object.values(cell.judgeScores).filter(
        (s) => s.failed !== true && Number.isFinite(s.composite),
      )
      const cellComposite =
        scores.length === 0
          ? Number.NaN
          : scores.reduce((a, s) => a + s.composite, 0) / scores.length
      const arr = byScenario.get(cell.scenarioId) ?? []
      arr.push(cellComposite)
      byScenario.set(cell.scenarioId, arr)
    }
    let count = 0
    for (const comps of byScenario.values()) {
      if (comps.length === 2 && comps.every((c) => c === 1)) count += 1
    }
    return count
  }
  async function runGen4(
    selectionRankKey?: (campaign: CampaignResult<SweArtifact, TestScenario>) => number[],
  ) {
    return runOptimization<TestScenario, SweArtifact>({
      baselineSurface: 'BASELINE',
      scenarios: sweScenarios,
      dispatchWithSurface: async (surface, scenario, ctx) => {
        const resolved = RESOLVE[String(surface)]?.[scenario.id]?.[ctx.rep] ?? false
        return { surface: String(surface), resolved }
      },
      dispatchRef: 'test:gen4-selection',
      judges: [resolvedJudge],
      proposer: twoCandidateProposer,
      populationSize: 2,
      maxGenerations: 1,
      seed: 7,
      reps: 2,
      resumable: false,
      runDir: '/gen4-selection',
      storage: inMemoryCampaignStorage(),
      tracing: 'off',
      expectUsage: 'off',
      ...(selectionRankKey ? { selectionRankKey } : {}),
    })
  }

  it('DEFAULT scalar-mean selector promotes the flaky higher-mean candidate (the bug)', async () => {
    const result = await runGen4()
    // merge's per-cell mean (0.500) tops claude's (0.417), so the historical
    // selector picks the 1-fail-closed candidate the gate rejects.
    expect(result.winnerSurface).toBe('MERGE')
  })

  it('fail-closed selectionRankKey promotes the 2-fail-closed candidate the gate accepts', async () => {
    const result = await runGen4((campaign) => [
      failClosedResolvedCount(campaign),
      campaignMeanComposite(campaign),
    ])
    expect(result.winnerSurface).toBe('CLAUDE')
  })

  it('the promoted candidate is the max fail-closed count, not the max per-cell mean', async () => {
    const result = await runGen4((campaign) => [
      failClosedResolvedCount(campaign),
      campaignMeanComposite(campaign),
    ])
    const winnerCampaign = result.generations[0]?.surfaces.find(
      (s) => s.surfaceHash === result.winnerSurfaceHash,
    )?.campaign
    expect(winnerCampaign).toBeDefined()
    const claude = result.generations[0]!.surfaces.find((s) => s.surface === 'CLAUDE')!.campaign
    const merge = result.generations[0]!.surfaces.find((s) => s.surface === 'MERGE')!.campaign
    expect(failClosedResolvedCount(claude)).toBe(2)
    expect(failClosedResolvedCount(merge)).toBe(1)
    // The invariant: winner = argmax fail-closed, even though merge wins the mean.
    expect(campaignMeanComposite(merge)).toBeGreaterThan(campaignMeanComposite(claude))
    expect(failClosedResolvedCount(winnerCampaign!)).toBe(2)
  })
})

describe('compareRankKeys tie-breaking', () => {
  it('ranks strictly by the first differing element (higher is better)', () => {
    expect(compareRankKeys([2, 0.4], [1, 0.9])).toBeGreaterThan(0)
    expect(compareRankKeys([1, 0.9], [2, 0.4])).toBeLessThan(0)
  })

  it('falls through equal primaries to the secondary (cost, then mean)', () => {
    // [failClosed, -wallSeconds, mean]: equal fail-closed → cheaper wall wins.
    expect(compareRankKeys([2, -100, 0.4], [2, -250, 0.9])).toBeGreaterThan(0)
    // equal fail-closed AND wall → higher mean wins.
    expect(compareRankKeys([2, -100, 0.5], [2, -100, 0.4])).toBeGreaterThan(0)
  })

  it('treats identical keys as a tie', () => {
    expect(compareRankKeys([2, -100, 0.5], [2, -100, 0.5])).toBe(0)
  })
})

describe('runOptimization candidate concurrency', () => {
  it('runs candidate campaigns in parallel without changing result order', async () => {
    let active = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const twoActive = new Promise<void>((resolve) => {
      release = resolve
    })
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
          if (active === 2) release?.()
          await twoActive
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
