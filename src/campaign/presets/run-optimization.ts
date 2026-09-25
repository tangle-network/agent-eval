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
import type { CostLedgerHandle, CostLedgerSummary, CostReceipt } from '../../cost-ledger'
import { hashCanonical } from '../../ledger-core/canonical'
import { type Objective, paretoFrontier } from '../../pareto'
import { modelHasSnapshot } from '../../run-record'
import { uniform } from '../allocation'
import { computeManifestHash } from '../campaign-manifest'
import { cellCachePath } from '../cell-schedule'
import {
  assertCampaignSplitIdentity,
  type CampaignCoverage,
  campaignCoverage,
  campaignSplitDigest,
  formatCoverageFailures,
} from '../coverage'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { resolveRunDir } from '../run-dir'
import { projectCampaignCellQuality } from '../run-record'
import {
  campaignBreakdown,
  campaignMeanComposite,
  campaignMeanCompositeOrNull,
} from '../score-utils'
import type { SearchHistoryReceipt } from '../search-history-receipt'
import {
  runSearch,
  SEARCH_KERNEL_SOURCE,
  type SearchArtifactCodec,
  type SearchCellResult,
  type SearchCellWork,
  type SearchExecutor,
  type SearchProposalBlob,
  type SearchProposerPort,
  searchExpansionIndex,
  searchPolicyView,
} from '../search-kernel'
import { openSearchLedger } from '../search-ledger'
import {
  developmentClaim,
  type SearchLedgerBinding,
  SearchRecorder,
  type SearchRunIdentity,
  surfaceDiff,
  surfaceNode,
} from '../search-ledger-recording'
import type {
  SearchArtifactKind,
  SearchAttemptAccounting,
  SearchExecutionIdentity,
  SearchModelIdentity,
  SearchOperationRecordedEvent,
  SearchTaskOutcome,
} from '../search-ledger-types'
import { incumbent, type SearchPolicy } from '../search-policy'
import type { SearchStateView } from '../search-state'
import { type CampaignStorage, createRunCostLedger, fsCampaignStorage } from '../storage'
import { surfaceDispatchRef, surfaceHash, surfaceHashMatches } from '../surface-identity'
import {
  type CampaignCellResult,
  type CampaignResult,
  type GenerationCandidate,
  type GenerationRecord,
  isProposedCandidate,
  type MutableSurface,
  type ParetoParent,
  type ProposeContext,
  type Scenario,
  type ScoredSurfaceOutcome,
  type SurfaceProposer,
} from '../types'

export interface PremeasuredOptimizationBaseline<TArtifact, TScenario extends Scenario> {
  /** Hash of the exact surface that produced `campaign`. */
  surfaceHash: string
  /** Complete prior measurement reused by identity, including artifactsByPath. */
  campaign: CampaignResult<TArtifact, TScenario>
}

export interface RunOptimizationBaseOptions<TScenario extends Scenario, TArtifact>
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
   *  the parent from the Pareto frontier instead. */
  policy?: SearchPolicy
  /** Where the search ledger goes and the identities it records. Default: a
   *  ledger at `<runDir>/search/ledger.jsonl` (in memory for a `mem://` run)
   *  whose identities are the dispatch ref's and proposer's digests. */
  searchLedger?: SearchLedgerBinding
}

export type RunOptimizationOptions<
  TScenario extends Scenario,
  TArtifact,
> = RunOptimizationBaseOptions<TScenario, TArtifact>

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
  const binding = opts.searchLedger ?? defaultBinding(opts, runDir, storage)
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
    adopt: async (work) =>
      (await nodes.cellCached(work)) ? nodes.runCell(work, scenarioById) : null,
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
          accounting: receiptAccounting(fresh),
          execution: opts.searchLedger
            ? identity.proposer
            : proposalExecution(fresh, identity.model.provider, proposerSource),
        }
      }
      const state = await recorder.state()
      const root = state.rootNodeId!
      const rootCampaign = await nodes.campaign(state, root)
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
      const history = await nodes.history(state, policy, request.expansion)
      if (opts.analyzeGeneration) {
        const previous = request.expansion - 1
        const candidates =
          previous < 0
            ? [{ nodeId: root, campaign: rootCampaign }]
            : await Promise.all(
                nodes.expansionNodes(state, previous).map(async (nodeId) => ({
                  nodeId,
                  campaign: await nodes.campaign(state, nodeId),
                })),
              )
        if (previous < 0 ? rootCampaign.cells.length > 0 : candidates.length > 0) {
          const fresh = await opts.analyzeGeneration({
            generation: previous,
            runDir: previous < 0 ? rootCampaign.runDir : `${runDir}/gen-${previous}`,
            candidates: candidates.map(({ nodeId, campaign }) => ({
              surfaceHash: surfaceHash(nodes.surface(state, nodeId)),
              campaign,
              composite: campaignMeanCompositeOrNull(campaign),
            })),
            history: [...history],
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
      const proposalHistory = immutableProposalSnapshot(history, 'history')
      if (proposer.decide?.({ history: proposalHistory }).stop) {
        return { children: [], stop: 'the proposer decided to stop', ...accounting() }
      }
      const parent = request.parents[0]!
      const leaderOutcome = await nodes.outcome(state, request.leader)
      const context: ProposeContext<ProposalFinding> = Object.freeze({
        currentSurface: immutableProposalSnapshot(parent.artifact, 'current surface'),
        operator: request.operator,
        history: proposalHistory,
        findings: immutableProposalSnapshot(
          assertProposalFindings(findings, 'runOptimization proposal findings'),
          'findings',
        ),
        populationSize: opts.populationSize,
        generation: request.expansion,
        signal: request.signal,
        baselineOutcome: immutableProposalSnapshot(await nodes.outcome(state, root), 'baseline'),
        incumbentOutcome: immutableProposalSnapshot(leaderOutcome, 'incumbent outcome'),
        parentOutcome: immutableProposalSnapshot(
          await nodes.outcome(state, parent.nodeId),
          'parent outcome',
        ),
        maxImprovementShots: opts.maxImprovementShots,
        paretoParents: immutableProposalSnapshot(await nodes.frontier(state), 'Pareto parents'),
        costLedger,
        costPhase: 'search.proposal',
      })
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
  const generations: RunOptimizationResult<TArtifact, TScenario>['generations'] = []
  for (const record of await nodes.history(state, policy, state.audit.operations.started)) {
    generations.push({
      record,
      surfaces: await Promise.all(
        nodes.expansionNodes(state, record.generationIndex).map(async (nodeId) => {
          const surface = nodes.surface(state, nodeId)
          return {
            surfaceHash: surfaceHash(surface),
            surface,
            campaign: await nodes.campaign(state, nodeId),
          }
        }),
      ),
    })
  }
  return {
    generations,
    baselineSurface,
    winnerSurface,
    winnerSurfaceHash: surfaceHash(winnerSurface),
    ...(firstEdge.operator !== 'seed' && firstEdge.label ? { winnerLabel: firstEdge.label } : {}),
    ...(winnerRationale ? { winnerRationale } : {}),
    baselineCampaign: await nodes.campaign(state, state.rootNodeId!),
    cost: costLedger.summary(),
    searchHistory: recorder.receipt({ producerId: proposer.kind, runId: runDir }),
    paretoFrontier: await nodes.frontier(state),
  }
}

/** A mutable surface as a search artifact. */
const surfaceCodec: SearchArtifactCodec<MutableSurface> = {
  node: surfaceNode,
  diff: surfaceDiff,
  load: (recorder, node) => {
    const stored = recorder.readBlob(node.artifact) as { kind?: unknown; surface?: MutableSurface }
    if (stored.kind !== 'mutable-surface' || stored.surface === undefined) {
      throw new Error(`runOptimization: node ${node.nodeId} does not hold a mutable surface`)
    }
    return stored.surface
  },
}

/**
 * The run's view of its surface nodes: where each one's cells run, its
 * campaign, and the proposer's reads over them. Everything here derives from
 * the ledger and the per-cell campaign cache, so a resumed run reads the same.
 */
class SurfaceNodes<TScenario extends Scenario, TArtifact> {
  private readonly opts: RunOptimizationOptions<TScenario, TArtifact>
  private readonly recorder: SearchRecorder
  private readonly runDir: string
  private readonly costLedger: CostLedgerHandle
  private readonly execution: SearchExecutionIdentity
  private readonly premeasured: CampaignResult<TArtifact, TScenario> | undefined
  private readonly storage: CampaignStorage
  private readonly campaigns = new Map<
    string,
    { cells: string; campaign: CampaignResult<TArtifact, TScenario> }
  >()
  private readonly proposals = new Map<number, SearchProposalBlob>()

  constructor(input: {
    opts: RunOptimizationOptions<TScenario, TArtifact>
    recorder: SearchRecorder
    runDir: string
    costLedger: CostLedgerHandle
    execution: SearchExecutionIdentity
    premeasured: CampaignResult<TArtifact, TScenario> | undefined
  }) {
    this.opts = input.opts
    this.recorder = input.recorder
    this.runDir = input.runDir
    this.costLedger = input.costLedger
    this.execution = input.execution
    this.premeasured = input.premeasured
    this.storage = input.opts.storage ?? fsCampaignStorage()
  }

  /** `<runDir>/baseline` for the root; `<runDir>/gen-<k>/candidate-<i>` for
   * the i-th candidate of proposal k. */
  nodeDir(state: SearchStateView, nodeId: string): string {
    if (nodeId === state.rootNodeId) return `${this.runDir}/baseline`
    const { expansion, index } = this.origin(state, nodeId)
    return `${this.runDir}/gen-${expansion}/candidate-${index}`
  }

  surface(state: SearchStateView, nodeId: string): MutableSurface {
    return surfaceCodec.load(this.recorder, state.node(nodeId)!)
  }

  /** Nodes proposal `expansion` registered, in the order it returned them. */
  expansionNodes(state: SearchStateView, expansion: number): string[] {
    const blob = this.proposal(state, expansion)
    if (!blob) return []
    const ids: string[] = []
    for (const child of blob.children) {
      const nodeId = state.nodeIdForDigest(child.node.artifactDigest)
      if (nodeId === undefined || ids.includes(nodeId)) continue
      if (this.origin(state, nodeId).expansion === expansion) ids.push(nodeId)
    }
    return ids
  }

  /** True when the cell's campaign result is already cached in its node's directory. */
  async cellCached(work: SearchCellWork<MutableSurface>): Promise<boolean> {
    if (work.stage === 'root' && this.premeasured) return true
    const dir = this.nodeDir(await this.recorder.state(), work.nodeId)
    return this.storage.exists(cellCachePath(dir, `${work.taskId}:${work.rep}`))
  }

  /** Run one cell as a one-cell campaign in its node's directory; a cached
   * cell is read back, not dispatched again. */
  async runCell(
    work: SearchCellWork<MutableSurface>,
    scenarios: ReadonlyMap<string, TScenario>,
  ): Promise<SearchCellResult> {
    if (work.stage === 'root' && this.premeasured) {
      const cell = this.premeasured.cells.find(
        (candidate) => candidate.scenarioId === work.taskId && candidate.rep === work.rep,
      )
      if (!cell)
        throw new Error(`runOptimization: premeasured baseline lacks ${work.taskId}:${work.rep}`)
      return this.cellResult(cell, work)
    }
    if (!scenarios.has(work.taskId)) {
      throw new Error(`runOptimization: cell ${work.cellId} names unknown scenario ${work.taskId}`)
    }
    const dir = this.nodeDir(await this.recorder.state(), work.nodeId)
    const campaign = await this.campaignRun(work.nodeId, dir, work.artifact, {
      signal: work.signal,
      costPhase: work.stage === 'root' ? 'search.baseline' : 'search.candidate',
      cellFilter: ({ scenario, rep }) => scenario.id === work.taskId && rep === work.rep,
    })
    const cell = campaign.cells[0]
    if (!cell) throw new Error(`runOptimization: cell ${work.cellId} produced no campaign cell`)
    return this.cellResult(cell, work)
  }

  /** The node's campaign over the cells the ledger settled, read from cache. */
  async campaign(
    state: SearchStateView,
    nodeId: string,
  ): Promise<CampaignResult<TArtifact, TScenario>> {
    if (nodeId === state.rootNodeId && this.premeasured) return this.premeasured
    const settled = state
      .cells({ nodeId })
      .filter((cell) => cell.attempts > 0)
      .map((cell) => `${cell.taskId}:${cell.rep}`)
      .sort()
    const key = settled.join('\n')
    const cached = this.campaigns.get(nodeId)
    if (cached?.cells === key) return cached.campaign
    const wanted = new Set(settled)
    const campaign = await this.campaignRun(
      nodeId,
      this.nodeDir(state, nodeId),
      this.surface(state, nodeId),
      {
        costPhase: nodeId === state.rootNodeId ? 'search.baseline' : 'search.candidate',
        cellFilter: ({ scenario, rep }) => wanted.has(`${scenario.id}:${rep}`),
        labeledStore: 'off',
        dispatchGuard: true,
      },
    )
    this.campaigns.set(nodeId, { cells: key, campaign })
    return campaign
  }

  async outcome(state: SearchStateView, nodeId: string): Promise<ScoredSurfaceOutcome> {
    const campaign = await this.campaign(state, nodeId)
    const reps = this.opts.reps ?? 1
    const coverage = campaignCoverage(
      campaign.cells,
      this.opts.scenarios,
      reps,
      (this.opts.judges?.length ?? 0) > 0,
    )
    const expansion = nodeId === state.rootNodeId ? -1 : this.origin(state, nodeId).expansion
    return toScoredSurfaceOutcome(
      surfaceHash(this.surface(state, nodeId)),
      campaign,
      coverage,
      expansion,
    )
  }

  /** The Pareto frontier over every measured, complete node. */
  async frontier(state: SearchStateView): Promise<ParetoParent[]> {
    const scored: ParetoParent[] = []
    for (const node of state.nodes()) {
      if (node.status === 'invalid' || node.cellCount === 0) continue
      const cells = state.cells({ nodeId: node.nodeId })
      if (cells.some((cell) => cell.attempts === 0 && cell.cancelled === null)) continue
      if (cells.some((cell) => cell.score === null)) continue
      const campaign = await this.campaign(state, node.nodeId)
      const edge = state.edge(node.edgeIds[0]!)!
      scored.push(
        toParetoParent(
          this.surface(state, node.nodeId),
          campaign,
          node.nodeId === state.rootNodeId ? -1 : this.origin(state, node.nodeId).expansion,
          edge.operator === 'seed' ? undefined : edge.label || undefined,
        ),
      )
    }
    return computeParetoFrontier(scored)
  }

  /** One record per proposal before `upTo`, with the candidates it
   * registered and the one that took the lead, if any. */
  async history(
    state: SearchStateView,
    policy: SearchPolicy,
    upTo: number,
  ): Promise<GenerationRecord[]> {
    const records: GenerationRecord[] = []
    const measured = (nodeId: string) =>
      state.node(nodeId)!.status !== 'invalid' &&
      state.cells({ nodeId }).every((cell) => cell.attempts > 0 || cell.cancelled !== null)
    const screened: string[] = [state.rootNodeId!]
    let leader = policy.leader(searchPolicyView(state, { screened, screening: 0, expansions: 0 }))
    for (let expansion = 0; expansion < upTo; expansion++) {
      const nodeIds = this.expansionNodes(state, expansion)
      if (nodeIds.length === 0) continue
      screened.push(...nodeIds.filter(measured))
      screened.sort((a, b) => state.node(a)!.ordinal - state.node(b)!.ordinal)
      const next = policy.leader(
        searchPolicyView(state, { screened, screening: 0, expansions: expansion + 1 }),
      )
      const candidates: GenerationCandidate[] = []
      for (const nodeId of nodeIds) {
        candidates.push(await this.candidate(state, nodeId, expansion))
      }
      records.push({
        generationIndex: expansion,
        candidates,
        promoted:
          next !== leader && nodeIds.includes(next) ? [surfaceHash(this.surface(state, next))] : [],
      })
      leader = next
    }
    return records
  }

  private async candidate(
    state: SearchStateView,
    nodeId: string,
    expansion: number,
  ): Promise<GenerationCandidate> {
    const campaign = await this.campaign(state, nodeId)
    const coverage = campaignCoverage(
      campaign.cells,
      this.opts.scenarios,
      this.opts.reps ?? 1,
      (this.opts.judges?.length ?? 0) > 0,
    )
    const breakdown = campaignBreakdown(campaign)
    const child = this.proposal(state, expansion)!.children.find(
      (entry) => state.nodeIdForDigest(entry.node.artifactDigest) === nodeId,
    )!
    return {
      surfaceHash: surfaceHash(this.surface(state, nodeId)),
      composite: campaignMeanCompositeOrNull(campaign),
      eligibleForPromotion: coverage.complete,
      coverage: {
        expectedCells: coverage.expectedCellIds.length,
        scorableCells: coverage.scorableCellIds.length,
        unscorableCells: coverage.unscorableCells,
      },
      dimensions: breakdown.dimensions,
      scenarios: breakdown.scenarios,
      ...(child.label ? { label: child.label } : {}),
      ...(child.rationale ? { rationale: child.rationale } : {}),
      ...(child.attribution ? { attribution: child.attribution } : {}),
    }
  }

  private origin(state: SearchStateView, nodeId: string): { expansion: number; index: number } {
    const node = state.node(nodeId)!
    const operationId = state.edge(node.edgeIds[0]!)?.proposer?.operationId ?? null
    const expansion = operationId === null ? null : searchExpansionIndex(operationId)
    if (expansion === null) {
      throw new Error(`runOptimization: node ${nodeId} was not proposed by this run's search`)
    }
    const blob = this.proposal(state, expansion)!
    const index = blob.children.findIndex(
      (child) => child.node.artifactDigest === node.artifactDigest,
    )
    return { expansion, index }
  }

  private proposal(state: SearchStateView, expansion: number): SearchProposalBlob | undefined {
    const held = this.proposals.get(expansion)
    if (held) return held
    const operation = state.operation(`expand-${expansion}`)
    const ref = operation?.artifacts.find((artifact) => artifact.role === 'proposal')
    if (!ref) return undefined
    const blob = this.recorder.readBlob(ref) as SearchProposalBlob
    this.proposals.set(expansion, blob)
    return blob
  }

  private async campaignRun(
    nodeId: string,
    runDir: string,
    surface: MutableSurface,
    input: {
      signal?: AbortSignal
      costPhase: string
      cellFilter: NonNullable<RunCampaignOptions<TScenario, TArtifact>['cellFilter']>
      labeledStore?: 'off'
      dispatchGuard?: boolean
    },
  ): Promise<CampaignResult<TArtifact, TScenario>> {
    const {
      baselineSurface: _baselineSurface,
      premeasuredBaseline: _premeasuredBaseline,
      dispatchWithSurface,
      proposer: _proposer,
      populationSize: _populationSize,
      maxGenerations: _maxGenerations,
      candidateConcurrency: _candidateConcurrency,
      maxImprovementShots: _maxImprovementShots,
      findings: _findings,
      analyzeGeneration: _analyzeGeneration,
      policy: _policy,
      searchLedger: _searchLedger,
      ...campaignOptions
    } = this.opts
    return runCampaign<TScenario, TArtifact>({
      ...campaignOptions,
      ...(input.labeledStore ? { labeledStore: input.labeledStore } : {}),
      signal: input.signal ?? this.opts.signal,
      costLedger: this.costLedger,
      costPhase: input.costPhase,
      dispatchRef: surfaceDispatchRef(surface, this.opts.dispatchRef),
      dispatch: input.dispatchGuard
        ? () => {
            throw new Error(
              `runOptimization: a settled cell of node ${nodeId} has no cached campaign result in ${runDir}`,
            )
          }
        : (scenario, ctx) => dispatchWithSurface(surface, scenario, ctx),
      runDir,
      cellFilter: input.cellFilter,
      resumable: true,
      reuseFailedCells: true,
      maxConcurrency: 1,
    })
  }

  private cellResult(
    cell: CampaignCellResult<TArtifact>,
    work: SearchCellWork<MutableSurface>,
  ): SearchCellResult {
    return {
      outcome: cellOutcome(cell),
      accounting: cellAccounting(cell),
      identity: { ...this.execution, model: cellModel(cell, this.execution.model) },
      wallMs: cell.durationMs,
      placement: { lane: work.lane, boxId: null },
      traceRef: { unknown: 'runCampaign reports no trace id per cell' },
    }
  }
}

/** The default ledger and identities when the caller binds none. Revisions are
 * content digests of what the caller declared, and each uri names what its
 * digest covers: the dispatch ref, the proposer kind, the kernel. */
function defaultBinding<TScenario extends Scenario, TArtifact>(
  opts: RunOptimizationOptions<TScenario, TArtifact>,
  runDir: string,
  storage: CampaignStorage,
): SearchLedgerBinding {
  const path = `${runDir}/search/ledger.jsonl`
  const searchId = `optimization-${createHash('sha256').update(runDir).digest('hex').slice(0, 16)}`
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
  const ledger = runDir.startsWith('mem://')
    ? openSearchLedger({ path, searchId, store: storage })
    : openSearchLedger({ path, searchId })
  return { ledger, identity }
}

function artifactKindOf(surface: MutableSurface): SearchArtifactKind {
  return typeof surface === 'object' && surface.kind === 'code' ? 'code' : 'prompt'
}

function receiptKey(receipt: CostReceipt): string {
  return receipt.callId
}

/** A proposal that made a paid call ran a model; one that made none ran code. */
function proposalExecution(
  receipts: ReadonlyArray<CostReceipt>,
  provider: string,
  source: SearchOperationRecordedEvent['execution']['source'],
): SearchOperationRecordedEvent['execution'] {
  const model = receipts.find((receipt) => receipt.channel !== 'judge')?.model
  if (model === undefined) return { kind: 'deterministic', source }
  return { kind: 'model', model: modelIdentity(model, provider), source }
}

function modelIdentity(model: string, provider: string): SearchModelIdentity {
  return modelHasSnapshot(model)
    ? { provider, snapshot: model }
    : { provider, alias: model, unknown: 'the provider reported a moving alias, not a snapshot' }
}

function cellModel<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
  fallback: SearchModelIdentity,
): SearchModelIdentity {
  return cell.resolvedModel === undefined
    ? fallback
    : modelIdentity(cell.resolvedModel, fallback.provider)
}

function cellOutcome<TArtifact>(cell: CampaignCellResult<TArtifact>): SearchTaskOutcome {
  const quality = projectCampaignCellQuality(cell)
  if (quality.score === undefined) {
    return {
      status: 'errored',
      metrics: {},
      error: {
        code: cell.errorStage ?? 'unscored',
        message: cell.error ?? 'the cell produced no complete judge score',
        retryable: false,
      },
    }
  }
  const metrics: Record<string, number> = { composite: quality.score }
  for (const [judge, score] of Object.entries(quality.successfulJudgeScores)) {
    metrics[`judge.${judge}`] = score.composite
  }
  return { status: 'passed', score: quality.score, metrics }
}

function cellAccounting<TArtifact>(cell: CampaignCellResult<TArtifact>): SearchAttemptAccounting {
  const usage = cell.tokenUsage
  return {
    tokens:
      usage.tokensKnown === false
        ? { status: 'unknown', reason: 'a paid call in this cell reported no token usage' }
        : {
            status: 'known',
            inputTokens: usage.input,
            outputTokens: usage.output,
            cachedTokens: 0,
          },
    cost:
      cell.costProvenance.kind === 'uncaptured'
        ? {
            status: 'unknown',
            knownLowerBoundUsd: cell.costUsd,
            reason: 'the cell recorded spend without a provider receipt',
          }
        : {
            status: 'known',
            usd: cell.costUsd,
            source: cell.costProvenance.kind === 'observed' ? 'provider' : 'pricing-table',
          },
  }
}

function receiptAccounting(receipts: ReadonlyArray<CostReceipt>): SearchAttemptAccounting {
  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let usd = 0
  let tokensKnown = true
  let costKnown = true
  for (const receipt of receipts) {
    if (receipt.usageUnknown === true) tokensKnown = false
    inputTokens += receipt.inputTokens
    outputTokens += receipt.outputTokens
    cachedTokens += receipt.cachedTokens ?? 0
    if (receipt.costUnknown) costKnown = false
    else usd += receipt.costUsd
  }
  return {
    tokens: tokensKnown
      ? { status: 'known', inputTokens, outputTokens, cachedTokens }
      : { status: 'unknown', reason: 'a candidate-generation call reported no token usage' },
    cost: costKnown
      ? { status: 'known', usd, source: usd === 0 ? 'free' : 'provider' }
      : {
          status: 'unknown',
          knownLowerBoundUsd: usd,
          reason: 'a candidate-generation call recorded no provider cost',
        },
  }
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

/** A scored campaign as a frontier member: per-scenario composite objectives. */
function toParetoParent<TArtifact, TScenario extends Scenario>(
  surface: MutableSurface,
  campaign: CampaignResult<TArtifact, TScenario>,
  generation: number,
  label?: string,
): ParetoParent {
  const objectives: Record<string, number> = {}
  for (const { scenarioId, composite } of campaignBreakdown(campaign).scenarios) {
    objectives[scenarioId] = composite
  }
  const parent: ParetoParent = {
    surface,
    surfaceHash: surfaceHash(surface),
    objectives,
    composite: campaignMeanComposite(campaign),
    generation,
  }
  if (label) parent.label = label
  return parent
}

/** The non-dominated set over the per-scenario objective vectors. */
function computeParetoFrontier(scored: ParetoParent[]): ParetoParent[] {
  if (scored.length <= 1) return [...scored]
  const ids = new Set<string>()
  for (const p of scored) for (const id of Object.keys(p.objectives)) ids.add(id)
  if (ids.size === 0) return [...scored]
  const objectives: Objective<ParetoParent>[] = [...ids].map((id) => ({
    name: id,
    direction: 'maximize',
    value: (p) => p.objectives[id] ?? Number.NEGATIVE_INFINITY,
  }))
  return paretoFrontier(scored, objectives).frontier
}

function toScoredSurfaceOutcome<TArtifact, TScenario extends Scenario>(
  hash: string,
  campaign: CampaignResult<TArtifact, TScenario>,
  coverage: CampaignCoverage,
  generation: number,
): ScoredSurfaceOutcome {
  const breakdown = campaignBreakdown(campaign)
  return {
    split: 'search',
    generation,
    surfaceHash: hash,
    composite: campaignMeanComposite(campaign),
    dimensions: breakdown.dimensions,
    scenarios: breakdown.scenarios,
    coverage: {
      expectedCells: coverage.expectedCellIds.length,
      scorableCells: coverage.scorableCellIds.length,
    },
  }
}
