import { describe, expect, it } from 'vitest'
import { inMemoryCampaignStorage } from '../storage'
import type { Gate, JudgeConfig, JudgeScore, Scenario, SurfaceProposer } from '../types'
import { runImprovementLoop } from './run-improvement-loop'

interface TestScenario extends Scenario {
  kind: 'test'
}

interface TestArtifact {
  surface: string
}

const training: TestScenario[] = [{ id: 'train', kind: 'test' }]
const holdout: TestScenario[] = [
  { id: 'h1', kind: 'test' },
  { id: 'h2', kind: 'test' },
  { id: 'h3', kind: 'test' },
  { id: 'h4', kind: 'test' },
]

const proposer: SurfaceProposer = {
  kind: 'fixed-candidate',
  async propose() {
    return ['CANDIDATE']
  },
}

function score(composite: number, failed?: true): JudgeScore {
  return {
    composite,
    dimensions: { quality: composite },
    notes: failed ? 'judge failed' : '',
    ...(failed ? { failed } : {}),
  }
}

function loopOptions(judges: JudgeConfig<TestArtifact, TestScenario>[]) {
  let releaseDecisionCalls = 0
  const releaseDecision: Gate<TestArtifact, TestScenario> = {
    name: 'must-not-run-on-incomplete-holdout',
    async decide() {
      releaseDecisionCalls += 1
      return {
        decision: 'ship',
        reasons: ['candidate improved'],
        contributingGates: [],
      }
    },
  }

  return {
    options: {
      scenarios: training,
      holdoutScenarios: holdout,
      baselineSurface: 'BASELINE',
      dispatchWithSurface: async (surface: string | object) => ({ surface: String(surface) }),
      judges,
      proposer,
      populationSize: 1,
      maxGenerations: 1,
      gate: releaseDecision,
      autoOnPromote: 'none' as const,
      runDir: '/heldout-integrity-regression',
      storage: inMemoryCampaignStorage(),
      resumable: false,
      expectUsage: 'off' as const,
    },
    releaseDecisionCalls: () => releaseDecisionCalls,
  }
}

describe('runImprovementLoop held-out denominator integrity', () => {
  it('refuses a 3/4 comparison when the candidate has one NaN judge score', async () => {
    const quality: JudgeConfig<TestArtifact, TestScenario> = {
      name: 'quality',
      dimensions: [{ key: 'quality', description: 'candidate quality' }],
      score: ({ artifact, scenario }) => {
        if (artifact.surface === 'CANDIDATE' && scenario.id === 'h4') {
          return score(Number.NaN)
        }
        return score(artifact.surface === 'CANDIDATE' ? 1 : 0)
      },
    }
    const { options, releaseDecisionCalls } = loopOptions([quality])

    await expect(runImprovementLoop(options)).rejects.toThrow(
      /winner holdout is incomplete \(3\/4 designed cells scorable\).*h4:0: .*non-finite judge score: quality/,
    )
    expect(releaseDecisionCalls()).toBe(0)
  })

  it('refuses a cell containing one successful score and one failed judge score', async () => {
    const quality: JudgeConfig<TestArtifact, TestScenario> = {
      name: 'quality',
      dimensions: [{ key: 'quality', description: 'candidate quality' }],
      score: ({ artifact }) => score(artifact.surface === 'CANDIDATE' ? 1 : 0),
    }
    const reliability: JudgeConfig<TestArtifact, TestScenario> = {
      name: 'reliability',
      dimensions: [{ key: 'quality', description: 'judge reliability' }],
      score: ({ artifact, scenario }) =>
        artifact.surface === 'CANDIDATE' && scenario.id === 'h4'
          ? score(0, true)
          : score(artifact.surface === 'CANDIDATE' ? 1 : 0),
    }
    const { options, releaseDecisionCalls } = loopOptions([quality, reliability])

    await expect(runImprovementLoop(options)).rejects.toThrow(
      /winner holdout is incomplete \(3\/4 designed cells scorable\).*h4:0: judge score marked failed/,
    )
    expect(releaseDecisionCalls()).toBe(0)
  })
})
