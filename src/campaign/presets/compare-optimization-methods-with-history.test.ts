import { describe, expect, it } from 'vitest'
import { inMemoryCampaignStorage } from '../storage'
import type { DispatchContext, JudgeConfig, Scenario } from '../types'
import { OptimizationHistoryRequiredError } from '../optimization-history'
import {
  compareOptimizationMethodsWithHistory,
  type HistoryAwareOptimizationMethod,
} from './compare-optimization-methods-with-history'

interface FixtureScenario extends Scenario {
  kind: 'fixture'
}

interface FixtureArtifact {
  text: string
}

const trainScenarios: FixtureScenario[] = [{ id: 'train-1', kind: 'fixture' }]
const selectionScenarios: FixtureScenario[] = [{ id: 'selection-1', kind: 'fixture' }]
const testScenarios: FixtureScenario[] = [
  { id: 'test-1', kind: 'fixture' },
  { id: 'test-2', kind: 'fixture' },
]

const judge: JudgeConfig<FixtureArtifact, FixtureScenario> = {
  name: 'history-comparison-fixture',
  dimensions: [{ key: 'quality', description: 'candidate marker is present' }],
  score: ({ artifact }) => {
    const quality = artifact.text.includes('candidate') ? 1 : 0
    return { dimensions: { quality }, composite: quality, notes: '' }
  },
}

function method(name = 'method-without-history'): HistoryAwareOptimizationMethod<
  FixtureScenario,
  FixtureArtifact
> {
  return {
    name,
    async optimize() {
      return {
        winnerSurface: 'candidate prompt',
        cost: {
          totalCostUsd: 0,
          costProvenance: { kind: 'observed', usd: 0 },
          accountingComplete: true,
          incompleteReasons: [],
        },
        durationMs: 1,
      }
    },
  }
}

function options(
  methods: HistoryAwareOptimizationMethod<FixtureScenario, FixtureArtifact>[],
  dispatch: (
    surface: string,
    scenario: FixtureScenario,
    context: DispatchContext,
  ) => Promise<FixtureArtifact>,
) {
  return {
    methods,
    baselineSurface: 'baseline prompt',
    trainScenarios,
    selectionScenarios,
    testScenarios,
    dispatchWithSurface: dispatch,
    judges: [judge],
    runDir: 'mem://optimization-history-comparison',
    storage: inMemoryCampaignStorage(),
    seed: 7,
    reps: 1,
  }
}

describe('compareOptimizationMethodsWithHistory', () => {
  it('refuses missing history before any untouched-test dispatch', async () => {
    let dispatchCalls = 0

    await expect(
      compareOptimizationMethodsWithHistory({
        ...options([method()], async (surface, scenario) => {
          dispatchCalls += 1
          return { text: `${surface}:${scenario.id}` }
        }),
        historyPolicy: 'require-complete',
      }),
    ).rejects.toBeInstanceOf(OptimizationHistoryRequiredError)

    expect(dispatchCalls).toBe(0)
  })

  it('preserves legacy comparison behavior while reporting missing coverage by default', async () => {
    let dispatchCalls = 0
    const comparison = await compareOptimizationMethodsWithHistory(
      options([method()], async (surface, scenario) => {
        dispatchCalls += 1
        return { text: `${surface}:${scenario.id}` }
      }),
    )

    expect(dispatchCalls).toBeGreaterThan(0)
    expect(comparison.best.name).toBe('method-without-history')
    expect(comparison.optimizationHistory).toEqual({
      policy: 'allow-missing',
      allComplete: false,
      methods: [
        {
          methodName: 'method-without-history',
          status: 'missing',
          reasons: ['history receipt is missing'],
        },
      ],
    })
  })

  it('refuses a supplied receipt whose method identity disagrees', async () => {
    const mismatched = method('expected-method')
    mismatched.optimize = async () => ({
      winnerSurface: 'candidate prompt',
      cost: {
        totalCostUsd: 0,
        costProvenance: { kind: 'observed', usd: 0 },
        accountingComplete: true,
        incompleteReasons: [],
      },
      history: {
        schemaVersion: '1.0.0',
        kind: 'optimization-history',
        digestAlgorithm: 'rfc8785-sha256',
        receiptDigest: `sha256:${'0'.repeat(64)}`,
        methodName: 'another-method',
      } as never,
    })

    await expect(
      compareOptimizationMethodsWithHistory(
        options([mismatched], async () => ({ text: 'unused' })),
      ),
    ).rejects.toThrow(/optimization history receipt/)
  })
})
