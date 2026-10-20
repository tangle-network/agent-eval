import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSearch, type SearchArtifactCodec, type SearchExecutor, type SearchProposerPort, type SearchRunResult } from '../../src/campaign/search-kernel'
import { openSearchLedger } from '../../src/campaign/search-ledger'
import { developmentClaim, SearchRecorder } from '../../src/campaign/search-ledger-recording'
import { type SearchStateView } from '../../src/campaign/search-state'
import { hashCanonical } from '../../src/ledger-core/canonical'
import { type SimArtifact, type SimOptions } from './types'
import { ROOT, unit, round, tasks, plantedName, rootOf, childOf, poolChild, draftChild, simulateCell } from './objective'
import { SEARCH_ID, SIM_SOURCE, PROPOSAL_USD, benchmark, judge, MAX_ATTEMPTS, allocationOf, policyOf } from './policy'
import { type SimStore } from './store'
import { checkLedger } from './ledger-audit'

export async function runSimulation(
  dir: string,
  options: SimOptions,
  store: SimStore,
): Promise<{
  result: SearchRunResult
  summary: Record<string, unknown>
  /** The hidden artifact behind a node, read back through the codec. */
  truth: (nodeId: string) => SimArtifact
}> {
  const path = join(dir, 'ledger.jsonl')
  const searchId = options.searchId ?? SEARCH_ID
  const ledger = store.storage
    ? openSearchLedger({ path, searchId, store: store.storage })
    : openSearchLedger({ path, searchId })
  const policy = policyOf(options)
  const allocation = allocationOf(options)
  const root = rootOf(options)
  const claim = developmentClaim('search-sim')
  const recorder = await SearchRecorder.open(
    { ledger, ...(store.storage ? { storage: store.storage } : {}) },
    {
      subject: 'sim/objective',
      process: { name: 'search-sim', executionRef: SIM_SOURCE },
      artifactKind: 'prompt',
      objective: {
        metric: 'score',
        direction: options.minimize ? 'minimize' : 'maximize',
        judge: judge(options),
        claim:
          options.minEffect === undefined ? claim : { ...claim, minimumEffect: options.minEffect },
      },
      splits: {
        train: tasks('t', options.train),
        selection: tasks('s', options.selection),
        test: tasks('x', options.test),
        heldOutUnits: true,
      },
      policy: { expansion: policy.name, allocation: allocation.name, seed: options.seed },
      budget: {
        maxUsd: options.maxUsd,
        maxCells: options.maxCells,
        maxNodes: 1 + options.population * options.expansions,
        deadline: options.deadline,
        maxConcurrency: null,
        reservedClaimUsd: options.claimUsd,
      },
      containment: options.containment ?? null,
      derivedFrom: null,
      identity: {
        model: { provider: 'sim', alias: 'sim', unknown: 'the simulator runs no model' },
        agent: SIM_SOURCE,
        benchmark: benchmark(options),
      },
    },
  )

  const codec: SearchArtifactCodec<SimArtifact> = {
    node: (rec, artifact) => {
      const ref = rec.blob('surface', { kind: 'sim-artifact', artifact })
      return {
        artifactDigest: hashCanonical(artifact),
        artifact: ref,
        surfaces: [{ surfaceId: 'prompt', kind: 'prompt', artifact: ref }],
      }
    },
    diff: (rec, parent, child) =>
      rec.blob('diff', { kind: 'sim-diff', from: parent.name, to: child.name }),
    load: (rec, node) => (rec.readBlob(node.artifact) as { artifact: SimArtifact }).artifact,
  }

  let inFlight = 0
  let peak = 0
  let lastChange = Date.now()
  let busyArea = 0
  let busyTime = 0
  let fullTime = 0
  const startedAt = Date.now()
  const track = (delta: number): void => {
    const now = Date.now()
    const span = now - lastChange
    busyArea += inFlight * span
    if (inFlight > 0) busyTime += span
    if (inFlight >= options.capacity) fullTime += span
    lastChange = now
    inFlight += delta
    peak = Math.max(peak, inFlight)
  }
  let adopted = 0
  const pause = (ms: number): Promise<void> =>
    ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve()

  const executor: SearchExecutor<SimArtifact> = {
    lanes: () => [
      {
        name: 'sim',
        capacity: options.capacity,
        costCap: options.costCap,
        cellUsd: options.cellUsd,
      },
    ],
    place: () => 'sim',
    async adopt(work) {
      if (!store.has(work.runId)) return null
      adopted += 1
      store.log('adopted', work.runId)
      return store.read(work.runId)
    },
    async run(work) {
      store.log('started', work.runId)
      track(1)
      try {
        await pause(options.delayMs * (0.5 + unit(options.seed, 'delay', work.runId)))
        const result = simulateCell(work, options)
        store.write(work.runId, result)
        store.log('finished', work.runId)
        // The worker has finished; its response takes a while to arrive, so a
        // restart in this window finds a result to adopt.
        await pause(options.delayMs / 2)
        return result
      } finally {
        track(-1)
      }
    },
  }

  const proposer: SearchProposerPort<SimArtifact> = {
    name: 'search-sim',
    kind: 'optimizer',
    source: SIM_SOURCE,
    execution: { kind: 'deterministic', source: SIM_SOURCE },
    reservationUsd: PROPOSAL_USD,
    childrenPerProposal: options.population,
    async propose(request) {
      const parent = request.parents[0]!
      // Children are numbered after the parent's existing children, so a
      // proposal lost to a crash is proposed again identically.
      const state: SearchStateView = await recorder.state()
      if (request.operator === 'draft' && options.deepGain === null) {
        // A fresh artifact, numbered by the nodes the search holds. The deep
        // plant's landscape is the root's tree, so there a draft is one more
        // child of the root.
        const registered = state.audit.nodes
        return {
          children: Array.from({ length: options.population }, (_, index) =>
            draftChild(registered + index, options),
          ),
          accounting: {
            tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            cost: { status: 'known', usd: PROPOSAL_USD, source: 'pricing-table' },
          },
        }
      }
      if (options.poolGap !== null) {
        // The planted pool: numbered by the nodes the search holds, so a lost
        // proposal is proposed again identically, and independent of the parent.
        const registered = state.audit.nodes - 1
        return {
          children: Array.from({ length: options.population }, (_, index) =>
            poolChild(registered + index, options),
          ),
          accounting: {
            tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            cost: { status: 'known', usd: PROPOSAL_USD, source: 'pricing-table' },
          },
        }
      }
      const born = state.node(parent.nodeId)!.children.length
      return {
        children: Array.from({ length: options.population }, (_, index) =>
          childOf(
            parent.artifact,
            `${parent.artifact.name}.${born + index}`,
            options,
            request.operator,
          ),
        ),
        accounting: {
          tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          cost: { status: 'known', usd: PROPOSAL_USD, source: 'pricing-table' },
        },
      }
    },
  }

  const result = await runSearch({
    recorder,
    root,
    codec,
    policy,
    allocation,
    proposer,
    executor,
    maxExpansions: options.expansions,
    maxAttempts: MAX_ATTEMPTS,
  })
  track(0)
  const { state } = result
  const truth = (nodeId: string): SimArtifact => codec.load(recorder, state.node(nodeId)!)
  const testCells = state.cells().filter((cell) => cell.split === 'test')
  const invalid = state
    .nodes()
    .filter((node) => node.status === 'invalid')
    .map((node) => {
      const last = node.decisions.at(-1)!
      return {
        nodeId: node.nodeId,
        name: truth(node.nodeId).name,
        rule: last.rule,
        reason: last.reason,
      }
    })
  const invalidIds = new Set(invalid.map((node) => node.nodeId))
  const claimed = result.claim
  const kept = truth(result.leader)
  const planted = plantedName(options)
  const names = new Set(state.nodes().map((node) => truth(node.nodeId).name))
  const ledgerText = store.storage?.read(path) ?? readFileSync(path, 'utf8')
  const best = state
    .nodes()
    .reduce(
      (top, node) => Math.max(top, truth(node.nodeId).quality),
      Number.NEGATIVE_INFINITY,
    )
  const drafts = state.edges().filter((edge) => edge.operator === 'draft')
  const summary = {
    reason: result.reason,
    leader: result.leader,
    bestQuality: best,
    drafts: drafts.map((edge) => ({
      child: truth(edge.childNodeId).name,
      evidence: edge.selection?.evidence ?? null,
    })),
    kept: {
      name: kept.name,
      quality: kept.quality,
      status: state.node(result.leader)!.status,
      planted: planted !== null && kept.name === planted,
    },
    /** The planted node was proposed and registered. */
    reachedPlant: planted !== null && names.has(planted),
    ledgerChecks: checkLedger(ledgerText, searchId, allocation, policy),
    nodes: state.audit.nodes,
    claim: claimed && {
      decision: claimed.decision,
      selected: claimed.selected && {
        nodeId: claimed.selected,
        ...truth(claimed.selected),
      },
      reason: claimed.reason,
      power: claimed.power,
      finalists: claimed.finalists.map((finalist) => ({
        nodeId: finalist.nodeId,
        name: truth(finalist.nodeId).name,
        trueGain: round(truth(finalist.nodeId).quality - ROOT.quality),
        /** The selection estimate against the root the finalist was chosen on. */
        selectionDelta:
          state
            .node(finalist.nodeId)!
            .decisions.find((decision) => decision.decision.status === 'finalist')?.basis?.delta ??
          null,
        promote: finalist.promote,
        test: finalist.test,
      })),
    },
    testCells: {
      allocated: testCells.length,
      scored: testCells.filter((cell) => cell.score !== null).length,
      spentUsd: round(testCells.reduce((total, cell) => total + cell.spentUsd, 0)),
    },
    invalid,
    edgesFromInvalidParents: state
      .edges()
      .filter((edge) => edge.parents.some((parent) => invalidIds.has(parent.nodeId))).length,
    audit: state.audit,
    lanes: {
      capacity: options.capacity,
      peakInFlight: peak,
      meanInFlight: round(busyArea / Math.max(1, Date.now() - startedAt)),
      /** Of the time any cell ran, the share with every slot busy. */
      atCapacityShare: round(fullTime / Math.max(1, busyTime)),
    },
    adopted,
  }
  return { result, summary, truth }
}
