import { describe, expect, it } from 'vitest'
import { SearchHistoryRequiredError, type SearchHistoryReceipt } from '../search-history-receipt'
import { inMemoryCampaignStorage } from '../storage'
import type { DispatchContext, JudgeConfig, MutableSurface, Scenario } from '../types'
import {
  compareOptimizationMethods,
  type CompareOptimizationMethodsOptions,
  type OptimizationMethod,
} from './compare-optimization-methods'

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

function method(
  name = 'method-without-history',
  searchHistory?: SearchHistoryReceipt,
): OptimizationMethod<FixtureScenario, FixtureArtifact> {
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
        ...(searchHistory === undefined ? {} : { searchHistory }),
      }
    },
  }
}

function options(
  methods: OptimizationMethod<FixtureScenario, FixtureArtifact>[],
  dispatch: (
    surface: MutableSurface,
    scenario: FixtureScenario,
    context: DispatchContext,
  ) => Promise<FixtureArtifact>,
): CompareOptimizationMethodsOptions<FixtureScenario, FixtureArtifact> {
  return {
    methods,
    baselineSurface: 'baseline prompt',
    trainScenarios,
    selectionScenarios,
    testScenarios,
    dispatchWithSurface: dispatch,
    judges: [judge],
    runDir: 'mem://search-history-comparison',
    storage: inMemoryCampaignStorage(),
    seed: 7,
    reps: 1,
  }
}

describe('compareOptimizationMethods search-history policy', () => {
  it('refuses missing history before any untouched-test dispatch', async () => {
    let dispatchCalls = 0

    await expect(
      compareOptimizationMethods({
        ...options([method()], async () => {
          dispatchCalls += 1
          return { text: 'unused' }
        }),
        searchHistoryPolicy: 'require-complete',
      }),
    ).rejects.toBeInstanceOf(SearchHistoryRequiredError)

    expect(dispatchCalls).toBe(0)
  })

  it('preserves existing comparison behavior while reporting missing coverage by default', async () => {
    let dispatchCalls = 0
    const comparison = await compareOptimizationMethods(
      options([method()], async (surface, scenario) => {
        dispatchCalls += 1
        const rendered = typeof surface === 'string' ? surface : JSON.stringify(surface)
        return { text: `${rendered}:${scenario.id}` }
      }),
    )

    expect(dispatchCalls).toBeGreaterThan(0)
    expect(comparison.best.name).toBe('method-without-history')
    expect(comparison.searchHistory).toEqual({
      policy: 'allow-missing',
      allComplete: false,
      producers: [
        {
          producerId: 'method-without-history',
          status: 'missing',
          reasons: ['search history receipt is missing'],
        },
      ],
    })
  })

  it('treats a malformed supplied receipt as invalid evidence, not as missing evidence', async () => {
    const malformed = {
      schemaVersion: '1.0.0',
      kind: 'search-history-receipt',
      digestAlgorithm: 'rfc8785-sha256',
      receiptDigest: `sha256:${'0'.repeat(64)}`,
      producerId: 'method-with-malformed-history',
    } as unknown as SearchHistoryReceipt
    let dispatchCalls = 0

    await expect(
      compareOptimizationMethods(
        options([method('method-with-malformed-history', malformed)], async () => {
          dispatchCalls += 1
          return { text: 'unused' }
        }),
      ),
    ).rejects.toThrow(/search history/)

    expect(dispatchCalls).toBe(0)
  })
})
