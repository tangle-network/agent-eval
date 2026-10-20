/** Sealed-test claim planning, persistence, placement, and final ledger decisions. */
import type { SearchAllocator, SearchCellPlan } from './allocation'
import { estimateNode } from './estimate-node'
import {
  decideSearchClaim,
  planSearchClaim,
  SEARCH_CLAIM_RULE,
  SEARCH_CLAIM_RULE_NAME,
  type SearchClaimPlan,
  searchClaimReserveUsd,
} from './search-claim'
import { isTerminal } from './search-kernel-close'
import type { SearchExecutor, SearchLane } from './search-kernel-contract'
import { CLAIM_OPERATION, USD_TOLERANCE } from './search-kernel-contract'
import type { SearchRecorder } from './search-ledger-recording'
import type { SearchCloseReason, SearchReservation } from './search-ledger-types'
import { type SearchCell, type SearchStateView, searchCellId } from './search-state'

interface SearchClaimHost {
  stopReason: SearchCloseReason | null
  readonly state: SearchStateView
  readonly recorder: SearchRecorder
  readonly options: {
    readonly allocation: SearchAllocator
    readonly executor: Pick<SearchExecutor<unknown>, 'place'>
    readonly proposer: { readonly childrenPerProposal?: number }
  }
  readonly lanes: ReadonlyMap<string, SearchLane>
  refresh(): Promise<void>
  cellReservation(lane: SearchLane): SearchReservation
  maxCellReservation(): number
  operationReservation(): SearchReservation
  enqueue(cell: SearchCell): void
}

/** The sealed-test lifecycle: preflight, durable plan, cell allocation, and final claim. */
export class SearchKernelClaim {
  plan: SearchClaimPlan | null = null

  constructor(private readonly host: SearchClaimHost) {}

  /** Refuse an unclaimable search before its first paid cell starts. */
  assertReady(): void {
    const header = this.host.state.header!
    const testTasks = header.splits.test.tasks.length
    if (testTasks === 0) return
    const refuse = (why: string): never => {
      throw new Error(
        `runSearch: search ${this.host.recorder.searchId} has a test split, but ${why}`,
      )
    }
    if (header.splits.selection.tasks.length === 0) {
      refuse('no selection split to choose its finalists on')
    }
    if (header.objective.claim.minimumEffect === undefined) {
      refuse('its claim declares no minimumEffect for the power check')
    }
    if ('unknown' in header.objective.judge) {
      refuse(
        'its judge is not pinned; a claim with an unknown judge cannot ship, and a resumed search could mix two judges',
      )
    }
    const { maxUsd, reservedClaimUsd } = header.budget
    if (maxUsd === null) return
    const cellUsd = this.host.maxCellReservation()
    const need = searchClaimReserveUsd({
      testTasks,
      reps: this.host.options.allocation.reps,
      cellUsd,
    })
    if (reservedClaimUsd + USD_TOLERANCE < need) {
      refuse(
        `its claim reserve $${reservedClaimUsd} is below the $${need} the root and 3 finalists need on ${testTasks} test tasks at $${cellUsd} a cell`,
      )
    }
    const rootCells = this.host.options.allocation.plan(
      this.host.state,
      this.host.state.rootNodeId!,
      0,
    ).length
    const screens =
      (this.host.options.proposer.childrenPerProposal ?? 1) *
      this.host.options.allocation.screenSize(this.host.state)
    const round = this.host.operationReservation().usd + (rootCells + screens) * cellUsd
    if (maxUsd - reservedClaimUsd + USD_TOLERANCE < round) {
      refuse(
        `its cap $${maxUsd} less the claim reserve $${reservedClaimUsd} does not cover the root and one screening round ($${round})`,
      )
    }
  }

  /** Recover the exact durable claim design left by an earlier process. */
  async restore(): Promise<void> {
    const operation = this.host.state.operation(CLAIM_OPERATION)
    if (!operation) return
    const ref = operation.artifacts.find((artifact) => artifact.role === 'claim-plan')
    if (!ref) throw new Error(`runSearch: the ${CLAIM_OPERATION} operation has no stored plan`)
    const plan = this.host.recorder.readBlob(ref) as SearchClaimPlan
    if (!operation.recorded) await this.recordClaimOperation()
    this.plan = plan
    this.host.stopReason = plan.stopReason
  }

  async begin(): Promise<void> {
    await this.host.refresh()
    const stopReason = this.host.stopReason ?? 'converged'
    const header = this.host.state.header!
    const reps = this.host.options.allocation.reps
    const plan = planSearchClaim(this.host.state, {
      stopReason,
      reps,
      affordable: (finalists) => {
        const placed = this.claimCells(finalists, this.host.state.rootNodeId!)
        const hold = placed.reduce((sum, cell) => sum + cell.reservation.usd, 0)
        const { headroomUsd, claimReserveUsd } = this.host.state.budget
        const { maxCells } = header.budget
        return (
          (headroomUsd === null || hold <= headroomUsd + claimReserveUsd + USD_TOLERANCE) &&
          (maxCells === null || this.host.state.audit.cells.allocated + placed.length <= maxCells)
        )
      },
    })
    await this.host.recorder.startOperation({
      operationId: CLAIM_OPERATION,
      operationKind: 'selection',
      reservation: null,
      artifacts: [this.host.recorder.blob('claim-plan', plan)],
    })
    await this.recordClaimOperation()
    this.plan = plan
    this.host.stopReason = stopReason
    await this.apply(plan)
  }

  private async recordClaimOperation(): Promise<void> {
    await this.host.recorder.recordOperation({
      operationId: CLAIM_OPERATION,
      operationKind: 'selection',
      execution: { kind: 'deterministic', source: SEARCH_CLAIM_RULE },
      outcome: { status: 'completed' },
      accounting: {
        tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        cost: { status: 'known', usd: 0, source: 'free' },
      },
    })
    await this.host.refresh()
  }

  /** Decide finalists and allocate all interleaved test cells before any starts. Idempotent. */
  async apply(plan: SearchClaimPlan): Promise<void> {
    const root = this.host.state.rootNodeId!
    // Estimate from one read of the state, then append: an append retires the view.
    const bases = plan.finalists.map((finalist) =>
      estimateNode(this.host.state, finalist.nodeId, { against: root, split: 'selection' }),
    )
    for (const [rank, finalist] of plan.finalists.entries()) {
      await this.host.recorder.decideNode({
        nodeId: finalist.nodeId,
        decision: { status: 'finalist' },
        basis: bases[rank]!,
        rule: SEARCH_CLAIM_RULE_NAME,
        reason: `rank ${rank + 1} of ${plan.finalists.length} by selection mean (${finalist.selectionMean}); ${plan.reason}`,
      })
    }
    await this.host.refresh()
    if (plan.test !== 'run') return
    const missing = this.claimCells(plan.finalists.length, root, plan)
      .map((cell) => ({
        ...cell,
        cellId: searchCellId(
          this.host.recorder.searchId,
          cell.nodeId,
          cell.plan.taskId,
          'test',
          cell.plan.rep,
        ),
      }))
      .filter((cell) => !this.host.state.cell(cell.cellId))
    for (const cell of missing) {
      await this.host.recorder.allocateCell({
        nodeId: cell.nodeId,
        taskId: cell.plan.taskId,
        split: 'test',
        rep: cell.plan.rep,
        stage: 'claim',
        lane: cell.lane.name,
        reservation: cell.reservation,
      })
    }
    await this.host.refresh()
    for (const cell of missing) this.host.enqueue(this.host.state.cell(cell.cellId)!)
  }

  private claimCells(
    finalists: number,
    root: string,
    plan?: SearchClaimPlan,
  ): Array<{
    nodeId: string
    plan: SearchCellPlan
    lane: SearchLane
    reservation: SearchReservation
  }> {
    const header = this.host.state.header!
    // While pricing, the arms are placeholders: placement and holds depend on
    // the lane, never on which node runs.
    const arms = [root, ...(plan ? plan.finalists.map((entry) => entry.nodeId) : [])]
    while (arms.length < finalists + 1) arms.push(root)
    const cells = []
    for (const task of header.splits.test.tasks) {
      for (let rep = 0; rep < this.host.options.allocation.reps; rep++) {
        for (const nodeId of arms) {
          const cellPlan: SearchCellPlan = {
            taskId: task.taskId,
            split: 'test',
            rep,
            stage: 'claim',
          }
          const laneName = this.host.options.executor.place({ ...cellPlan, nodeId })
          const lane = this.host.lanes.get(laneName)
          if (!lane) {
            throw new Error(`runSearch: the executor placed a cell on unknown lane ${laneName}`)
          }
          cells.push({ nodeId, plan: cellPlan, lane, reservation: this.host.cellReservation(lane) })
        }
      }
    }
    return cells
  }

  async close(plan: SearchClaimPlan): Promise<void> {
    const { claim, decisions } = decideSearchClaim(this.host.state, plan)
    const decided = new Set(decisions.map((decision) => decision.nodeId))
    const root = this.host.state.rootNodeId!
    const rest = this.host.state
      .nodes()
      .filter((node) => !decided.has(node.nodeId) && !isTerminal(node))
      .map((node) => {
        const scored = this.host.state.scoredCells(node.nodeId, 'selection').length > 0
        return {
          nodeId: node.nodeId,
          decision: { status: 'rejected' as const },
          basis: scored
            ? estimateNode(this.host.state, node.nodeId, { against: root, split: 'selection' })
            : null,
          rule: SEARCH_CLAIM_RULE_NAME,
          reason: scored
            ? 'not a finalist: the claim tests at most 3 nodes that scored every selection unit and beat the root, best selection mean first'
            : 'the search stopped before this node was measured on the selection split',
        }
      })
    for (const decision of [...decisions, ...rest]) await this.host.recorder.decideNode(decision)
    await this.host.recorder.close({ reason: plan.stopReason, claim })
    await this.host.refresh()
  }
}
