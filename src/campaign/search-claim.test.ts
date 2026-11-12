import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openFinalEvidenceLedger } from '../experiment/final-evidence'
import { hashCanonical } from '../ledger-core/canonical'
import { uniform } from './allocation'
import { prepareSearchFinalEvidence } from './final-evidence'
import { searchClaimDecision, verifySearchClaim } from './search-claim'
import {
  type RunSearchOptions,
  runSearch,
  type SearchArtifactCodec,
  type SearchExecutor,
  type SearchProposerPort,
} from './search-kernel'
import { openSearchLedger } from './search-ledger'
import { SearchRecorder, surfaceNode } from './search-ledger-recording'
import { incumbent } from './search-policy'
import { inMemoryCampaignStorage } from './storage'

const SOURCE = { uri: 'test:search-claim', revision: hashCanonical('search-claim-test') }
const tasks = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    taskId: `${prefix}${index}`,
    unitId: `${prefix}${index}`,
    source: { uri: `test://${prefix}${index}`, revision: SOURCE.revision },
  }))

/** A search whose one child beats the root by about 0.5 on every unit, with a
 * different per-unit spread on each, so the paired deltas vary and the claim
 * uses its continuous estimator. */
async function searchOptions(
  direction: 'maximize' | 'minimize',
): Promise<RunSearchOptions<string>> {
  const storage = inMemoryCampaignStorage()
  let clock = Date.parse('2026-10-06T00:00:00Z')
  const recorder = await SearchRecorder.open(
    {
      ledger: openSearchLedger({
        path: '/search/ledger.jsonl',
        searchId: 'claim-test',
        store: storage,
      }),
      storage,
      now: () => (clock += 1000),
    },
    {
      subject: 'test/prompt',
      process: { name: 'claim-test', executionRef: SOURCE },
      artifactKind: 'prompt',
      objective: {
        metric: 'score',
        direction,
        judge: SOURCE,
        claim: {
          population: { id: 'claim-test', description: 'synthetic units' },
          samplingFrame: 'every synthetic unit',
          independentUnit: 'id',
          generalization: 'new-units',
          use: 'comparison',
          minimumEffect: 0.2,
        },
      },
      splits: {
        train: tasks('t', 2),
        selection: tasks('s', 8),
        test: tasks('x', 24),
        heldOutUnits: true,
      },
      policy: { expansion: 'incumbent', allocation: 'uniform', seed: 7 },
      budget: {
        maxUsd: null,
        maxCells: null,
        maxNodes: 2,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: {
        model: { provider: 'test', alias: 'test', unknown: 'no model' },
        agent: SOURCE,
        benchmark: { uri: 'test://tasks', revision: SOURCE.revision },
      },
    },
  )
  const codec: SearchArtifactCodec<string> = {
    node: (rec, prompt) => surfaceNode(rec, prompt),
    diff: () => ({ unknown: 'not needed' }),
    load: (rec, node) => (rec.readBlob(node.artifact) as { surface: string }).surface,
  }
  const spread = (taskId: string, period: number) => (Number(taskId.slice(1)) % period) * 0.05
  const executor: SearchExecutor<string> = {
    lanes: () => [{ name: 'test', capacity: 4, costCap: 'hard', cellUsd: 0 }],
    place: () => 'test',
    adopt: async () => null,
    run: async (work) => {
      const better = work.artifact === 'better'
      const good = direction === 'maximize' ? better : !better
      const score = good ? 0.75 + spread(work.taskId, 4) : 0.25 + spread(work.taskId, 3)
      return {
        outcome: { status: 'passed', score, metrics: { score } },
        accounting: {
          tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          cost: { status: 'known', usd: 0, source: 'free' },
        },
        identity: {
          model: { provider: 'test', alias: 'test', unknown: 'no model' },
          agent: SOURCE,
          benchmark: { uri: 'test://tasks', revision: SOURCE.revision },
        },
        placement: { lane: work.lane, boxId: null },
      }
    },
  }
  const proposer: SearchProposerPort<string> = {
    name: 'one-child',
    kind: 'optimizer',
    source: SOURCE,
    execution: { kind: 'deterministic', source: SOURCE },
    async propose() {
      return {
        children: [{ artifact: 'better', label: 'better', rationale: 'scores higher' }],
        accounting: {
          tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          cost: { status: 'known', usd: 0, source: 'free' },
        },
      }
    },
  }
  return {
    recorder,
    root: 'baseline',
    codec,
    policy: incumbent(),
    allocation: uniform(),
    proposer,
    executor,
    maxExpansions: 1,
  }
}

const closedSearch = async (direction: 'maximize' | 'minimize') =>
  runSearch(await searchOptions(direction))

describe('searchClaimDecision', () => {
  it.each(['maximize', 'minimize'] as const)(
    'returns the paired decision the claim made for the shipped finalist (%s)',
    async (direction) => {
      const { state, claim } = await closedSearch(direction)
      expect(claim?.decision).toBe('ship')
      expect(verifySearchClaim(state)).toEqual({ status: 'verified' })
      const finalist = claim!.finalists.find((entry) => entry.nodeId === claim!.selected)!
      const decision = searchClaimDecision(state, claim!.selected!)!
      expect(decision.promote).toBe(true)
      // The decision's delta is the improvement; the claim records the test in the
      // objective's own units, so a minimized score's interval is the negation.
      expect(decision.delta).toBeGreaterThan(0.4)
      expect(direction === 'maximize' ? decision.delta : -decision.delta).toBe(finalist.test!.delta)
      expect(
        direction === 'maximize' ? [decision.low, decision.high] : [-decision.high, -decision.low],
      ).toEqual(finalist.test!.interval)
      expect(decision.method).toBe(finalist.test!.method)
      expect(decision.n).toBe(24)
    },
  )

  it('returns null for a node the claim did not test', async () => {
    const { state } = await closedSearch('maximize')
    expect(searchClaimDecision(state, state.rootNodeId!)).toBeNull()
  })

  it('records durable final exposure before dispatch and preserves its sealed roster on resume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'search-final-exposure-'))
    try {
      const ledger = openFinalEvidenceLedger({ path: join(directory, 'exposure.jsonl') })
      const options = await searchOptions('maximize')
      const header = (await options.recorder.state()).header!
      const evidenceInput = {
        policy: { ledger, requestId: options.recorder.searchId, evaluatorDigest: SOURCE.revision },
        recorder: options.recorder,
        claim: header.objective.claim,
        finalScenarios: header.splits.test.tasks.map((task) => ({ id: task.taskId, kind: 'test' })),
        developmentScenarios: [...header.splits.train.tasks, ...header.splits.selection.tasks].map(
          (task) => ({ id: task.taskId, kind: 'test' }),
        ),
      }
      let evidence = await prepareSearchFinalEvidence(evidenceInput)
      let attempts = 0
      const rosters: string[][] = []
      options.beforeClaim = async (input) => {
        rosters.push([...input.candidateDigests])
        await expect(
          evidence.beforeClaim({
            ...input,
            candidateDigests: [hashCanonical('another-candidate')],
          }),
        ).rejects.toThrow('does not match the sealed search claim')
        await evidence.beforeClaim(input)
        if (++attempts === 1) throw new Error('process stopped after exposure')
        // The callback owns a detached descriptor, not the kernel's persisted plan.
        input.plan.finalists.splice(0)
      }
      await expect(runSearch(options)).rejects.toThrow('process stopped after exposure')
      expect(
        (await options.recorder.state()).cells().filter((cell) => cell.split === 'test'),
      ).toHaveLength(0)
      const fresh = await searchOptions('maximize')
      await expect(
        prepareSearchFinalEvidence({ ...evidenceInput, recorder: fresh.recorder }),
      ).rejects.toThrow('requires the same sealed search')
      expect((await fresh.recorder.state()).cells()).toHaveLength(0)
      evidence = await prepareSearchFinalEvidence(evidenceInput)
      const result = await runSearch(options)
      expect(result.claim?.decision).toBe('ship')
      expect(rosters).toHaveLength(2)
      expect(rosters[1]).toEqual(rosters[0])
      const retained = await ledger.read()
      expect(retained.succeeded).toBe(true)
      if (!retained.succeeded) throw new Error(retained.error.message)
      expect(retained.value).toHaveLength(1)
      expect(retained.value[0]!.exposure?.measurement.candidateDigests).toHaveLength(2)
      expect(evidence.receipt().record).toEqual(retained.value[0])
      const reused = await ledger.reserve({
        ...retained.value[0]!.reservation,
        requestId: 'another-campaign',
      })
      expect(reused.succeeded).toBe(false)
      evidence = await prepareSearchFinalEvidence(evidenceInput)
      await runSearch(options)
      expect(attempts).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
