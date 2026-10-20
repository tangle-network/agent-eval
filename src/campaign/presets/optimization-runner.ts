/** Compose the optimization proposer and cell executor on the shared search kernel. */

import { createHash } from 'node:crypto'
import { assertProposalFindings } from '../../analyst/proposal-findings'
import type { ProposalFinding } from '../../analyst/types'
import type { CostReceipt } from '../../cost-ledger'
import { hashCanonical } from '../../ledger-core/canonical'
import { uniform } from '../allocation'
import { campaignCoverage, campaignSplitDigest, formatCoverageFailures } from '../coverage'
import { resolveRunDir } from '../run-dir'
import { campaignMeanCompositeOrNull } from '../score-utils'
import { searchProposalExecution, searchReceiptAccounting } from '../search-campaign-cell'
import {
  runSearch,
  SEARCH_KERNEL_SOURCE,
  type SearchExecutor,
  type SearchProposerPort,
} from '../search-kernel'
import { openSearchLedger } from '../search-ledger'
import {
  developmentClaim,
  type SearchLedgerBinding,
  SearchRecorder,
  type SearchRunIdentity,
} from '../search-ledger-recording'
import type {
  SearchArtifactKind,
  SearchAttemptAccounting,
  SearchExecutionIdentity,
  SearchOperationRecordedEvent,
} from '../search-ledger-types'
import { incumbent } from '../search-policy'
import { renderSearchSummary, searchProposerView } from '../search-summary'
import { type CampaignStorage, createRunCostLedger, fsCampaignStorage } from '../storage'
import { surfaceDispatchRef, surfaceHash } from '../surface-identity'
import {
  isProposedCandidate,
  type MutableSurface,
  type ProposeContext,
  type Scenario,
} from '../types'
import {
  immutableProposalSnapshot,
  type RunOptimizationOptions,
  type RunOptimizationResult,
  validatedPremeasuredBaseline,
} from './optimization-run-input'
import { SurfaceNodes, surfaceCodec } from './optimization-surface-nodes'

/** Improve a surface as a search on the kernel; see the module comment. */
export async function runOptimization<TScenario extends Scenario, TArtifact>(
  opts: RunOptimizationOptions<TScenario, TArtifact>,
): Promise<RunOptimizationResult<TArtifact, TScenario>> {
  const candidateConcurrency = opts.candidateConcurrency ?? 1
  if (typeof opts.runDir !== 'string' || opts.runDir.trim().length === 0) {
    throw new Error('runOptimization: runDir is required and must be a non-empty string')
  }
  if (!Number.isInteger(candidateConcurrency) || candidateConcurrency < 1) {
    throw new Error('runOptimization: candidateConcurrency must be a positive integer')
  }
  for (const [name, value] of [
    ['populationSize', opts.populationSize],
    ['maxGenerations', opts.maxGenerations],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`runOptimization: ${name} must be a non-negative integer`)
    }
  }
  const initialFindings = immutableProposalSnapshot(
    assertProposalFindings(opts.findings ?? [], 'runOptimization initial proposal findings'),
    'initial findings',
  )
  const baselineSurface = immutableProposalSnapshot(opts.baselineSurface, 'baseline surface')
  const runDir = resolveRunDir(opts.runDir, opts.repo)
  const storage = opts.storage ?? fsCampaignStorage()
  const costLedger =
    opts.costLedger ?? createRunCostLedger({ storage, runDir, costCeilingUsd: opts.costCeiling })
  const reps = opts.reps ?? 1
  const seed = opts.seed ?? 42
  const requireJudgeScore = (opts.judges?.length ?? 0) > 0
  const premeasured = opts.premeasuredBaseline
    ? validatedPremeasuredBaseline({
        input: opts.premeasuredBaseline,
        baselineSurface,
        scenarios: opts.scenarios,
        reps,
        seed,
        judges: opts.judges ?? [],
        dispatchRef: surfaceDispatchRef(baselineSurface, opts.dispatchRef),
        requireJudgeScore,
      })
    : undefined

  const splitDigest = campaignSplitDigest(opts.scenarios, reps)
  const binding = opts.searchLedger ?? (await defaultBinding(opts, runDir, storage))
  const { identity } = binding
  const execution: SearchExecutionIdentity = {
    model: identity.model,
    agent: identity.agent,
    benchmark: { uri: 'campaign://scenarios', revision: splitDigest },
  }
  const policy = opts.policy ?? incumbent()
  const allocation = uniform({ reps })
  const recorder = await SearchRecorder.open(
    { ledger: binding.ledger, storage },
    {
      subject: identity.subject ?? opts.proposer.kind,
      process: { name: 'runOptimization', executionRef: identity.search },
      artifactKind: artifactKindOf(baselineSurface),
      objective: {
        metric: 'composite',
        direction: 'maximize',
        judge: identity.judge ?? {
          unknown: 'runOptimization receives its judges as functions without a pinned source',
        },
        claim: identity.claim ?? developmentClaim(splitDigest),
      },
      splits: {
        train: opts.scenarios.map((scenario) => ({
          taskId: scenario.id,
          unitId: scenario.id,
          source: { uri: `scenario://${scenario.id}`, revision: hashCanonical(scenario) },
        })),
        selection: [],
        test: [],
        heldOutUnits: true,
      },
      policy: { expansion: policy.name, allocation: allocation.name, seed },
      budget: {
        maxUsd: opts.costCeiling ?? null,
        maxCells: null,
        maxNodes: 1 + opts.populationSize * opts.maxGenerations,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: execution,
    },
  )

  const nodes = new SurfaceNodes<TScenario, TArtifact>({
    opts,
    recorder,
    runDir,
    costLedger,
    execution,
    premeasured,
  })
  const scenarioById = new Map(opts.scenarios.map((scenario) => [scenario.id, scenario]))
  let findings: ReadonlyArray<ProposalFinding> = initialFindings

  const executor: SearchExecutor<MutableSurface> = {
    lanes: () => [
      {
        name: 'campaign',
        capacity: candidateConcurrency * (opts.maxConcurrency ?? 2),
        costCap: 'estimate',
        cellUsd: 0,
      },
    ],
    place: () => 'campaign',
    run: (work) => nodes.runCell(work, scenarioById),
    adopt: (work) => nodes.adoptCell(work),
  }

  const proposer = opts.proposer
  const proposerSource = identity.proposer.source
  const port: SearchProposerPort<MutableSurface> = {
    name: proposer.kind,
    kind: 'optimizer',
    source: proposerSource,
    execution: identity.proposer,
    childrenPerProposal: opts.populationSize,
    async propose(request) {
      const phases = ['search.proposal', 'analysis.baseline', 'analysis.generation']
      const before = new Set(phases.flatMap((phase) => costLedger.list({ phase })).map(receiptKey))
      const accounting = (): {
        accounting: SearchAttemptAccounting
        execution: SearchOperationRecordedEvent['execution']
      } => {
        const fresh = phases
          .flatMap((phase) => costLedger.list({ phase }))
          .filter((receipt) => !before.has(receiptKey(receipt)))
        return {
          accounting: searchReceiptAccounting(fresh),
          execution: opts.searchLedger
            ? identity.proposer
            : searchProposalExecution(fresh, identity.model.provider, proposerSource),
        }
      }
      // Every read of the ledger below happens synchronously on one state
      // view: an await lets the kernel append, which retires the view.
      const earlier = await recorder.state()
      const root = earlier.rootNodeId!
      const rootCampaign = nodes.campaign(earlier, root)
      const rootCoverage = campaignCoverage(
        rootCampaign.cells,
        opts.scenarios,
        reps,
        requireJudgeScore,
      )
      if (!rootCoverage.complete) {
        const label = premeasured ? 'premeasured baseline' : 'baseline'
        throw new Error(
          `runOptimization: ${label} is incomplete (${rootCoverage.scorableCellIds.length}/${rootCoverage.expectedCellIds.length} designed cells scorable) — ${formatCoverageFailures(rootCoverage)}. Refusing to optimize against an incomplete incumbent.`,
        )
      }
      // A generation is a proposal that registered a candidate; a proposal
      // lost to a crash or made only of re-proposals is not one.
      const generation = nodes.generations(earlier).length
      if (opts.analyzeGeneration) {
        const previous = generation - 1
        const nodeIds =
          previous < 0
            ? [root]
            : nodes.expansionNodes(earlier, nodes.generations(earlier)[previous]!)
        const candidates = nodeIds.map((nodeId) => {
          const campaign = nodes.campaign(earlier, nodeId)
          return {
            surfaceHash: surfaceHash(nodes.surface(earlier, nodeId)),
            campaign,
            composite: campaignMeanCompositeOrNull(campaign),
          }
        })
        const history = nodes.history(earlier, policy)
        if (candidates.some(({ campaign }) => campaign.cells.length > 0)) {
          const fresh = await opts.analyzeGeneration({
            generation: previous,
            runDir: previous < 0 ? rootCampaign.runDir : `${runDir}/candidates`,
            candidates,
            history,
            costLedger,
            costPhase: previous < 0 ? 'analysis.baseline' : 'analysis.generation',
          })
          if (!Array.isArray(fresh)) {
            throw new TypeError('runOptimization: analyzeGeneration must return an array')
          }
          findings = immutableProposalSnapshot(
            assertProposalFindings(fresh, 'runOptimization analysis findings'),
            'analysis findings',
          )
        }
      }
      const state = await recorder.state()
      const proposalHistory = immutableProposalSnapshot(nodes.history(state, policy), 'history')
      const parent = request.parents[0]!
      const context: ProposeContext<ProposalFinding> = Object.freeze({
        currentSurface: immutableProposalSnapshot(parent.artifact, 'current surface'),
        operator: request.operator,
        parents: immutableProposalSnapshot(
          request.parents.map(({ nodeId, artifact }) => ({
            nodeId,
            artifact: immutableProposalSnapshot(artifact, 'parent surface'),
          })),
          'parents',
        ),
        train: searchProposerView(state),
        summary: renderSearchSummary(state, { split: 'train' }),
        history: proposalHistory,
        findings: immutableProposalSnapshot(
          assertProposalFindings(findings, 'runOptimization proposal findings'),
          'findings',
        ),
        populationSize: opts.populationSize,
        generation,
        signal: request.signal,
        baselineOutcome: immutableProposalSnapshot(nodes.outcome(state, root), 'baseline'),
        incumbentOutcome: immutableProposalSnapshot(
          nodes.outcome(state, request.leader),
          'incumbent outcome',
        ),
        parentOutcome: immutableProposalSnapshot(
          nodes.outcome(state, parent.nodeId),
          'parent outcome',
        ),
        maxImprovementShots: opts.maxImprovementShots,
        paretoParents: immutableProposalSnapshot(nodes.frontier(state), 'Pareto parents'),
        costLedger,
        costPhase: 'search.proposal',
      })
      if (proposer.decide?.({ history: proposalHistory }).stop) {
        return { children: [], stop: 'the proposer decided to stop', ...accounting() }
      }
      const proposed = await proposer.propose(context)
      if (!Array.isArray(proposed)) {
        throw new TypeError('runOptimization: proposer must return an array')
      }
      const snapshot = immutableProposalSnapshot(proposed, 'candidate outputs')
      return {
        children: snapshot.slice(0, opts.populationSize).map((candidate) =>
          isProposedCandidate(candidate)
            ? {
                artifact: candidate.surface,
                label: candidate.label,
                rationale: candidate.rationale,
                ...(candidate.attribution ? { attribution: candidate.attribution } : {}),
              }
            : { artifact: candidate, label: '', rationale: '' },
        ),
        ...accounting(),
      }
    },
  }

  const result = await runSearch({
    recorder,
    root: baselineSurface,
    codec: surfaceCodec,
    policy,
    allocation,
    proposer: port,
    executor,
    maxExpansions: opts.maxGenerations,
    signal: opts.signal,
  })

  const state = result.state
  const winnerSurface = nodes.surface(state, result.leader)
  const firstEdge = state.edge(state.node(result.leader)!.edgeIds[0]!)!
  const winnerRationale =
    firstEdge.operator === 'seed' || !('sha256' in firstEdge.rationale)
      ? undefined
      : (recorder.readBlob(firstEdge.rationale) as { text: string }).text
  const expansions = nodes.generations(state)
  const generations: RunOptimizationResult<TArtifact, TScenario>['generations'] = nodes
    .history(state, policy)
    .map((record) => ({
      record,
      surfaces: nodes.expansionNodes(state, expansions[record.generationIndex]!).map((nodeId) => {
        const surface = nodes.surface(state, nodeId)
        return {
          surfaceHash: surfaceHash(surface),
          surface,
          campaign: nodes.campaign(state, nodeId),
        }
      }),
    }))
  return {
    generations,
    baselineSurface,
    winnerSurface,
    winnerSurfaceHash: surfaceHash(winnerSurface),
    ...(firstEdge.operator !== 'seed' && firstEdge.label ? { winnerLabel: firstEdge.label } : {}),
    ...(winnerRationale ? { winnerRationale } : {}),
    baselineCampaign: nodes.campaign(state, state.rootNodeId!),
    cost: costLedger.summary(),
    searchHistory: recorder.receipt({ producerId: proposer.kind, runId: runDir }),
    paretoFrontier: nodes.frontier(state),
  }
}

/** The default ledger and identities when the caller binds none. Revisions are
 * content digests of what the caller declared, and each uri names what its
 * digest covers: the dispatch ref, the proposer kind, the kernel. */
async function defaultBinding<TScenario extends Scenario, TArtifact>(
  opts: RunOptimizationOptions<TScenario, TArtifact>,
  runDir: string,
  storage: CampaignStorage,
): Promise<SearchLedgerBinding> {
  const base = `optimization-${createHash('sha256').update(runDir).digest('hex').slice(0, 16)}`
  const dispatchRef = opts.dispatchRef ?? 'anonymous'
  const identity: SearchRunIdentity = {
    agent: { uri: `dispatch-ref:${dispatchRef}`, revision: hashCanonical({ dispatchRef }) },
    proposer: {
      kind: 'deterministic',
      source: {
        uri: `proposer:${opts.proposer.kind}`,
        revision: hashCanonical({ proposer: opts.proposer.kind }),
      },
    },
    search: SEARCH_KERNEL_SOURCE,
    model: {
      provider: 'unspecified',
      alias: 'unspecified',
      unknown: 'runOptimization was not told which model the agent runs',
    },
  }
  // A closed search is final. The run directory's first search that is still
  // open, or not started, is this call's: an interrupted run continues, and a
  // run after a finished one starts the next search beside it.
  for (let slot = 1; ; slot++) {
    const dir = slot === 1 ? `${runDir}/search` : `${runDir}/search-${slot}`
    const path = `${dir}/ledger.jsonl`
    const searchId = slot === 1 ? base : `${base}-${slot}`
    // The ledger lives where the run's storage lives: a filesystem run gets
    // the durable file journal; any other storage holds the ledger's text.
    const ledger =
      storage.kind === 'filesystem'
        ? openSearchLedger({ path, searchId })
        : openSearchLedger({ path, searchId, store: storage })
    if (!(await ledger.state()).closed) return { ledger, identity }
  }
}

function artifactKindOf(surface: MutableSurface): SearchArtifactKind {
  return typeof surface === 'object' && surface.kind === 'code' ? 'code' : 'prompt'
}

function receiptKey(receipt: CostReceipt): string {
  return receipt.callId
}
