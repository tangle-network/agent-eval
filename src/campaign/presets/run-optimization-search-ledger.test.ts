import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifySearchHistoryReceipt } from '../search-history-receipt'
import { openSearchLedger, type SearchLedgerEvent } from '../search-ledger'
import type { SearchRunIdentity } from '../search-ledger-recording'
import { fsCampaignStorage } from '../storage'
import { surfaceHash } from '../surface-identity'
import type { JudgeConfig, Scenario, SurfaceProposer } from '../types'
import { runOptimization } from './run-optimization'

interface LedgerScenario extends Scenario {
  kind: 'ledger'
}

interface LedgerArtifact {
  surface: string
}

const scenarios: LedgerScenario[] = [
  { id: 'alpha', kind: 'ledger' },
  { id: 'beta', kind: 'ledger' },
]

const judge: JudgeConfig<LedgerArtifact, LedgerScenario> = {
  name: 'marker',
  dimensions: [{ key: 'marker', description: 'candidate marker is present' }],
  score: ({ artifact }) => {
    const composite = artifact.surface === 'CANDIDATE' ? 1 : 0
    return { composite, dimensions: { marker: composite }, notes: '' }
  },
}

const proposer: SurfaceProposer = {
  kind: 'fixed-candidate',
  async propose({ generation }) {
    return generation === 0 ? ['CANDIDATE'] : []
  },
}

const identity: SearchRunIdentity = {
  agent: { uri: 'git+https://github.com/example/agent.git', revision: 'a'.repeat(40) },
  proposer: {
    kind: 'deterministic',
    source: { uri: 'git+https://github.com/example/proposer.git', revision: 'b'.repeat(40) },
  },
  search: { uri: 'git+https://github.com/tangle-network/agent-eval.git', revision: 'c'.repeat(40) },
  model: { provider: 'example', snapshot: 'test-model@2026-08-01' },
}

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'search-ledger-loop-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

describe('runOptimization search ledger', () => {
  it('records the whole search and returns a complete, verifiable receipt', async () => {
    const ledgerPath = join(runDir, 'search-ledger.jsonl')
    const ledger = openSearchLedger({ path: ledgerPath, campaignId: 'ledger-run' })

    const result = await runOptimization<LedgerScenario, LedgerArtifact>({
      baselineSurface: 'BASELINE',
      scenarios,
      dispatchWithSurface: async (surface) => ({ surface: String(surface) }),
      dispatchRef: 'test:search-ledger',
      judges: [judge],
      proposer,
      populationSize: 1,
      // Generation 1 proposes nothing, so its planned slot must close rather
      // than silently vanish from the denominator.
      maxGenerations: 2,
      seed: 7,
      reps: 2,
      resumable: false,
      runDir,
      storage: fsCampaignStorage(),
      tracing: 'off',
      expectUsage: 'off',
      searchLedger: { ledger, identity },
    })

    const receipt = result.searchHistory
    if (!receipt) throw new Error('runOptimization returned no search history receipt')
    expect(receipt.complete).toBe(true)
    expect(receipt.incompleteReasons).toEqual([])
    // The receipt verifies as a canonical envelope, digest included.
    expect(verifySearchHistoryReceipt(receipt).receiptDigest).toBe(receipt.receiptDigest)

    const replay = await openSearchLedger({ path: ledgerPath, campaignId: 'ledger-run' }).replay()
    const kinds = new Set(replay.entries.map((entry) => entry.event.kind))
    expect(kinds).toEqual(
      new Set<SearchLedgerEvent['kind']>([
        'search-planned',
        'search-operation-recorded',
        'candidate-registered',
        'task-attempted',
        'candidate-slot-closed',
        'candidate-decided',
        'search-completed',
      ]),
    )

    // The winner is the one registered candidate, its lineage roots at the
    // baseline (measured before this ledger opened), and every designed cell
    // is accounted for: 2 scenarios x 2 replicates.
    const candidateId = surfaceHash('CANDIDATE')
    expect(replay.candidates.map((event) => event.candidateId)).toEqual([candidateId])
    expect(replay.candidates[0]?.lineage.parentCandidateIds).toEqual([])
    expect(replay.attempts).toHaveLength(4)
    expect(replay.audit).toMatchObject({
      status: 'selected',
      selectedCandidateId: candidateId,
      attemptCount: 4,
      outcomes: { passed: 4, failed: 0, errored: 0 },
      expected: {
        taskOutcomes: 4,
        missingTaskOutcomes: [],
        missingCandidateSlots: [],
        missingOperations: [],
      },
    })
    expect(result.winnerSurface).toBe('CANDIDATE')
  })

  it('reports the exact gap instead of a closed search when a cell fails', async () => {
    const ledgerPath = join(runDir, 'search-ledger.jsonl')
    const ledger = openSearchLedger({ path: ledgerPath, campaignId: 'ledger-gap' })

    const result = await runOptimization<LedgerScenario, LedgerArtifact>({
      baselineSurface: 'BASELINE',
      scenarios,
      dispatchWithSurface: async (surface, scenario) => {
        if (surface === 'CANDIDATE' && scenario.id === 'beta') {
          throw new Error('dispatch refused the beta scenario')
        }
        return { surface: String(surface) }
      },
      dispatchRef: 'test:search-ledger-gap',
      judges: [judge],
      proposer,
      populationSize: 1,
      maxGenerations: 1,
      seed: 7,
      reps: 1,
      resumable: false,
      runDir,
      storage: fsCampaignStorage(),
      tracing: 'off',
      expectUsage: 'off',
      searchLedger: { ledger, identity },
    })

    const receipt = result.searchHistory
    if (!receipt) throw new Error('runOptimization returned no search history receipt')
    expect(receipt.complete).toBe(false)
    expect(receipt.summary.missingTaskOutcomes).toBe(1)
    expect(receipt.summary.hasCompletion).toBe(false)
    expect(receipt.incompleteReasons.join(' ')).toMatch(/task outcome is unresolved/i)

    const replay = await openSearchLedger({ path: ledgerPath, campaignId: 'ledger-gap' }).replay()
    expect(replay.audit.outcomes).toMatchObject({ passed: 1, errored: 1 })
    expect(replay.audit.status).toBe('in-progress')
  })
})
