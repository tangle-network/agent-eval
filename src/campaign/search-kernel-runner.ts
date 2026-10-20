/** Event loop and mutable scheduling state for one ledger-backed search. */
import { redactText } from '../trace/redact'
import type { SearchAllocationView, SearchRungDecision } from './allocation'
import { SearchKernelClaim } from './search-kernel-claim'
import { closedSearchResult, isTerminal, unclaimedSearchDecisions } from './search-kernel-close'
import type {
  RunSearchOptions,
  SearchCellResult,
  SearchCellWork,
  SearchLane,
  SearchProposalBlob,
  SearchProposalRequest,
  SearchProposalResult,
  SearchRunResult,
} from './search-kernel-contract'
import {
  DEFAULT_MAX_ATTEMPTS,
  ESTIMATE_FROM_CELLS,
  ESTIMATE_MARGIN,
  STAGE_PRIORITY,
  searchExpansionIndex,
  USD_TOLERANCE,
} from './search-kernel-contract'
import { searchDivergence, searchPolicyView } from './search-kernel-policy-view'
import { FileSearchLedger } from './search-ledger'
import type { SearchRecorder } from './search-ledger-recording'
import type {
  SearchAttemptAccounting,
  SearchCloseReason,
  SearchReservation,
} from './search-ledger-types'
import type { SearchPolicyView } from './search-policy'
import { type SearchCell, type SearchStateView, searchCellId } from './search-state'
import { acquireSingleRunLock } from './single-run-lock'

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

export class SearchKernel<TArtifact> {
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
  /** The claim's design once expansion stopped; the search then only claims. */
  private readonly claim: SearchKernelClaim

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

    const kernel = this
    this.claim = new SearchKernelClaim({
      get state() {
        return kernel.state
      },
      get stopReason() {
        return kernel.stopReason
      },
      set stopReason(reason) {
        kernel.stopReason = reason
      },
      recorder: this.recorder,
      options,
      lanes: this.lanes,
      refresh: () => this.refresh(),
      cellReservation: (lane) => this.cellReservation(this.lanes.get(lane.name)!),
      maxCellReservation: () => this.maxCellReservation(),
      operationReservation: () => this.operationReservation(),
      enqueue: (cell) => this.enqueue(cell),
    })
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
    if (this.state.closed) return closedSearchResult(this.state)
    await this.restore()
    const { signal } = this.options
    const onAbort = (): void => {
      for (const controller of this.inFlight.values()) controller.abort(signal?.reason)
      this.proposalController?.abort(signal?.reason)
      this.wakeUp()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (this.claim.plan) await this.claim.apply(this.claim.plan)
      await this.loop()
      if (!this.failure && !this.claim.plan && this.state.header!.splits.test.tasks.length > 0) {
        await this.claim.begin()
        await this.loop()
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (this.failure) throw this.failure.error
    await this.close()
    return closedSearchResult(this.state)
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
    if (this.state.audit.cells.allocated === 0) this.claim.assertReady()
    await this.claim.restore()

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
      if (cell.stage !== 'claim') {
        this.pending.set(cell.nodeId, (this.pending.get(cell.nodeId) ?? 0) + 1)
      }
    }
    // Once the claim began the search only claims: nothing is proposed or
    // allocated outside the test.
    if (this.claim.plan) return
    // A proposal recorded before its children all were: finish it from its output.
    for (const expansion of recorded) await this.finishProposal(expansion)
    for (const node of this.state.nodes()) {
      if (this.admitted.has(node.nodeId) && !isTerminal(node)) await this.allocateFor(node.nodeId)
    }
    for (const nodeId of this.state.nodeIds()) {
      if (!this.admitted.has(nodeId)) continue
      // An advanced node finished its screen before its rung cells were
      // allocated, so it stays a parent while they run, as it was before the
      // restart.
      if (this.state.node(nodeId)!.status === 'advanced') this.markScreened(nodeId)
      else if ((this.pending.get(nodeId) ?? 0) === 0) await this.screenDone(nodeId)
    }
    // A node may have finished a rung before the interrupted process recorded
    // what its rank earned.
    await this.advance()
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
    if (this.failure || this.options.signal?.aborted) return
    // Past the deadline the search stops, but its claim still runs: the
    // claim's budget was reserved at the start.
    const claimOnly = this.pastDeadline()
    const cap = this.state.header!.budget.maxConcurrency
    for (const lane of this.lanes.values()) {
      while (lane.inFlight < lane.capacity && (cap === null || this.inFlight.size < cap)) {
        const queue = claimOnly
          ? lane.queues[STAGE_PRIORITY.claim]
          : lane.queues.find((waiting) => waiting.length > 0)
        const cellId = queue?.shift()
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
    if (cell.stage === 'claim') return
    const left = (this.pending.get(cell.nodeId) ?? 1) - 1
    this.pending.set(cell.nodeId, left)
    if (left === 0) await this.onNodeIdle(cell.nodeId)
  }

  /** Every cell allocated to the node is done: its screen, or a rung. */
  private async onNodeIdle(nodeId: string): Promise<void> {
    if (!(await this.screenDone(nodeId))) return
    await this.advance()
  }

  /** Record the rank decisions the allocator now supports and allocate the
   * rungs they open. Past the deadline, once the claim began, or once the
   * search fails or is aborted, no rung opens; a search that stopped
   * expanding still measures the nodes that earned it. */
  private async advance(): Promise<void> {
    if (this.claim.plan || this.failure || this.options.signal?.aborted || this.pastDeadline()) {
      return
    }
    for (const decision of this.options.allocation.advance(this.allocationView())) {
      await this.allocateFor(decision.nodeId, decision)
    }
  }

  /**
   * A node's allocated cells all finished. A node that diverges (its train
   * mean rose over its parent's while its selection interval against the
   * parent lies wholly on the worse side) is decided `invalid` and never
   * becomes a parent; any other node is screened. Returns whether it was.
   */
  private async screenDone(nodeId: string): Promise<boolean> {
    // The check reads the screen alone: a node the allocator advanced passed
    // it when its screen finished, and a restart must not re-judge it on the
    // rung cells it earned since.
    if (
      !this.claim.plan &&
      !this.screenedSet.has(nodeId) &&
      this.state.node(nodeId)!.status !== 'advanced'
    ) {
      const divergence = searchDivergence(this.state, nodeId)
      if (divergence) {
        await this.recorder.decideNode({
          nodeId,
          decision: { status: 'invalid' },
          basis: divergence.basis,
          rule: 'divergence',
          reason: divergence.reason,
        })
        await this.refresh()
        this.admitted.delete(nodeId)
        return false
      }
    }
    this.markScreened(nodeId)
    return true
  }

  private markScreened(nodeId: string): void {
    if (this.screenedSet.has(nodeId)) return
    this.screenedSet.add(nodeId)
    const ordinal = this.state.node(nodeId)!.ordinal
    let index = this.screened.length
    while (index > 0 && this.state.node(this.screened[index - 1]!)!.ordinal > ordinal) index--
    this.screened = [...this.screened.slice(0, index), nodeId, ...this.screened.slice(index)]
  }

  /**
   * Allocate the cells the allocator plans for a node through its rung and the
   * ledger lacks. With a rank decision, the rung is the decision's, and the
   * decision is recorded first, only once the cap admits the rung's cells.
   * Returns false when the cap or `maxCells` refused them.
   */
  private async allocateFor(nodeId: string, decision?: SearchRungDecision): Promise<boolean> {
    const rung =
      decision?.decision.status === 'advanced'
        ? decision.decision.rung
        : (this.state.node(nodeId)!.rung ?? 0)
    const plans = this.options.allocation
      .plan(this.state, nodeId, rung)
      .filter(
        (plan) =>
          !this.state.cell(
            searchCellId(this.recorder.searchId, nodeId, plan.taskId, plan.split, plan.rep),
          ),
      )
    if (plans.length === 0) {
      if (decision) await this.decide(decision)
      return true
    }
    const placed = plans.map((plan) => {
      const laneName = this.options.executor.place({ ...plan, nodeId })
      const lane = this.lanes.get(laneName)
      if (!lane)
        throw new Error(`runSearch: the executor placed a cell on unknown lane ${laneName}`)
      return { plan, lane, reservation: this.cellReservation(lane) }
    })
    const hold = placed.reduce((sum, { reservation }) => sum + reservation.usd, 0)
    const { headroomUsd } = this.state.budget
    if (headroomUsd !== null && hold > headroomUsd + USD_TOLERANCE) return false
    const { maxCells } = this.state.header!.budget
    if (maxCells !== null && this.state.audit.cells.allocated + placed.length > maxCells) {
      return false
    }
    if (decision) await this.decide(decision)
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
    return true
  }

  private async decide(decision: SearchRungDecision): Promise<void> {
    await this.recorder.decideNode(decision)
    await this.refresh()
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
      for (const [priority, queue] of lane.queues.entries()) {
        if (priority === STAGE_PRIORITY.claim) continue
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
    if (headroomUsd !== null && (need > headroomUsd + USD_TOLERANCE || this.overCap())) {
      return 'budget'
    }
    if (maxCells !== null && this.state.audit.cells.allocated + children * screen > maxCells) {
      return 'budget'
    }
    const expansion = policy.expand(view)
    if (expansion === null) return 'converged'
    const screened = new Set(view.screened)
    if (expansion.parents.length === 0) {
      throw new Error(`runSearch: policy ${policy.name} proposed an expansion without a parent`)
    }
    for (const parent of expansion.parents) {
      if (!screened.has(parent)) {
        throw new Error(
          `runSearch: policy ${policy.name} named parent ${parent}, which has not finished its screen; a node becomes a parent only after its screen completes`,
        )
      }
    }

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
      // On resume, a child the divergence rule already decided invalid stays
      // out: it is never screened, so it is never a parent.
      if (this.admitted.has(nodeId) || node.status === 'invalid') continue
      this.admitted.add(nodeId)
      await this.allocateFor(nodeId)
      if ((this.pending.get(nodeId) ?? 0) === 0) this.markScreened(nodeId)
    }
  }

  // ── Close ───────────────────────────────────────────────────────────

  private async close(): Promise<void> {
    await this.refresh()
    // Nodes left waiting on a rung are pruned with their rank; the policy's
    // leader is kept for the decisions below.
    const keep = this.options.policy.leader(this.policyView())
    for (const decision of this.options.allocation.prune(this.allocationView(), keep)) {
      await this.decide(decision)
    }
    if (this.claim.plan) {
      await this.claim.close(this.claim.plan)
      return
    }
    const view = this.policyView()
    const leader = this.options.policy.leader(view)
    const decisions = unclaimedSearchDecisions(this.state, view, leader, {
      rule: this.options.policy.name,
      stopReason: this.stopReason,
      screened: this.screenedSet,
    })
    for (const decision of decisions) await this.recorder.decideNode(decision)
    await this.recorder.close({ reason: this.stopReason ?? 'converged', claim: null })
    await this.refresh()
  }

  // ── Reads ───────────────────────────────────────────────────────────

  private policyView(): SearchPolicyView {
    return searchPolicyView(this.state, {
      screened: this.screened,
      screening: this.admitted.size - this.screenedSet.size,
      expansions: this.completed.length,
      maxAttempts: this.maxAttempts,
    })
  }

  private allocationView(): SearchAllocationView {
    return {
      state: this.state,
      idle: (nodeId) => this.admitted.has(nodeId) && (this.pending.get(nodeId) ?? 0) === 0,
    }
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

  /** Overspend took committed spend, open holds and the unspent claim reserve
   * past the cap. Nothing new is proposed then, even at a zero-dollar prior. */
  private overCap(): boolean {
    const { maxUsd } = this.state.header!.budget
    if (maxUsd === null) return false
    const { committedUsd, openReservationUsd } = this.state.audit.spend
    const used = committedUsd + openReservationUsd + this.state.budget.claimReserveUsd
    return used > maxUsd + USD_TOLERANCE
  }

  private pastDeadline(): boolean {
    const deadline = this.state.header!.budget.deadline
    return deadline !== null && this.now() >= Date.parse(deadline)
  }

  private async refresh(): Promise<void> {
    this.state = await this.recorder.state()
  }
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
