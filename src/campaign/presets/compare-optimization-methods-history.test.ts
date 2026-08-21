import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGepaCandidatePopulationArtifact } from '../gepa-candidate-population'
import { type SearchHistoryReceipt, SearchHistoryRequiredError } from '../search-history-receipt'
import { openSearchLedger } from '../search-ledger'
import { recordCandidatePopulationSearch, type SearchRunIdentity } from '../search-ledger-recording'
import { fsCampaignStorage, inMemoryCampaignStorage } from '../storage'
import type { DispatchContext, JudgeConfig, MutableSurface, Scenario } from '../types'
import {
  type CompareOptimizationMethodsOptions,
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

describe('a first-party method that records its candidate population', () => {
  let runDir: string
  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'population-history-'))
  })
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
  })

  const identity: SearchRunIdentity = {
    agent: { uri: 'git+https://github.com/example/agent.git', revision: 'a'.repeat(40) },
    proposer: {
      kind: 'model',
      model: { provider: 'example', snapshot: 'optimizer-model@2026-08-01' },
      source: { uri: 'git+https://github.com/gepa-ai/gepa.git', revision: 'b'.repeat(40) },
    },
    search: {
      uri: 'git+https://github.com/tangle-network/agent-eval.git',
      revision: 'c'.repeat(40),
    },
    model: { provider: 'example', snapshot: 'agent-model@2026-08-01' },
  }

  /** The exact artifact shape a GEPA run writes: a candidate graph with
   *  parents and a score per selection scenario. */
  function populationArtifact(storage: ReturnType<typeof fsCampaignStorage>) {
    const path = join(runDir, 'candidate-population.json')
    const scenarioIds = selectionScenarios.map((scenario) => scenario.id)
    const candidates = [
      {
        index: 0,
        candidate: 'baseline prompt',
        parentIndices: [null],
        aggregateScore: 0,
        selectionScores: scenarioIds.map((scenarioId) => ({ scenarioId, score: 0 })),
        discoveryEvaluationCount: 1,
      },
      {
        index: 1,
        candidate: 'candidate prompt',
        parentIndices: [0],
        aggregateScore: 1,
        selectionScores: scenarioIds.map((scenarioId) => ({ scenarioId, score: 1 })),
        discoveryEvaluationCount: 1,
      },
    ]
    const contents = JSON.stringify({
      schemaVersion: 1,
      scope: 'gepa-candidate-population',
      runId: 'population-run',
      bestIndex: 1,
      candidates,
    })
    storage.ensureDir(runDir)
    storage.write(path, contents)
    return readGepaCandidatePopulationArtifact({
      storage,
      summary: {
        scope: 'gepa-candidate-population',
        path,
        sha256: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
        bytes: new TextEncoder().encode(contents).byteLength,
        runId: 'population-run',
        candidates: candidates.length,
        bestIndex: 1,
        maxCandidates: 8,
        maxCandidateChars: 4_000,
        scenarioIds,
        surfaceKind: 'text',
      },
    })
  }

  it('passes require-complete with a receipt replayable from the ledger bytes', async () => {
    const storage = fsCampaignStorage()
    const population = populationArtifact(storage)
    const ledgerPath = join(runDir, 'search-ledger.jsonl')

    const recorded: OptimizationMethod<FixtureScenario, FixtureArtifact> = {
      name: 'method-with-population-history',
      async optimize() {
        const searchHistory = await recordCandidatePopulationSearch({
          ledger: openSearchLedger({ path: ledgerPath, campaignId: 'population-run' }),
          storage,
          runDir,
          identity,
          population,
          scenarios: selectionScenarios,
          generationAccounting: {
            tokens: { status: 'known', inputTokens: 120, outputTokens: 40, cachedTokens: 0 },
            cost: { status: 'known', usd: 0.002, source: 'provider' },
          },
          producerId: 'method-with-population-history',
          runId: 'population-run',
        })
        return {
          winnerSurface: 'candidate prompt',
          cost: {
            totalCostUsd: 0.002,
            costProvenance: { kind: 'observed', usd: 0.002 },
            accountingComplete: true,
            incompleteReasons: [],
          },
          durationMs: 1,
          searchHistory,
        }
      },
    }

    const comparison = await compareOptimizationMethods({
      ...options([recorded], async (surface, scenario) => {
        const rendered = typeof surface === 'string' ? surface : JSON.stringify(surface)
        return { text: `${rendered}:${scenario.id}` }
      }),
      searchHistoryPolicy: 'require-complete',
    })

    expect(comparison.searchHistory).toMatchObject({
      policy: 'require-complete',
      allComplete: true,
      producers: [{ producerId: 'method-with-population-history', status: 'complete' }],
    })

    // The receipt is a cover sheet over durable bytes: replaying the file
    // reproduces the candidate graph the optimizer reported.
    const replay = await openSearchLedger({
      path: ledgerPath,
      campaignId: 'population-run',
    }).replay()
    expect(replay.candidates.map((event) => event.lineage.generation)).toEqual([0, 1])
    expect(replay.candidates[1]?.lineage.parentCandidateIds).toEqual([
      replay.candidates[0]?.candidateId,
    ])
    expect(replay.audit).toMatchObject({
      status: 'selected',
      attemptCount: 2 * selectionScenarios.length,
      expected: { missingTaskOutcomes: [], missingCandidateSlots: [], missingOperations: [] },
    })
  })
})
