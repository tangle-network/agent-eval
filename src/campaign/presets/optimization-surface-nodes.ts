/** Surface-node campaigns, cached cell adoption, and proposer history from the search ledger. */

import { join } from 'node:path'
import type { CostLedgerHandle } from '../../cost-ledger'
import { type Objective, paretoFrontier } from '../../pareto'
import { computeManifestHash } from '../campaign-manifest'
import { computeAggregates } from '../cell-aggregates'
import { cellAttemptDirectory, cellCachePath, cellDirectory } from '../cell-schedule'
import {
  type CampaignCoverage,
  campaignCoverage,
  campaignScenarioIdentity,
  campaignSplitDigest,
} from '../coverage'
import {
  type CampaignCellFailureReceipt,
  type RunCampaignOptions,
  runCampaign,
} from '../run-campaign'
import {
  campaignBreakdown,
  campaignMeanComposite,
  campaignMeanCompositeOrNull,
} from '../score-utils'
import { campaignCellSearchResult } from '../search-campaign-cell'
import {
  type SearchArtifactCodec,
  type SearchCellResult,
  type SearchCellWork,
  type SearchProposalBlob,
  searchExpansionIndex,
  searchPolicyView,
} from '../search-kernel'
import { type SearchRecorder, surfaceDiff, surfaceNode } from '../search-ledger-recording'
import type { SearchExecutionIdentity } from '../search-ledger-types'
import type { SearchPolicy } from '../search-policy'
import type { SearchStateView } from '../search-state'
import { type CampaignStorage, fsCampaignStorage } from '../storage'
import { surfaceDispatchRef, surfaceHash } from '../surface-identity'
import type {
  CampaignCellResult,
  CampaignResult,
  GenerationCandidate,
  GenerationRecord,
  JudgeConfig,
  MutableSurface,
  ParetoParent,
  Scenario,
  ScoredSurfaceOutcome,
} from '../types'
import type { RunOptimizationOptions } from './optimization-run-input'

/** A mutable surface as a search artifact. */
export const surfaceCodec: SearchArtifactCodec<MutableSurface> = {
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
export class SurfaceNodes<TScenario extends Scenario, TArtifact> {
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
  /** Cells this process ran or adopted, by node, keyed `scenarioId:rep`. */
  private readonly cells = new Map<string, Map<string, CampaignCellResult<TArtifact>>>()

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

  /** `<runDir>/baseline` for the root, `<runDir>/candidates/<surfaceHash>`
   * for every other node: content-addressed, so a cell's directory needs no
   * ledger read and one surface keeps one cache across the run's searches. */
  nodeDir(surface: MutableSurface, root: boolean): string {
    return root ? `${this.runDir}/baseline` : `${this.runDir}/candidates/${surfaceHash(surface)}`
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
      // The baseline, proposed again, is a re-proposal of the seed.
      if (nodeId === undefined || nodeId === state.rootNodeId || ids.includes(nodeId)) continue
      if (this.origin(state, nodeId).expansion === expansion) ids.push(nodeId)
    }
    return ids
  }

  /**
   * The scored attempt of a cell an earlier process ran, from its node's
   * cache; null otherwise, so the kernel runs the cell. A failure is not
   * adopted: the stop that interrupted the earlier process may have caused it.
   */
  async adoptCell(work: SearchCellWork<MutableSurface>): Promise<SearchCellResult | null> {
    if (work.stage === 'root' && this.premeasured) return this.premeasuredCell(work)
    const dir = this.nodeDir(work.artifact, work.stage === 'root')
    const cached = this.storage.read(cellCachePath(dir, `${work.taskId}:${work.rep}`))
    const cell =
      cached === undefined ? undefined : (JSON.parse(cached) as CampaignCellResult<TArtifact>)
    if (cell?.manifestHash !== this.manifestFor(work.artifact)) return null
    this.remember(work.nodeId, cell)
    return this.cellResult(cell, work)
  }

  /** Run one cell as a one-cell campaign in its node's directory; a cached
   * cell is read back, not dispatched again. */
  async runCell(
    work: SearchCellWork<MutableSurface>,
    scenarios: ReadonlyMap<string, TScenario>,
  ): Promise<SearchCellResult> {
    if (work.stage === 'root' && this.premeasured) return this.premeasuredCell(work)
    if (!scenarios.has(work.taskId)) {
      throw new Error(`runOptimization: cell ${work.cellId} names unknown scenario ${work.taskId}`)
    }
    const dir = this.nodeDir(work.artifact, work.stage === 'root')
    const campaign = await this.campaignRun(dir, work.artifact, {
      signal: work.signal,
      costPhase: work.stage === 'root' ? 'search.baseline' : 'search.candidate',
      cellFilter: ({ scenario, rep }) => scenario.id === work.taskId && rep === work.rep,
    })
    const cell = campaign.cells[0]
    if (!cell) throw new Error(`runOptimization: cell ${work.cellId} produced no campaign cell`)
    this.remember(work.nodeId, cell)
    return this.cellResult(cell, work)
  }

  /** The node's campaign over the cells the ledger settled: the cells this
   * process ran, else their cached results or failure receipts. */
  campaign(state: SearchStateView, nodeId: string): CampaignResult<TArtifact, TScenario> {
    const root = nodeId === state.rootNodeId
    if (root && this.premeasured) return this.premeasured
    const surface = this.surface(state, nodeId)
    const dir = this.nodeDir(surface, root)
    const settled = state
      .cells({ nodeId })
      .filter((cell) => cell.attempts > 0)
      .map((cell) => ({ taskId: cell.taskId, rep: cell.rep }))
    const key = settled
      .map(({ taskId, rep }) => `${taskId}:${rep}`)
      .sort()
      .join('\n')
    const held = this.campaigns.get(nodeId)
    if (held?.cells === key) return held.campaign
    const known = this.cells.get(nodeId)
    const cells = settled.map(({ taskId, rep }) => {
      const cell = known?.get(`${taskId}:${rep}`) ?? this.storedCell(dir, surface, taskId, rep)
      if (!cell) {
        throw new Error(
          `runOptimization: cell ${taskId}:${rep} of node ${nodeId} settled, but ${dir} holds neither its cached result nor its failure receipt`,
        )
      }
      return cell
    })
    cells.sort((a, b) => (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0))
    const reps = this.opts.reps ?? 1
    const seed = this.opts.seed ?? 42
    const judges = this.opts.judges ?? []
    const now = new Date().toISOString()
    const durationMs = cells.reduce((sum, cell) => sum + cell.durationMs, 0)
    const campaign: CampaignResult<TArtifact, TScenario> = {
      manifestHash: this.manifestFor(surface),
      splitDigest: campaignSplitDigest(this.opts.scenarios, reps),
      seed,
      reps,
      startedAt: now,
      endedAt: now,
      durationMs,
      cells,
      aggregates: computeAggregates(
        cells,
        judges as unknown as JudgeConfig<TArtifact>[],
        seed,
        this.costLedger.summary({ tags: { runDir: dir } }),
      ),
      runDir: dir,
      artifactsByPath: {},
      scenarios: this.opts.scenarios.map(campaignScenarioIdentity),
    }
    this.campaigns.set(nodeId, { cells: key, campaign })
    return campaign
  }

  outcome(state: SearchStateView, nodeId: string): ScoredSurfaceOutcome {
    const campaign = this.campaign(state, nodeId)
    const reps = this.opts.reps ?? 1
    const coverage = campaignCoverage(
      campaign.cells,
      this.opts.scenarios,
      reps,
      (this.opts.judges?.length ?? 0) > 0,
    )
    const expansion =
      nodeId === state.rootNodeId
        ? -1
        : this.generationOf(state, this.origin(state, nodeId).expansion)
    return toScoredSurfaceOutcome(
      surfaceHash(this.surface(state, nodeId)),
      campaign,
      coverage,
      expansion,
    )
  }

  /** The Pareto frontier over every measured, complete node. */
  frontier(state: SearchStateView): ParetoParent[] {
    const scored: ParetoParent[] = []
    for (const node of state.nodes()) {
      if (node.status === 'invalid' || node.cellCount === 0) continue
      const cells = state.cells({ nodeId: node.nodeId })
      if (cells.some((cell) => cell.attempts === 0 && cell.cancelled === null)) continue
      if (cells.some((cell) => cell.score === null)) continue
      const campaign = this.campaign(state, node.nodeId)
      const edge = state.edge(node.edgeIds[0]!)!
      scored.push(
        toParetoParent(
          this.surface(state, node.nodeId),
          campaign,
          node.nodeId === state.rootNodeId
            ? -1
            : this.generationOf(state, this.origin(state, node.nodeId).expansion),
          edge.operator === 'seed' ? undefined : edge.label || undefined,
        ),
      )
    }
    return computeParetoFrontier(scored)
  }

  /** Kernel expansions that registered a candidate, in order: generation g
   * is `generations(state)[g]`. */
  generations(state: SearchStateView): number[] {
    const expansions: number[] = []
    for (let expansion = 0; state.operation(`expand-${expansion}`); expansion++) {
      if (this.expansionNodes(state, expansion).length > 0) expansions.push(expansion)
    }
    return expansions
  }

  /** One record per generation, with its candidates and the one that took
   * the lead, if any. */
  history(state: SearchStateView, policy: SearchPolicy): GenerationRecord[] {
    const records: GenerationRecord[] = []
    const measured = (nodeId: string) =>
      state.node(nodeId)!.status !== 'invalid' &&
      state.cells({ nodeId }).every((cell) => cell.attempts > 0 || cell.cancelled !== null)
    const screened: string[] = [state.rootNodeId!]
    let leader = policy.leader(searchPolicyView(state, { screened, screening: 0, expansions: 0 }))
    for (const [generation, expansion] of this.generations(state).entries()) {
      const nodeIds = this.expansionNodes(state, expansion)
      screened.push(...nodeIds.filter(measured))
      screened.sort((a, b) => state.node(a)!.ordinal - state.node(b)!.ordinal)
      const next = policy.leader(
        searchPolicyView(state, { screened, screening: 0, expansions: expansion + 1 }),
      )
      const candidates: GenerationCandidate[] = []
      for (const nodeId of nodeIds) {
        candidates.push(this.candidate(state, nodeId, expansion))
      }
      records.push({
        generationIndex: generation,
        candidates,
        promoted:
          next !== leader && nodeIds.includes(next) ? [surfaceHash(this.surface(state, next))] : [],
      })
      leader = next
    }
    return records
  }

  private candidate(
    state: SearchStateView,
    nodeId: string,
    expansion: number,
  ): GenerationCandidate {
    const campaign = this.campaign(state, nodeId)
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

  private generationOf(state: SearchStateView, expansion: number): number {
    return this.generations(state).indexOf(expansion)
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
    runDir: string,
    surface: MutableSurface,
    input: {
      signal?: AbortSignal
      costPhase: string
      cellFilter: NonNullable<RunCampaignOptions<TScenario, TArtifact>['cellFilter']>
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
      signal: input.signal ?? this.opts.signal,
      costLedger: this.costLedger,
      costPhase: input.costPhase,
      dispatchRef: surfaceDispatchRef(surface, this.opts.dispatchRef),
      dispatch: (scenario, ctx) => dispatchWithSurface(surface, scenario, ctx),
      runDir,
      cellFilter: input.cellFilter,
      resumable: true,
      maxConcurrency: 1,
    })
  }

  private premeasuredCell(work: SearchCellWork<MutableSurface>): SearchCellResult {
    const cell = this.premeasured!.cells.find(
      (candidate) => candidate.scenarioId === work.taskId && candidate.rep === work.rep,
    )
    if (!cell) {
      throw new Error(`runOptimization: premeasured baseline lacks ${work.taskId}:${work.rep}`)
    }
    return this.cellResult(cell, work)
  }

  /** A cell's result as its campaign stored it for this surface: the cache of
   * a scored cell, the final failure receipt of a failed one. A result another
   * surface left in the same directory does not count. */
  private storedCell(
    dir: string,
    surface: MutableSurface,
    taskId: string,
    rep: number,
  ): CampaignCellResult<TArtifact> | undefined {
    const cellId = `${taskId}:${rep}`
    const manifestHash = this.manifestFor(surface)
    const cellDir = cellDirectory(dir, cellId)
    const latest = this.storage.read(join(cellDir, 'latest-attempt.json'))
    if (latest !== undefined) {
      const attempt: NonNullable<CampaignCellResult<TArtifact>['attempt']> = JSON.parse(latest)
      const attemptDir = cellAttemptDirectory(cellDir, attempt)
      const result = this.storage.read(join(attemptDir, 'result.json'))
      const receipt = this.storage.read(join(attemptDir, 'failure-receipt.json'))
      const cell: CampaignCellResult<TArtifact> | undefined =
        result !== undefined
          ? JSON.parse(result)
          : receipt !== undefined
            ? (JSON.parse(receipt) as CampaignCellFailureReceipt<TArtifact>).cell
            : undefined
      return cell?.manifestHash === manifestHash ? cell : undefined
    }
    // Historical cells predate execution-scoped directories and stay read-only.
    const cached = this.storage.read(cellCachePath(dir, cellId))
    const scored =
      cached === undefined ? undefined : (JSON.parse(cached) as CampaignCellResult<TArtifact>)
    if (scored?.manifestHash === manifestHash) return scored
    const receipt = this.storage.read(join(cellDirectory(dir, cellId), 'failure-receipt.json'))
    const failed =
      receipt === undefined
        ? undefined
        : (JSON.parse(receipt) as CampaignCellFailureReceipt<TArtifact>).cell
    return failed?.manifestHash === manifestHash ? failed : undefined
  }

  private manifestFor(surface: MutableSurface): string {
    return computeManifestHash({
      scenarios: this.opts.scenarios,
      judges: this.opts.judges ?? [],
      dispatchRef: surfaceDispatchRef(surface, this.opts.dispatchRef),
      seed: this.opts.seed ?? 42,
      reps: this.opts.reps ?? 1,
    })
  }

  private remember(nodeId: string, cell: CampaignCellResult<TArtifact>): void {
    const cells = this.cells.get(nodeId) ?? new Map<string, CampaignCellResult<TArtifact>>()
    cells.set(`${cell.scenarioId}:${cell.rep}`, cell)
    this.cells.set(nodeId, cells)
  }

  private cellResult(
    cell: CampaignCellResult<TArtifact>,
    work: SearchCellWork<MutableSurface>,
  ): SearchCellResult {
    return campaignCellSearchResult(cell, { execution: this.execution, lane: work.lane })
  }
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
