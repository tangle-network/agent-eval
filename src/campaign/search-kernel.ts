/**
 * The search kernel: one event-driven loop that every optimizer runs on.
 *
 * It separates three decisions that a generation loop fuses: where to expand
 * (the `SearchPolicy`), where to spend rollouts (the `SearchAllocator`), and
 * what to claim (the claim step, on the sealed test split). There is no
 * generation barrier: a lane that frees up takes the next allocated cell, and
 * the policy proposes when no cell waits and the budget admits a screen.
 *
 * Every step appends to the search ledger before the kernel acts on it, and the
 * ledger is the only checkpoint. Restarting the kernel on the same ledger
 * replays it and continues: an operation that started without a result is
 * recorded as failed with an unknown cost; a recorded proposal whose children
 * were not all registered is finished from its stored output; an allocated
 * cell without an outcome is first offered to `executor.adopt`, then run.
 *
 * The admission rule is the ledger's: committed spend, open reservations, the
 * unspent claim reserve and a new reservation stay within the cap. The kernel
 * checks it before it asks, prices an expansion (one proposal plus one screen)
 * before the proposer runs, and records spend above a reservation as
 * overspend, never refused.
 */

import { hashCanonical } from '../ledger-core/canonical'
import { redactText } from '../trace/redact'
import type { SearchAllocator, SearchCellPlan } from './allocation'
import { estimateNode } from './estimate-node'
import { FileSearchLedger } from './search-ledger'
import type {
  RegisterSearchNodeInput,
  SearchRecorder,
  SettleSearchCellInput,
} from './search-ledger-recording'
import type {
  NodeEstimate,
  SearchArtifactRef,
  SearchAttemptAccounting,
  SearchCellStage,
  SearchCloseReason,
  SearchEdgeOperator,
  SearchOperationRecordedEvent,
  SearchProposerKind,
  SearchReservation,
  SearchSourceRef,
  SearchSplit,
  SearchUnknown,
} from './search-ledger-types'
import type { SearchPolicy, SearchPolicyView } from './search-policy'
import {
  type SearchCell,
  type SearchNode,
  type SearchStateView,
  searchCellId,
} from './search-state'
import { acquireSingleRunLock } from './single-run-lock'

/**
 * Every rule the kernel's decisions depend on. Its digest is the kernel's
 * revision in a ledger's `process.executionRef`; change a value here whenever
 * a rule changes, so the revision moves with it.
 */
const KERNEL_DEFINITION = {
  name: 'tangle.search-kernel.2026-09',
  dispatch:
    'claim, then rung and root, then screen, then train; first allocated first within a stage',
  expansion:
    'when no cell waits, fewer than twice the lanes capacity run, and the cap admits one proposal and its expected screens',
  reservation: {
    hard: 'the lane per-cell maximum',
    estimate: '1.5 times the p99 of the lane settled cells once 20 settled, else the lane prior',
  },
  retries: 'a retryable errored attempt runs again, up to maxAttempts',
  resume:
    'an unrecorded operation is recorded failed at an unknown cost with floor 0; a recorded proposal is finished from its stored output; an unsettled cell is offered to adopt before it runs',
  writers: 'one kernel per ledger file on a host, by a pid lock beside the ledger',
  close:
    'the policy leader is selected when it has a scored cell; every other undecided node is rejected',
} as const

/** The kernel every `runSearch` ledger names as its search implementation. */
export const SEARCH_KERNEL_SOURCE: SearchSourceRef = {
  uri: 'npm:@tangle-network/agent-eval#runSearch',
  revision: hashCanonical(KERNEL_DEFINITION),
}

const USD_TOLERANCE = 1e-9
/** Settled cells a lane needs before its own cost distribution sets its estimate. */
const ESTIMATE_FROM_CELLS = 20
const ESTIMATE_MARGIN = 1.5
const DEFAULT_MAX_ATTEMPTS = 3
/** Dispatch order: claim cells first, then rungs and the root, then screens, then train. */
const STAGE_PRIORITY: Record<SearchCellStage, number> = {
  claim: 0,
  rung: 1,
  root: 1,
  screen: 2,
  train: 3,
  external: 3,
}

/** An execution lane: a pool of slots whose cells share a cost rule. */
export interface SearchLane {
  name: string
  /** Cells the lane runs at once. */
  capacity: number
  /** `hard`: the lane enforces `cellUsd` as each cell's maximum. `estimate`:
   * it cannot, and the kernel holds an estimate, recording any overshoot. */
  costCap: 'hard' | 'estimate'
  /** The enforced per-cell maximum of a hard lane; the prior estimate of an
   * estimate lane until it has settled enough cells to estimate its own. */
  cellUsd: number
}

/** One attempt at one cell, as the kernel hands it to an executor. */
export interface SearchCellWork<TArtifact> {
  searchId: string
  cellId: string
  nodeId: string
  taskId: string
  unitId: string
  split: SearchSplit
  rep: number
  stage: SearchCellStage
  lane: string
  attempt: number
  /** `cellId:attempt`: the id an executor keys the attempt's run by. */
  runId: string
  artifact: TArtifact
  signal: AbortSignal
}

/** What an attempt produced: everything `cell-settled` records except the
 * coordinates the kernel owns. An environment fault is an `errored` outcome,
 * not a rejection; a rejection stops the search. */
export type SearchCellResult = Omit<SettleSearchCellInput, 'cellId' | 'attempt'>

/** The executor port: lanes, placement, running a cell, and adopting an
 * attempt an earlier kernel process started. */
export interface SearchExecutor<TArtifact> {
  lanes(): readonly SearchLane[]
  /** The lane a planned cell runs on. */
  place(cell: SearchCellPlan & { nodeId: string }): string
  run(work: SearchCellWork<TArtifact>): Promise<SearchCellResult>
  /** The result of `work.runId` if the executor already has it, else null.
   * Called before the first dispatch of a cell the ledger shows unsettled when
   * the kernel starts, so a restart does not run an attempt twice. */
  adopt(work: SearchCellWork<TArtifact>): Promise<SearchCellResult | null>
}

/** How a search stores, compares and restores its artifacts. */
export interface SearchArtifactCodec<TArtifact> {
  /** The artifact as a content-addressed node; stores its bytes. */
  node(recorder: SearchRecorder, artifact: TArtifact): RegisterSearchNodeInput
  /** The parent-to-child diff, stored as a blob, or why there is none. */
  diff(
    recorder: SearchRecorder,
    parent: TArtifact,
    child: TArtifact,
  ): SearchArtifactRef | SearchUnknown
  /** The artifact a node holds, read back from its stored bytes. */
  load(recorder: SearchRecorder, node: SearchNode): TArtifact
}

export interface SearchProposalRequest<TArtifact> {
  expansion: number
  operationId: string
  operator: Exclude<SearchEdgeOperator, 'seed' | 'derive'>
  /** The parents the policy chose, primary first. */
  parents: ReadonlyArray<{ nodeId: string; artifact: TArtifact }>
  /** The node the search keeps now. */
  leader: string
  signal: AbortSignal
}

/** One child a proposal returned. */
export interface SearchProposedChild<TArtifact> {
  artifact: TArtifact
  label: string
  /** The proposer's reason; redacted with the share profile before it is stored. */
  rationale: string
  /** Typed JSON the proposer attaches to the child, stored with the proposal
   * and never interpreted by the kernel. */
  attribution?: Readonly<Record<string, unknown>>
}

export interface SearchProposalResult<TArtifact> {
  children: ReadonlyArray<SearchProposedChild<TArtifact>>
  /** Set when the proposer judges the search converged; expansion stops. */
  stop?: string
  /** What generated the children; default the port's `execution`. */
  execution?: SearchOperationRecordedEvent['execution']
  accounting: SearchAttemptAccounting
}

/** The proposer port: derives children from the parents the policy chose. */
export interface SearchProposerPort<TArtifact> {
  readonly name: string
  readonly kind: SearchProposerKind
  readonly source: SearchSourceRef
  readonly execution: SearchOperationRecordedEvent['execution']
  /** Prior hold for one proposal until 20 proposals have settled. Default 0. */
  readonly reservationUsd?: number
  /** Children one proposal usually returns, to price an expansion's screens
   * before it runs. Default 1. */
  readonly childrenPerProposal?: number
  propose(request: SearchProposalRequest<TArtifact>): Promise<SearchProposalResult<TArtifact>>
}

export interface RunSearchOptions<TArtifact> {
  /** An opened recorder; its header names this policy and allocator. */
  recorder: SearchRecorder
  /** The starting artifact: the seeded root. */
  root: TArtifact
  codec: SearchArtifactCodec<TArtifact>
  policy: SearchPolicy
  allocation: SearchAllocator
  proposer: SearchProposerPort<TArtifact>
  executor: SearchExecutor<TArtifact>
  /** Refuse a child before it runs: the reason, or null to admit it. A
   * refused child is recorded, decided `invalid`, and never becomes a parent. */
  admit?: (artifact: TArtifact) => string | null
  /** Stop expanding after this many proposals. */
  maxExpansions?: number
  /** Attempts per cell for retryable environment errors. Default 3. */
  maxAttempts?: number
  /** Aborting pauses the search: in-flight cells are aborted, what settled is
   * recorded, the ledger stays open, and the call rejects. Run the kernel on
   * the same ledger again to continue. */
  signal?: AbortSignal
  /** Milliseconds since the epoch, for the deadline. Default `Date.now`. */
  now?: () => number
}

export interface SearchRunResult {
  /** The closed search. */
  state: SearchStateView
  /** The node the policy kept, decided `selected` when it has a scored cell. */
  leader: string
  reason: SearchCloseReason
}

/** Run a search to its close, or continue one from its ledger. */
export async function runSearch<TArtifact>(
  options: RunSearchOptions<TArtifact>,
): Promise<SearchRunResult> {
  return new SearchKernel(options).run()
}

/** The expansion index a kernel operation id encodes, or null. */
export function searchExpansionIndex(operationId: string): number | null {
  const match = /^expand-(\d+)$/.exec(operationId)
  return match ? Number(match[1]) : null
}

interface LaneState extends SearchLane {
  inFlight: number
  /** Queued cell ids by stage priority. */
  queues: string[][]
  settledCosts: number[]
}

type Completion =
  | { kind: 'cell'; cellId: string; attempt: number; result?: SearchCellResult; error?: unknown }
  | {
      kind: 'proposal'
      expansion: number
      operationId: string
      request: SearchProposalRequest<unknown>
      selection: { rule: string; evidence: Record<string, number> }
      result?: SearchProposalResult<unknown>
      error?: unknown
    }

/** The stored output of one proposal: enough to register its children again. */
export interface SearchProposalBlob {
  kind: 'search-proposal'
  operator: SearchProposalRequest<unknown>['operator']
  parents: string[]
  selection: { rule: string; evidence: Record<string, number> }
  children: Array<{
    node: RegisterSearchNodeInput
    diffs: Array<SearchArtifactRef | SearchUnknown>
    label: string
    rationale: string
    attribution: Readonly<Record<string, unknown>> | null
    invalid: string | null
  }>
}

class SearchKernel<TArtifact> {
  private readonly options: RunSearchOptions<TArtifact>
  private readonly recorder: SearchRecorder
  private readonly maxAttempts: number
  private readonly now: () => number
  private state!: SearchStateView
  private readonly lanes = new Map<string, LaneState>()
  private readonly inFlight = new Map<string, AbortController>()
  private proposal: Promise<void> | null = null
  private proposalController: AbortController | null = null
  private readonly completions: Completion[] = []
  private wake: (() => void) | null = null
  /** Unfinished cells per node. */
  private readonly pending = new Map<string, number>()
  /** Admitted nodes whose screen finished, in registration order. */
  private screened: string[] = []
  private readonly screenedSet = new Set<string>()
  private readonly admitted = new Set<string>()
  private readonly expansionOf = new Map<string, number>()
  private readonly artifacts = new Map<string, TArtifact>()
  /** Children a proposal returned, by artifact digest, until they are registered. */
  private readonly proposed = new Map<string, TArtifact>()
  /** Cells the ledger showed unsettled at start: an earlier process may hold their attempt. */
  private readonly adoptable = new Set<string>()
  private readonly operationCosts: number[] = []
  /** Operations started: the next one's id. */
  private expansions = 0
  /** Proposals that completed, by operation index. A proposal an interrupted
   * process lost counts toward none of the stop rules, so a resumed search
   * makes the proposals the uninterrupted one would have made. */
  private readonly completed: number[] = []
  private stopReason: SearchCloseReason | null = null
  private failure: { error: unknown } | null = null

  constructor(options: RunSearchOptions<TArtifact>) {
    this.options = options
    this.recorder = options.recorder
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new TypeError('runSearch: maxAttempts must be a positive integer')
    }
    const { maxExpansions } = options
    if (
      maxExpansions !== undefined &&
      (!Number.isSafeInteger(maxExpansions) || maxExpansions < 0)
    ) {
      throw new TypeError('runSearch: maxExpansions must be a non-negative integer')
    }
    for (const lane of options.executor.lanes()) {
      if (!Number.isSafeInteger(lane.capacity) || lane.capacity < 1) {
        throw new TypeError(`runSearch: lane ${lane.name} needs a positive integer capacity`)
      }
      if (!Number.isFinite(lane.cellUsd) || lane.cellUsd < 0) {
        throw new TypeError(`runSearch: lane ${lane.name} needs a finite non-negative cellUsd`)
      }
      if (this.lanes.has(lane.name))
        throw new TypeError(`runSearch: lane ${lane.name} is declared twice`)
      this.lanes.set(lane.name, {
        ...lane,
        inFlight: 0,
        queues: [[], [], [], []],
        settledCosts: [],
      })
    }
    if (this.lanes.size === 0) throw new TypeError('runSearch: the executor declares no lane')
  }

  async run(): Promise<SearchRunResult> {
    // One writer per search on a host: a second kernel on the same ledger
    // file is refused while the first lives; a killed holder's lock is
    // reclaimed. Across hosts the ledger's own chain refuses a fork.
    const { ledger } = this.recorder
    const lock =
      ledger instanceof FileSearchLedger
        ? acquireSingleRunLock({ lockPath: `${ledger.path}.run.lock` })
        : null
    try {
      return await this.runLocked()
    } finally {
      lock?.release()
    }
  }

  private async runLocked(): Promise<SearchRunResult> {
    await this.refresh()
    const header = this.state.header
    if (!header) throw new Error(`runSearch: search ${this.recorder.searchId} has not been opened`)
    if (
      header.policy.expansion !== this.options.policy.name ||
      header.policy.allocation !== this.options.allocation.name
    ) {
      throw new Error(
        `runSearch: search ${this.recorder.searchId} was opened with policy ${header.policy.expansion} and allocation ${header.policy.allocation}, not ${this.options.policy.name} and ${this.options.allocation.name}`,
      )
    }
    if (this.state.closed) return this.closedResult()
    await this.restore()
    const { signal } = this.options
    const onAbort = (): void => {
      for (const controller of this.inFlight.values()) controller.abort(signal?.reason)
      this.proposalController?.abort(signal?.reason)
      this.wakeUp()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.loop()
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (this.failure) throw this.failure.error
    await this.close()
    return this.closedResult()
  }

  // ── Start and resume ────────────────────────────────────────────────

  private async restore(): Promise<void> {
    const rootInput = this.options.codec.node(this.recorder, this.options.root)
    const rootId = this.state.rootNodeId
    if (rootId === null) {
      const { nodeId } = await this.recorder.registerNode(rootInput)
      await this.recorder.recordEdge({
        childNodeId: nodeId,
        parents: [],
        operator: 'seed',
        attribution: 'explicit',
        proposer: null,
        proposalKey: 'root',
        rationale: { unknown: 'the root is the caller-supplied starting artifact' },
        diffs: [],
        label: 'root',
      })
      await this.refresh()
    } else if (this.state.node(rootId)!.artifactDigest !== rootInput.artifactDigest) {
      throw new Error(
        `runSearch: search ${this.recorder.searchId} started from another root artifact; a changed start is a derived search`,
      )
    }
    const root = this.state.rootNodeId!
    this.artifacts.set(root, this.options.root)
    this.expansionOf.set(root, -1)

    // Operations an earlier process started and never recorded: their spend
    // is unknown, so each is recorded failed with a floor of zero.
    const recorded: number[] = []
    for (let expansion = 0; ; expansion++) {
      const operationId = `expand-${expansion}`
      const operation = this.state.operation(operationId)
      if (!operation) break
      this.expansions = expansion + 1
      if (operation.recorded) {
        this.operationCosts.push(operation.spentUsd)
        recorded.push(expansion)
        if (operation.outcome === 'completed') this.completed.push(expansion)
        continue
      }
      await this.recorder.recordOperation({
        operationId,
        operationKind: 'candidate-generation',
        execution: this.options.proposer.execution,
        outcome: {
          status: 'failed',
          failure: {
            code: 'interrupted',
            message: 'the search stopped while this proposal ran; its output was lost',
          },
        },
        accounting: interruptedAccounting(),
      })
      await this.refresh()
    }

    for (const node of this.state.nodes()) {
      if (node.edgeIds.length === 0) continue
      const edge = this.state.edge(node.edgeIds[0]!)!
      const expansion = edge.proposer?.operationId
        ? searchExpansionIndex(edge.proposer.operationId)
        : null
      this.expansionOf.set(node.nodeId, expansion ?? -1)
      if (node.status !== 'invalid') this.admitted.add(node.nodeId)
    }
    for (const cell of this.state.cells()) {
      const lane = cell.lane === null ? undefined : this.lanes.get(cell.lane)
      if (cell.final && lane) lane.settledCosts.push(cell.spentUsd)
      if (this.cellDone(cell)) continue
      if (!lane) {
        throw new Error(
          `runSearch: cell ${cell.cellId} was placed on lane ${String(cell.lane)}, which the executor does not declare`,
        )
      }
      this.adoptable.add(cell.cellId)
      this.enqueue(cell)
      this.pending.set(cell.nodeId, (this.pending.get(cell.nodeId) ?? 0) + 1)
    }
    // A proposal recorded before its children all were: finish it from its output.
    for (const expansion of recorded) await this.finishProposal(expansion)
    for (const node of this.state.nodes()) {
      if (this.admitted.has(node.nodeId) && !isTerminal(node)) await this.allocateFor(node.nodeId)
    }
    for (const nodeId of this.state.nodeIds()) {
      if (this.admitted.has(nodeId) && (this.pending.get(nodeId) ?? 0) === 0) {
        this.markScreened(nodeId)
      }
    }
  }

  // ── The loop ────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    for (;;) {
      if (this.failure || this.options.signal?.aborted) {
        await this.drain(this.failure?.error ?? this.options.signal?.reason)
        this.failure ??= { error: this.options.signal?.reason ?? new Error('aborted') }
        return
      }
      if (this.pastDeadline()) {
        // Past the deadline nothing new starts, so what waits is cancelled.
        this.stopReason ??= 'deadline'
        if (this.queuedCount() > 0) await this.cancelQueued('deadline')
      }
      this.dispatch()
      const blocked =
        this.stopReason === null && this.proposal === null ? await this.tryExpand() : null
      const busy = this.inFlight.size > 0 || this.proposal !== null
      if (!busy) {
        if (this.queuedCount() > 0) continue
        this.stopReason ??= blocked ?? 'converged'
        return
      }
      await this.handle(await this.next())
    }
  }

  /** The next completion, or null when an abort woke the loop without one. */
  private async next(): Promise<Completion | null> {
    if (this.completions.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
    return this.completions.shift() ?? null
  }

  private push(completion: Completion): void {
    this.completions.push(completion)
    this.wakeUp()
  }

  private wakeUp(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  private async handle(completion: Completion | null): Promise<void> {
    if (completion === null) return
    if (completion.kind === 'cell') await this.settle(completion)
    else await this.recordProposal(completion)
  }

  /** Abort everything in flight and record what still completes. */
  private async drain(reason: unknown): Promise<void> {
    for (const controller of this.inFlight.values()) controller.abort(reason)
    this.proposalController?.abort(reason)
    while (this.inFlight.size > 0 || this.proposal !== null) {
      await this.handle(await this.next())
    }
  }

  // ── Cells ───────────────────────────────────────────────────────────

  /** Fill free lane slots with queued cells. A queued cell was admitted when
   * it was allocated, so starting it needs no further decision. */
  private dispatch(): void {
    if (this.failure || this.options.signal?.aborted || this.pastDeadline()) return
    const cap = this.state.header!.budget.maxConcurrency
    for (const lane of this.lanes.values()) {
      while (lane.inFlight < lane.capacity && (cap === null || this.inFlight.size < cap)) {
        const cellId = lane.queues.find((queue) => queue.length > 0)?.shift()
        if (cellId === undefined) break
        this.start(cellId, lane)
      }
    }
  }

  private start(cellId: string, lane: LaneState): void {
    const cell = this.state.cell(cellId)!
    const attempt = cell.attempts + 1
    const controller = new AbortController()
    const work: SearchCellWork<TArtifact> = {
      searchId: this.recorder.searchId,
      cellId,
      nodeId: cell.nodeId,
      taskId: cell.taskId,
      unitId: cell.unitId,
      split: cell.split,
      rep: cell.rep,
      stage: cell.stage,
      lane: lane.name,
      attempt,
      runId: `${cellId}:${attempt}`,
      artifact: this.artifact(cell.nodeId),
      signal: controller.signal,
    }
    const adopt = this.adoptable.delete(cellId)
    this.inFlight.set(cellId, controller)
    lane.inFlight += 1
    const { executor } = this.options
    void (async () =>
      (adopt ? await executor.adopt(work) : null) ?? (await executor.run(work)))().then(
      (result) => this.push({ kind: 'cell', cellId, attempt, result }),
      (error: unknown) => this.push({ kind: 'cell', cellId, attempt, error }),
    )
  }

  private async settle(completion: Extract<Completion, { kind: 'cell' }>): Promise<void> {
    const { cellId, attempt } = completion
    this.inFlight.delete(cellId)
    const before = this.state.cell(cellId)!
    const lane = this.lanes.get(before.lane!)!
    lane.inFlight -= 1
    if (!completion.result) {
      this.failure ??= { error: completion.error }
      return
    }
    // The freed slot takes the next queued cell before this result is
    // written, so no slot idles while the ledger syncs.
    this.dispatch()
    if (
      (this.failure || this.options.signal?.aborted) &&
      completion.result.outcome.status === 'errored'
    ) {
      // An attempt that ends in an error while the search stops may have
      // failed because it was interrupted. It stays unsettled, so a resumed
      // search adopts or reruns it instead of recording the interruption.
      return
    }
    await this.recorder.settleCell({ ...completion.result, cellId, attempt })
    await this.refresh()
    const cell = this.state.cell(cellId)!
    if (cell.final) lane.settledCosts.push(cell.spentUsd)
    if (!this.cellDone(cell)) {
      if (this.failure || this.options.signal?.aborted) return
      this.enqueue(cell)
      return
    }
    const left = (this.pending.get(cell.nodeId) ?? 1) - 1
    this.pending.set(cell.nodeId, left)
    if (left === 0) await this.onScreenDone(cell.nodeId)
  }

  private async onScreenDone(nodeId: string): Promise<void> {
    this.markScreened(nodeId)
    if (this.stopReason === null && !this.failure) await this.allocateFor(nodeId)
  }

  private markScreened(nodeId: string): void {
    if (this.screenedSet.has(nodeId)) return
    this.screenedSet.add(nodeId)
    const ordinal = this.state.node(nodeId)!.ordinal
    let index = this.screened.length
    while (index > 0 && this.state.node(this.screened[index - 1]!)!.ordinal > ordinal) index--
    this.screened = [...this.screened.slice(0, index), nodeId, ...this.screened.slice(index)]
  }

  /** Allocate the cells the allocator plans for a node and the ledger lacks. */
  private async allocateFor(nodeId: string): Promise<void> {
    const plans = this.options.allocation
      .plan(this.state, nodeId)
      .filter(
        (plan) =>
          !this.state.cell(
            searchCellId(this.recorder.searchId, nodeId, plan.taskId, plan.split, plan.rep),
          ),
      )
    if (plans.length === 0) return
    const placed = plans.map((plan) => {
      const laneName = this.options.executor.place({ ...plan, nodeId })
      const lane = this.lanes.get(laneName)
      if (!lane)
        throw new Error(`runSearch: the executor placed a cell on unknown lane ${laneName}`)
      return { plan, lane, reservation: this.cellReservation(lane) }
    })
    const hold = placed.reduce((sum, { reservation }) => sum + reservation.usd, 0)
    const { headroomUsd } = this.state.budget
    if (headroomUsd !== null && hold > headroomUsd + USD_TOLERANCE) return
    const { maxCells } = this.state.header!.budget
    if (maxCells !== null && this.state.audit.cells.allocated + placed.length > maxCells) return
    for (const { plan, lane, reservation } of placed) {
      await this.recorder.allocateCell({
        nodeId,
        taskId: plan.taskId,
        split: plan.split,
        rep: plan.rep,
        stage: plan.stage,
        lane: lane.name,
        reservation,
      })
    }
    await this.refresh()
    for (const { plan } of placed) {
      const cellId = searchCellId(this.recorder.searchId, nodeId, plan.taskId, plan.split, plan.rep)
      this.enqueue(this.state.cell(cellId)!)
    }
    this.pending.set(nodeId, (this.pending.get(nodeId) ?? 0) + placed.length)
    this.dispatch()
  }

  private enqueue(cell: SearchCell): void {
    this.lanes.get(cell.lane!)!.queues[STAGE_PRIORITY[cell.stage]]!.push(cell.cellId)
  }

  private queuedCount(): number {
    let count = 0
    for (const lane of this.lanes.values()) {
      for (const queue of lane.queues) count += queue.length
    }
    return count
  }

  private async cancelQueued(reason: 'deadline' | 'budget'): Promise<void> {
    for (const lane of this.lanes.values()) {
      for (const queue of lane.queues) {
        for (const cellId of queue.splice(0)) {
          const cell = this.state.cell(cellId)!
          // A cell with a settled attempt already counts as settled; only a
          // never-run cell is cancelled.
          if (cell.attempts === 0) {
            await this.recorder.cancelCell({ cellId, reason })
            await this.refresh()
          }
          const left = (this.pending.get(cell.nodeId) ?? 1) - 1
          this.pending.set(cell.nodeId, left)
          if (left === 0) this.markScreened(cell.nodeId)
        }
      }
    }
  }

  /** No further attempt will run: a final outcome, a cancellation, or a
   * retryable error that used up its attempts. */
  private cellDone(cell: SearchCell): boolean {
    return (
      cell.final ||
      cell.cancelled !== null ||
      (cell.outcome === 'errored' && cell.attempts >= this.maxAttempts)
    )
  }

  // ── Expansion ───────────────────────────────────────────────────────

  /** Start a proposal when the rules admit one; otherwise say why not. */
  private async tryExpand(): Promise<SearchCloseReason | null> {
    const { maxNodes, maxCells } = this.state.header!.budget
    if (maxNodes !== null && this.state.audit.nodes >= maxNodes) return 'max-nodes'
    const { maxExpansions } = this.options
    if (maxExpansions !== undefined && this.completed.length >= maxExpansions) return 'max-nodes'
    if (this.queuedCount() > 0) return 'converged'
    if (this.inFlight.size >= 2 * this.capacity()) return 'converged'
    const view = this.policyView()
    const { policy } = this.options
    const leader = policy.leader(view)
    if (
      policy.patience !== undefined &&
      this.completed.filter((index) => index > (this.expansionOf.get(leader) ?? -1)).length >=
        policy.patience
    ) {
      return 'patience'
    }
    const screen = this.options.allocation.screenSize(this.state)
    const operation = this.operationReservation()
    const children = this.options.proposer.childrenPerProposal ?? 1
    const need = operation.usd + children * screen * this.maxCellReservation()
    const { headroomUsd } = this.state.budget
    if (headroomUsd !== null && need > headroomUsd + USD_TOLERANCE) return 'budget'
    if (maxCells !== null && this.state.audit.cells.allocated + children * screen > maxCells) {
      return 'budget'
    }
    const expansion = policy.expand(view)
    if (expansion === null) return 'converged'

    const index = this.expansions++
    const operationId = `expand-${index}`
    await this.recorder.startOperation({
      operationId,
      operationKind: 'candidate-generation',
      reservation: operation,
    })
    await this.refresh()
    const controller = new AbortController()
    const request: SearchProposalRequest<TArtifact> = {
      expansion: index,
      operationId,
      operator: expansion.operator,
      parents: expansion.parents.map((nodeId) => ({ nodeId, artifact: this.artifact(nodeId) })),
      leader,
      signal: controller.signal,
    }
    this.proposalController = controller
    this.proposal = this.options.proposer.propose(request).then(
      (result) =>
        this.push({
          kind: 'proposal',
          expansion: index,
          operationId,
          request,
          selection: expansion.selection,
          result,
        }),
      (error: unknown) =>
        this.push({
          kind: 'proposal',
          expansion: index,
          operationId,
          request,
          selection: expansion.selection,
          error,
        }),
    )
    return null
  }

  private async recordProposal(
    completion: Extract<Completion, { kind: 'proposal' }>,
  ): Promise<void> {
    this.proposal = null
    this.proposalController = null
    const { operationId, expansion } = completion
    const { proposer, codec, admit } = this.options
    const result = completion.result as SearchProposalResult<TArtifact> | undefined
    if (!result) {
      await this.recorder.recordOperation({
        operationId,
        operationKind: 'candidate-generation',
        execution: proposer.execution,
        outcome: {
          status: 'failed',
          failure: { code: 'proposer-error', message: errorMessage(completion.error) },
        },
        accounting: interruptedAccounting(),
      })
      await this.refresh()
      this.failure ??= { error: completion.error }
      return
    }
    const { maxNodes } = this.state.header!.budget
    const room = maxNodes === null ? Number.POSITIVE_INFINITY : maxNodes - this.state.audit.nodes
    const parents = completion.request.parents as ReadonlyArray<{
      nodeId: string
      artifact: TArtifact
    }>
    const blob: SearchProposalBlob = {
      kind: 'search-proposal',
      operator: completion.request.operator,
      parents: parents.map((parent) => parent.nodeId),
      selection: completion.selection,
      children: result.children.slice(0, Math.max(0, room)).map((child) => ({
        node: codec.node(this.recorder, child.artifact),
        diffs: parents.map((parent) => codec.diff(this.recorder, parent.artifact, child.artifact)),
        label: redactText(child.label, { profile: 'share' }),
        rationale: redactText(child.rationale, { profile: 'share' }),
        attribution: child.attribution ?? null,
        invalid: admit?.(child.artifact) ?? null,
      })),
    }
    await this.recorder.recordOperation({
      operationId,
      operationKind: 'candidate-generation',
      execution: result.execution ?? proposer.execution,
      outcome: { status: 'completed' },
      accounting: result.accounting,
      artifacts: [this.recorder.blob('proposal', blob)],
    })
    await this.refresh()
    this.operationCosts.push(this.state.operation(operationId)!.spentUsd)
    this.completed.push(expansion)
    for (const [index, child] of blob.children.entries()) {
      this.proposed.set(child.node.artifactDigest, result.children[index]!.artifact)
    }
    if (result.stop !== undefined || blob.children.length === 0) this.stopReason ??= 'converged'
    await this.finishProposal(expansion)
  }

  /** Register every child a recorded proposal produced, each once. */
  private async finishProposal(expansion: number): Promise<void> {
    const operationId = `expand-${expansion}`
    const operation = this.state.operation(operationId)
    const ref = operation?.artifacts.find((artifact) => artifact.role === 'proposal')
    if (!operation?.recorded || operation.outcome !== 'completed' || !ref) return
    const blob = this.recorder.readBlob(ref) as SearchProposalBlob
    const { proposer } = this.options
    for (const [index, child] of blob.children.entries()) {
      const { nodeId } = await this.recorder.registerNode(child.node)
      const held = this.proposed.get(child.node.artifactDigest)
      if (held !== undefined) {
        this.proposed.delete(child.node.artifactDigest)
        if (!this.artifacts.has(nodeId)) this.artifacts.set(nodeId, held)
      }
      const edgeId = await this.recorder.recordEdge({
        childNodeId: nodeId,
        parents: blob.parents,
        operator: blob.operator,
        attribution: 'explicit',
        proposer: {
          kind: proposer.kind,
          name: proposer.name,
          operationId,
          source: proposer.source,
        },
        proposalKey: `${operationId}:${index}`,
        selection: blob.selection,
        rationale: child.rationale,
        diffs: child.diffs,
        label: child.label,
      })
      await this.refresh()
      const node = this.state.node(nodeId)!
      if (node.edgeIds[0] !== edgeId) continue // a re-proposal: a second edge, not re-measured
      this.expansionOf.set(nodeId, expansion)
      if (child.invalid !== null) {
        await this.recorder.decideNode({
          nodeId,
          decision: { status: 'invalid' },
          rule: 'admission',
          reason: child.invalid,
        })
        await this.refresh()
        continue
      }
      if (this.admitted.has(nodeId)) continue
      this.admitted.add(nodeId)
      await this.allocateFor(nodeId)
      if ((this.pending.get(nodeId) ?? 0) === 0) this.markScreened(nodeId)
    }
  }

  // ── Close ───────────────────────────────────────────────────────────

  private async close(): Promise<void> {
    await this.refresh()
    const view = this.policyView()
    const leader = this.options.policy.leader(view)
    const { split } = view
    const root = this.state.rootNodeId!
    const rule = this.options.policy.name
    // Decide from one read of the state, then append: an append moves the
    // ledger on and retires the view.
    const decisions = this.state
      .nodes()
      .filter((node) => !isTerminal(node))
      .map((node) => {
        const scored = this.state.scoredCells(node.nodeId, split).length > 0
        const lead = node.nodeId === leader && scored
        const against = node.nodeId === leader ? root : leader
        const basis: NodeEstimate | null =
          node.nodeId === against || !scored
            ? null
            : estimateNode(this.state, node.nodeId, { against, split })
        return {
          nodeId: node.nodeId,
          decision: { status: lead ? ('selected' as const) : ('rejected' as const) },
          basis,
          rule,
          reason: lead
            ? `the leader when the search stopped (${this.stopReason}): a budget decision on the ${split} split, which claims nothing`
            : !this.screenedSet.has(node.nodeId) || !scored
              ? 'the search stopped before this node was measured'
              : !view.complete(node.nodeId)
                ? 'it left a unit of its screen unscored, so it could not lead'
                : 'it did not beat the leader on the units they share',
        }
      })
    for (const decision of decisions) await this.recorder.decideNode(decision)
    await this.recorder.close({ reason: this.stopReason ?? 'converged', claim: null })
    await this.refresh()
  }

  private closedResult(): SearchRunResult {
    const state = this.state
    return {
      state,
      leader: state.audit.selectedNodeId ?? state.rootNodeId!,
      reason: state.closed!.reason,
    }
  }

  // ── Reads ───────────────────────────────────────────────────────────

  private policyView(): SearchPolicyView {
    return searchPolicyView(this.state, {
      screened: this.screened,
      screening: this.admitted.size - this.screenedSet.size,
      expansions: this.completed.length,
    })
  }

  private artifact(nodeId: string): TArtifact {
    const held = this.artifacts.get(nodeId)
    if (held !== undefined) return held
    const artifact = this.options.codec.load(this.recorder, this.state.node(nodeId)!)
    this.artifacts.set(nodeId, artifact)
    return artifact
  }

  private capacity(): number {
    let total = 0
    for (const lane of this.lanes.values()) total += lane.capacity
    const cap = this.state.header!.budget.maxConcurrency
    return cap === null ? total : Math.min(cap, total)
  }

  /** A hard lane holds its enforced maximum. An estimate lane holds 1.5 times
   * the 99th percentile of its settled cells once 20 settled, else its prior. */
  private cellReservation(lane: LaneState): SearchReservation {
    if (lane.costCap === 'hard') return { kind: 'hard', usd: lane.cellUsd }
    return { kind: 'estimate', usd: estimate(lane.settledCosts, lane.cellUsd) }
  }

  private maxCellReservation(): number {
    let most = 0
    for (const lane of this.lanes.values()) most = Math.max(most, this.cellReservation(lane).usd)
    return most
  }

  private operationReservation(): SearchReservation {
    return {
      kind: 'estimate',
      usd: estimate(this.operationCosts, this.options.proposer.reservationUsd ?? 0),
    }
  }

  private pastDeadline(): boolean {
    const deadline = this.state.header!.budget.deadline
    return deadline !== null && this.now() >= Date.parse(deadline)
  }

  private async refresh(): Promise<void> {
    this.state = await this.recorder.state()
  }
}

/**
 * A policy's read of a search: `screened` lists the admitted nodes whose screen
 * finished, in registration order; `screening` counts the admitted nodes still
 * being screened. Nodes are ranked on the selection split, or on train when
 * the search declares no selection split. The view reads no test cell.
 */
export function searchPolicyView(
  state: SearchStateView,
  input: { screened: readonly string[]; screening: number; expansions: number },
): SearchPolicyView {
  const header = state.header
  if (!header) throw new Error(`search ${state.searchId} has not been opened`)
  const split = header.splits.selection.tasks.length > 0 ? 'selection' : 'train'
  return {
    searchId: state.searchId,
    seed: header.policy.seed,
    direction: header.objective.direction,
    split,
    rootNodeId: state.rootNodeId!,
    expansions: input.expansions,
    screened: [...input.screened],
    screening: input.screening,
    complete: (nodeId) => {
      const cells = state.cells({ nodeId }).filter((cell) => cell.split === split)
      return cells.length > 0 && cells.every((cell) => cell.score !== null)
    },
    unitScores: (nodeId) => state.unitScores(nodeId, split),
    estimate: (nodeId, against) => estimateNode(state, nodeId, { against, split }),
  }
}

function isTerminal(node: SearchNode): boolean {
  return node.status !== null && node.status !== 'advanced'
}

function estimate(costs: readonly number[], prior: number): number {
  if (costs.length < ESTIMATE_FROM_CELLS) return prior
  const sorted = [...costs].sort((a, b) => a - b)
  const p99 = sorted[Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1)]!
  return Math.round(ESTIMATE_MARGIN * p99 * 1e9) / 1e9
}

/** Spend of work whose result was lost: unknown, with no proven floor. */
function interruptedAccounting(): SearchAttemptAccounting {
  return {
    tokens: { status: 'unknown', reason: 'the result of this work was lost' },
    cost: {
      status: 'unknown',
      knownLowerBoundUsd: 0,
      reason: 'the result of this work was lost, so its spend is unknown',
    },
  }
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim().length > 0 ? text : 'the proposer failed without a message'
}
