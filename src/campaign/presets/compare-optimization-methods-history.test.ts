import { describe, expect, it } from 'vitest'
import {
  createOptimizationHistoryReceipt,
  type OptimizationHistoryReceipt,
  OptimizationHistoryRequiredError,
} from '../optimization-history'
import type { SearchLedgerHash, SearchLedgerReplay } from '../search-ledger'
import { inMemoryCampaignStorage } from '../storage'
import type { DispatchContext, JudgeConfig, MutableSurface, Scenario } from '../types'
import {
  compareOptimizationMethods,
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

const digest = (character: string): SearchLedgerHash => `sha256:${character.repeat(64)}`

function completeHistory(methodName: string): OptimizationHistoryReceipt {
  const headHash = digest('2')
  const replay = {
    entries: [
      {
        sequence: 0,
        entryHash: digest('1'),
        event: { eventId: 'plan-1', kind: 'search-planned' },
      },
      {
        sequence: 1,
        entryHash: headHash,
        event: { eventId: 'complete-1', kind: 'search-completed' },
      },
    ],
    plan: { eventId: 'plan-1' },
    candidates: [],
    closedCandidateSlots: [],
    attempts: [],
    operations: [],
    decisions: [],
    completion: { eventId: 'complete-1' },
    audit: {
      campaignId: 'campaign-1',
      eventCount: 2,
      candidateCount: 0,
      closedCandidateSlotCount: 0,
      attemptCount: 0,
      operationCount: 0,
      outcomes: { passed: 0, failed: 0, errored: 0 },
      operationOutcomes: { completed: 0, partial: 0, failed: 0 },
      decisions: { selected: 0, rejected: 0, pending: 0 },
      expected: {
        candidateSlots: 0,
        taskOutcomes: 0,
        operations: 0,
        missingCandidateSlots: [],
        missingTaskOutcomes: [],
        missingOperations: [],
      },
      status: 'all-rejected',
      selectedCandidateId: null,
      accounting: {
        status: 'known',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
      },
      headHash,
    },
  } as unknown as SearchLedgerReplay

  return createOptimizationHistoryReceipt({
    methodName,
    runId: `${methodName}-run`,
    ledger: {
      role: 'search-ledger',
      uri: `artifact://${methodName}/search-ledger.jsonl`,
      sha256: digest('3'),
      byteLength: 128,
    },
    replay,
  })
}

function method(
  name = 'fixture-method',
  history?: OptimizationHistoryReceipt,
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
        ...(history ? { history } : {}),
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

describe('compareOptimizationMethods optimization history', () => {
  it('refuses missing history before any untouched-test dispatch when required', async () => {
    let dispatchCalls = 0

    await expect(
      compareOptimizationMethods({
        ...options([method()], async (surface, scenario) => {
          dispatchCalls += 1
          return { text: `${String(surface)}:${scenario.id}` }
        }),
        historyPolicy: 'require-complete',
      }),
    ).rejects.toBeInstanceOf(OptimizationHistoryRequiredError)

    expect(dispatchCalls).toBe(0)
  })

  it('preserves existing behavior and reports missing coverage by default', async () => {
    let dispatchCalls = 0
    const comparison = await compareOptimizationMethods(
      options([method()], async (surface, scenario) => {
        dispatchCalls += 1
        return { text: `${String(surface)}:${scenario.id}` }
      }),
    )

    expect(dispatchCalls).toBeGreaterThan(0)
    expect(comparison.best.name).toBe('fixture-method')
    expect(comparison.optimizationHistory).toEqual({
      policy: 'allow-missing',
      allComplete: false,
      methods: [
        {
          methodName: 'fixture-method',
          status: 'missing',
          reasons: ['history receipt is missing'],
        },
      ],
    })
  })

  it('retains a complete receipt on the comparison and each scored method', async () => {
    const history = completeHistory('fixture-method')
    const comparison = await compareOptimizationMethods({
      ...options([method('fixture-method', history)], async (surface, scenario) => ({
        text: `${String(surface)}:${scenario.id}`,
      })),
      historyPolicy: 'require-complete',
    })

    expect(comparison.optimizationHistory.policy).toBe('require-complete')
    expect(comparison.optimizationHistory.allComplete).toBe(true)
    expect(comparison.optimizationHistory.methods).toEqual([
      {
        methodName: 'fixture-method',
        status: 'complete',
        reasons: [],
        receipt: history,
      },
    ])
    expect(comparison.best.history?.receiptDigest).toBe(history.receiptDigest)
  })
})
