/**
 * `runOptimization` improves a mutable surface with a caller-owned proposer,
 * as a search on the one kernel (`runSearch`).
 *
 * The baseline is the seeded root. The scenarios are the train split: the
 * proposer reads their scores, and the policy ranks on them because the loop
 * has no private selection split. A "generation" is one proposal of
 * `populationSize` candidates from the node the policy chose (by default the
 * incumbent, once every earlier candidate is measured). Every candidate is a
 * node measured on every scenario at every repeat, one cell at a time on the
 * run's lanes. The kept surface is the policy's leader: a budget decision on
 * the train split that claims nothing; `runImprovementLoop` compares it with
 * the baseline on separate cases.
 *
 * The search ledger is always written, beside the run (`<runDir>/search/`) or
 * where `searchLedger` puts it, and it is the run's only checkpoint: running
 * again on the same run directory and options continues an interrupted run
 * instead of starting over, and reruns nothing that settled.
 */

import { createHash } from 'node:crypto'
import { assertProposalFindings } from '../../analyst/proposal-findings'
import type { ProposalFinding } from '../../analyst/types'
import type { CostLedgerHandle, CostLedgerSummary } from '../../cost-ledger'
import { hashCanonical } from '../../ledger-core/canonical'
import { uniform } from '../allocation'
import { computeManifestHash } from '../campaign-manifest'
import {
  assertCampaignSplitIdentity,
  campaignCoverage,
  campaignSplitDigest,
  formatCoverageFailures,
} from '../coverage'
import type { RunCampaignOptions } from '../run-campaign'
import { resolveRunDir } from '../run-dir'
import { campaignMeanCompositeOrNull } from '../score-utils'
import { searchProposalExecution, searchReceiptAccounting } from '../search-campaign-cell'
import type { SearchHistoryReceipt } from '../search-history-receipt'
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
  SearchAttemptAccounting,
  SearchExecutionIdentity,
  SearchOperationRecordedEvent,
} from '../search-ledger-types'
import { incumbent, type SearchPolicy } from '../search-policy'
import { renderSearchSummary, searchProposerView } from '../search-summary'
import { type CampaignStorage, createRunCostLedger, fsCampaignStorage } from '../storage'
import { surfaceDispatchRef, surfaceHash, surfaceHashMatches } from '../surface-identity'
import {
  type CampaignResult,
  type GenerationRecord,
  isProposedCandidate,
  type MutableSurface,
  type ParetoParent,
  type ProposeContext,
  type Scenario,
  type SurfaceProposer,
} from '../types'
import { SurfaceNodes, surfaceCodec } from './optimization-surface-nodes'

/** Compose the optimization proposer and cell executor on the shared search kernel. */

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
      artifactKind:
        typeof baselineSurface === 'object' && baselineSurface.kind === 'code' ? 'code' : 'prompt',
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

  const nodes = new SurfaceNodes<TScenario, TArtifact>(
    opts,
    recorder,
    runDir,
    costLedger,
    execution,
    premeasured,
  )
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
      const before = new Set(
        phases.flatMap((phase) => costLedger.list({ phase })).map((receipt) => receipt.callId),
      )
      const accounting = (): {
        accounting: SearchAttemptAccounting
        execution: SearchOperationRecordedEvent['execution']
      } => {
        const fresh = phases
          .flatMap((phase) => costLedger.list({ phase }))
          .filter((receipt) => !before.has(receipt.callId))
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

/** Optimization inputs, immutable proposal snapshots, and imported baseline validation. */

export interface PremeasuredOptimizationBaseline<TArtifact, TScenario extends Scenario> {
  /** Hash of the exact surface that produced `campaign`. */
  surfaceHash: string
  /** Complete prior measurement reused by identity, including artifactsByPath. */
  campaign: CampaignResult<TArtifact, TScenario>
}

export interface RunOptimizationOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch'> {
  /** Initial mutable surface (typically system prompt or addendum). */
  baselineSurface: MutableSurface
  /**
   * Complete prior measurement of `baselineSurface`. When present,
   * `runOptimization` validates its surface, scenario split, seed, reps, and
   * normal campaign coverage, then records its cells as the root's instead of
   * dispatching them. Prior spend stays in the imported campaign aggregates and
   * is not added again to this run's CostLedger.
   */
  premeasuredBaseline?: PremeasuredOptimizationBaseline<TArtifact, TScenario>
  /** Dispatcher that takes a surface and a scenario to an artifact. */
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: Parameters<RunCampaignOptions<TScenario, TArtifact>['dispatch']>[1],
  ) => Promise<TArtifact>
  /** The candidate-generation strategy. */
  proposer: SurfaceProposer<ProposalFinding>
  /** Candidates asked of each proposal. */
  populationSize: number
  /** Proposals the search may make. */
  maxGenerations: number
  /** Scales the run's cell lanes: at most `candidateConcurrency *
   * maxConcurrency` cells run at once. Default 1. */
  candidateConcurrency?: number
  /** DEPTH knob forwarded to the proposer's `propose()`: max iterations the
   *  agentic generator may take per candidate. */
  maxImprovementShots?: number
  /** Search or observed-production findings forwarded to candidate generation. */
  findings?: ReadonlyArray<ProposalFinding>
  /** Findings producer. Before each proposal it runs on the previous
   *  generation's measured candidates (the baseline, as `generation: -1`,
   *  before the first), and what it returns REPLACES `ctx.findings` for that
   *  proposal. The substrate does not import an analyst: the consumer plugs its
   *  trace-analyst registry here, reading the per-candidate `runDir` traces.
   *  When absent, findings stay the static `opts.findings`. Its spend is
   *  booked to the proposal's operation. */
  analyzeGeneration?: (input: {
    generation: number
    runDir: string
    candidates: Array<{
      surfaceHash: string
      campaign: CampaignResult<TArtifact, TScenario>
      composite: number | null
    }>
    history: GenerationRecord[]
    /** Shared run spend account and receipt attribution phase. */
    costLedger?: CostLedgerHandle
    costPhase?: string
  }) => Promise<ReadonlyArray<ProposalFinding>>
  /** Which node each proposal extends, and which node the run keeps. Default
   *  `incumbent()`: the hill climb. `crowdedFrontierParent({ seed })` draws
   *  the parent from the Pareto frontier instead; `aide()` drafts, debugs and
   *  improves with Thompson-sampled parents, and `beam({ width })` expands the
   *  top nodes in turn. Every policy ranks on the scenarios, and the run keeps
   *  the `uniform` allocator, because the proposer reads every candidate's
   *  score on every scenario. */
  policy?: SearchPolicy
  /** Where the search ledger goes and the identities it records. Default: a
   *  ledger at `<runDir>/search/ledger.jsonl`, held in `storage` unless that is
   *  the filesystem, whose identities are the dispatch ref's and proposer's
   *  digests. */
  searchLedger?: SearchLedgerBinding
}

export interface RunOptimizationResult<TArtifact, TScenario extends Scenario> {
  /** One entry per proposal, with the candidates it registered. */
  generations: Array<{
    record: GenerationRecord
    surfaces: Array<{
      surfaceHash: string
      surface: MutableSurface
      campaign: CampaignResult<TArtifact, TScenario>
    }>
  }>
  /** Frozen snapshot of the exact starting surface measured by `baselineCampaign`. */
  baselineSurface: MutableSurface
  winnerSurface: MutableSurface
  winnerSurfaceHash: string
  /** Proposer label for the kept surface; absent when the winner is the baseline. */
  winnerLabel?: string
  /** Proposer rationale for the kept surface, as stored: redacted with the
   *  share profile. Absent when the winner is the baseline. */
  winnerRationale?: string
  baselineCampaign: CampaignResult<TArtifact, TScenario>
  /** Run-wide spend, including agents, proposers, analysts, and judges. */
  cost: CostLedgerSummary
  /** Bounded proof envelope over the search ledger. */
  searchHistory: SearchHistoryReceipt
  /** The non-dominated set of measured surfaces by per-scenario composite. */
  paretoFrontier: ParetoParent[]
}

function immutableProposalSnapshot<T>(value: T, label: string): T {
  try {
    return deepFreeze(structuredClone(value))
  } catch (cause) {
    throw new TypeError(`runOptimization: proposal ${label} must contain snapshot-safe data`, {
      cause,
    })
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  seen.add(value)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}

function validatedPremeasuredBaseline<TScenario extends Scenario, TArtifact>(args: {
  input: PremeasuredOptimizationBaseline<TArtifact, TScenario>
  baselineSurface: MutableSurface
  scenarios: TScenario[]
  reps: number
  seed: number
  judges: NonNullable<RunCampaignOptions<TScenario, TArtifact>['judges']>
  dispatchRef: string
  requireJudgeScore: boolean
}): CampaignResult<TArtifact, TScenario> {
  const { input } = args
  if (!surfaceHashMatches(args.baselineSurface, input.surfaceHash)) {
    throw new Error(
      'runOptimization: premeasured baseline surface hash does not match baselineSurface',
    )
  }
  const campaign = input.campaign
  if (campaign.reps !== args.reps) {
    throw new Error(
      `runOptimization: premeasured baseline reps ${campaign.reps} do not match requested reps ${args.reps}`,
    )
  }
  if (campaign.seed !== args.seed) {
    throw new Error(
      `runOptimization: premeasured baseline seed ${campaign.seed} does not match requested seed ${args.seed}`,
    )
  }
  try {
    assertCampaignSplitIdentity(campaign.scenarios, campaign.reps, campaign.splitDigest)
  } catch (error) {
    throw new Error(
      `runOptimization: premeasured baseline has an invalid retained split identity — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (campaign.splitDigest !== campaignSplitDigest(args.scenarios, args.reps)) {
    throw new Error(
      'runOptimization: premeasured baseline split does not match the requested scenarios',
    )
  }
  const expectedManifest = computeManifestHash({
    scenarios: args.scenarios,
    judges: args.judges,
    dispatchRef: args.dispatchRef,
    seed: args.seed,
    reps: args.reps,
  })
  if (campaign.manifestHash !== expectedManifest) {
    throw new Error(
      'runOptimization: premeasured baseline evaluator identity does not match the requested dispatch and judges',
    )
  }
  const coverage = campaignCoverage(
    campaign.cells,
    args.scenarios,
    args.reps,
    args.requireJudgeScore,
  )
  if (!coverage.complete) {
    throw new Error(
      `runOptimization: premeasured baseline is incomplete (${coverage.scorableCellIds.length}/${coverage.expectedCellIds.length} designed cells scorable) — ${formatCoverageFailures(coverage)}. Refusing to optimize against an incomplete incumbent.`,
    )
  }
  return campaign
}
