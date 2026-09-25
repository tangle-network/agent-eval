/**
 * How `runOptimization` writes its search into a search ledger.
 *
 * The loop's scenarios are the proposer's feedback, so they are the train
 * split; the loop has no private selection split and no sealed test split, and
 * its promotions are budget decisions that make no claim. The baseline is the
 * seeded root. Each generation is one candidate-generation operation, each
 * candidate a node with an `explicit` edge from the parent the loop mutated,
 * and each designed campaign cell a cell, allocated before its campaign runs
 * and settled when the campaign returns.
 */

import type { CostLedgerHandle, CostReceipt } from '../../cost-ledger'
import { hashCanonical } from '../../ledger-core/canonical'
import { modelHasSnapshot } from '../../run-record'
import type { SearchHistoryReceipt } from '../search-history-receipt'
import {
  developmentClaim,
  type SearchLedgerBinding,
  SearchRecorder,
  surfaceDiff,
  surfaceNode,
} from '../search-ledger-recording'
import type {
  SearchAttemptAccounting,
  SearchCloseReason,
  SearchExecutionIdentity,
  SearchModelIdentity,
  SearchTask,
  SearchTaskOutcome,
} from '../search-ledger-types'
import type { CampaignStorage } from '../storage'
import type { CampaignCellResult, MutableSurface, Scenario } from '../types'

export class OptimizationSearch {
  private readonly recorder: SearchRecorder
  private readonly binding: SearchLedgerBinding
  private readonly costLedger: CostLedgerHandle
  private readonly scenarioIds: readonly string[]
  private readonly reps: number
  private readonly identity: SearchExecutionIdentity
  private readonly proposerName: string
  private proposalReceiptCount = 0

  private constructor(args: {
    recorder: SearchRecorder
    binding: SearchLedgerBinding
    costLedger: CostLedgerHandle
    scenarioIds: readonly string[]
    reps: number
    identity: SearchExecutionIdentity
    proposerName: string
  }) {
    this.recorder = args.recorder
    this.binding = args.binding
    this.costLedger = args.costLedger
    this.scenarioIds = args.scenarioIds
    this.reps = args.reps
    this.identity = args.identity
    this.proposerName = args.proposerName
  }

  /** Open the search and record the measured baseline as its seeded root. */
  static async open<TScenario extends Scenario, TArtifact>(args: {
    binding: SearchLedgerBinding
    storage: CampaignStorage
    costLedger: CostLedgerHandle
    scenarios: ReadonlyArray<TScenario>
    reps: number
    seed: number
    splitDigest: `sha256:${string}`
    proposerName: string
    expansion: string
    maxUsd: number | null
    baselineSurface: MutableSurface
    baselineCells: ReadonlyArray<CampaignCellResult<TArtifact>>
  }): Promise<{ search: OptimizationSearch; rootNodeId: string }> {
    const { binding } = args
    const identity: SearchExecutionIdentity = {
      model: binding.identity.model,
      agent: binding.identity.agent,
      benchmark: { uri: 'campaign://scenarios', revision: args.splitDigest },
    }
    const train: SearchTask[] = args.scenarios.map((scenario) => ({
      taskId: scenario.id,
      unitId: scenario.id,
      source: { uri: `scenario://${scenario.id}`, revision: hashCanonical(scenario) },
    }))
    const recorder = await SearchRecorder.open(
      { ledger: binding.ledger, storage: args.storage },
      {
        subject: binding.identity.subject ?? args.proposerName,
        process: { name: 'runOptimization', executionRef: binding.identity.search },
        artifactKind: 'prompt',
        objective: {
          metric: 'composite',
          direction: 'maximize',
          judge: binding.identity.judge ?? {
            unknown: 'runOptimization receives its judges as functions without a pinned source',
          },
          claim: binding.identity.claim ?? developmentClaim(args.splitDigest),
        },
        splits: { train, selection: [], test: [], heldOutUnits: true },
        policy: { expansion: args.expansion, allocation: 'uniform', seed: args.seed },
        budget: {
          maxUsd: args.maxUsd,
          maxCells: null,
          maxNodes: null,
          deadline: null,
          maxConcurrency: null,
          reservedClaimUsd: 0,
        },
        containment: null,
        derivedFrom: null,
        identity,
      },
    )
    const search = new OptimizationSearch({
      recorder,
      binding,
      costLedger: args.costLedger,
      scenarioIds: args.scenarios.map((scenario) => scenario.id),
      reps: args.reps,
      identity,
      proposerName: args.proposerName,
    })
    const root = await recorder.registerNode(surfaceNode(recorder, args.baselineSurface))
    await recorder.recordEdge({
      childNodeId: root.nodeId,
      parents: [],
      operator: 'seed',
      attribution: 'explicit',
      proposer: null,
      proposalKey: 'baseline',
      rationale: { unknown: 'the baseline is the caller-supplied starting surface' },
      diffs: [],
      label: 'baseline',
    })
    await search.recordCells(root.nodeId, 'root', args.baselineCells)
    return { search, rootNodeId: root.nodeId }
  }

  /** Start one generation's candidate-generation operation, before `propose()`. */
  async startGeneration(generation: number): Promise<void> {
    await this.recorder.startOperation({
      operationId: generationOperationId(generation),
      operationKind: 'candidate-generation',
    })
  }

  /** Record the generation's proposal: its operation, then one node and edge per candidate. */
  async recordProposal(input: {
    generation: number
    parent: { nodeId: string; surface: MutableSurface; composite: number | null }
    selectionRule: string
    candidates: ReadonlyArray<{ surface: MutableSurface; label: string; rationale: string }>
  }): Promise<string[]> {
    const operationId = generationOperationId(input.generation)
    await this.recorder.recordOperation({
      operationId,
      operationKind: 'candidate-generation',
      execution: this.binding.identity.proposer,
      outcome: { status: 'completed' },
      accounting: this.proposalAccounting(),
    })
    const nodeIds: string[] = []
    for (const [index, candidate] of input.candidates.entries()) {
      const { nodeId } = await this.recorder.registerNode(
        surfaceNode(this.recorder, candidate.surface),
      )
      await this.recorder.recordEdge({
        childNodeId: nodeId,
        parents: [input.parent.nodeId],
        operator: 'improve',
        attribution: 'explicit',
        proposer: {
          kind: 'optimizer',
          name: this.proposerName,
          operationId,
          source: this.binding.identity.proposer.source,
        },
        proposalKey: `gen-${input.generation}:candidate-${index}`,
        selection: {
          rule: input.selectionRule,
          evidence:
            input.parent.composite === null ? {} : { parentComposite: input.parent.composite },
        },
        rationale: candidate.rationale,
        diffs: [surfaceDiff(this.recorder, input.parent.surface, candidate.surface)],
        label: candidate.label,
      })
      nodeIds.push(nodeId)
    }
    return nodeIds
  }

  /** Close a generation whose proposer produced nothing or failed. */
  async failGeneration(generation: number, message: string): Promise<void> {
    await this.recorder.recordOperation({
      operationId: generationOperationId(generation),
      operationKind: 'candidate-generation',
      execution: this.binding.identity.proposer,
      outcome: { status: 'failed', failure: { code: 'no-candidates', message } },
      accounting: this.proposalAccounting(),
    })
  }

  /** Allocate every designed cell of a node before its campaign runs. */
  async allocate(nodeId: string): Promise<void> {
    for (const taskId of this.scenarioIds) {
      for (let rep = 0; rep < this.reps; rep++) {
        await this.recorder.allocateCell({ nodeId, taskId, split: 'train', rep, stage: 'train' })
      }
    }
  }

  /** Settle a node's campaign cells; allocates any the campaign ran beyond the design. */
  async recordCells<TArtifact>(
    nodeId: string,
    stage: 'root' | 'train',
    cells: ReadonlyArray<CampaignCellResult<TArtifact>>,
  ): Promise<void> {
    for (const cell of cells) {
      const cellId = await this.recorder.allocateCell({
        nodeId,
        taskId: cell.scenarioId,
        split: 'train',
        rep: cell.rep,
        stage,
      })
      await this.recorder.settleCell({
        cellId,
        attempt: 1,
        outcome: cellOutcome(cell),
        accounting: cellAccounting(cell),
        identity: { ...this.identity, model: this.cellModel(cell) },
        wallMs: cell.durationMs,
        traceRef: { unknown: 'runCampaign reports no trace id per cell' },
      })
    }
  }

  /**
   * Decide every node and close. The winner is selected; every other node is
   * rejected. Allocated cells a campaign never returned are cancelled.
   */
  async finish(input: {
    winnerNodeId: string
    incompleteNodeIds: ReadonlySet<string>
    reason: SearchCloseReason
    runId: string
  }): Promise<SearchHistoryReceipt> {
    const state = await this.recorder.state()
    const openCells = state.cells().filter((cell) => cell.attempts === 0 && !cell.cancelled)
    for (const cell of openCells) {
      await this.recorder.cancelCell({ cellId: cell.cellId, reason: 'aborted' })
    }
    for (const node of (await this.recorder.state()).nodes()) {
      await this.recorder.decideNode({
        nodeId: node.nodeId,
        decision:
          node.nodeId === input.winnerNodeId ? { status: 'selected' } : { status: 'rejected' },
        rule: 'incumbent',
        reason:
          node.nodeId === input.winnerNodeId
            ? 'the incumbent when the loop stopped'
            : input.incompleteNodeIds.has(node.nodeId)
              ? 'the candidate missed a designed cell and could not be ranked'
              : 'the candidate did not beat the incumbent',
      })
    }
    await this.recorder.close({ reason: input.reason, claim: null })
    return this.recorder.receipt({ producerId: this.proposerName, runId: input.runId })
  }

  /** Spend booked to candidate generation since the previous generation. */
  private proposalAccounting(): SearchAttemptAccounting {
    const receipts = this.costLedger.list({ phase: 'search.proposal' })
    const fresh = receipts.slice(this.proposalReceiptCount)
    this.proposalReceiptCount = receipts.length
    return receiptAccounting(fresh)
  }

  private cellModel<TArtifact>(cell: CampaignCellResult<TArtifact>): SearchModelIdentity {
    const resolved = cell.resolvedModel
    if (resolved === undefined) return this.identity.model
    const provider = this.identity.model.provider
    return modelHasSnapshot(resolved)
      ? { provider, snapshot: resolved }
      : {
          provider,
          alias: resolved,
          unknown: 'the provider reported a moving alias, not a snapshot',
        }
  }
}

function generationOperationId(generation: number): string {
  return `candidate-generation:gen-${generation}`
}

function cellOutcome<TArtifact>(cell: CampaignCellResult<TArtifact>): SearchTaskOutcome {
  const scores = Object.entries(cell.judgeScores).filter(
    ([, score]) => score.failed !== true && Number.isFinite(score.composite),
  )
  if (cell.error !== undefined || scores.length === 0) {
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
  const composite = scores.reduce((sum, [, score]) => sum + score.composite, 0) / scores.length
  const metrics: Record<string, number> = { composite }
  for (const [judge, score] of scores) metrics[`judge.${judge}`] = score.composite
  return { status: 'passed', score: composite, metrics }
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
