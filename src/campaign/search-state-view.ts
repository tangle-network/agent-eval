/** Position-bound search snapshots and deterministic scored-unit reads. */

import { compareCodeUnits } from '../ledger-core/canonical'
import type { RolloutSearchLineage } from '../rollout/mint'
import { type RunSearchCoordinates, searchCellRunId } from '../run-record'
import { SearchLedgerError } from './search-ledger-errors'
import type {
  SearchAudit,
  SearchClosedEvent,
  SearchEdgeRecordedEvent,
  SearchLedgerHash,
  SearchOpenedEvent,
  SearchSplit,
} from './search-ledger-types'
import type { SearchLedgerIndexes } from './search-state-indexes'
import type { SearchState } from './search-state-projection'
import type {
  SearchCell,
  SearchCompletion,
  SearchNode,
  SearchOperation,
  SearchScoredCell,
  SearchUnitScore,
} from './search-state-types'

/**
 * Per-unit means of scored cells, in unitId order. Each unit sums its cells in
 * cellId order, so the result depends on the set of cells alone, never on the
 * order they settled in: a verifier that reads the same cells from a database
 * gets the same bits.
 */
export function searchUnitScores(cells: readonly SearchScoredCell[]): SearchUnitScore[] {
  const byUnit = new Map<string, SearchScoredCell[]>()
  for (const cell of cells) {
    const unit = byUnit.get(cell.unitId)
    if (unit) unit.push(cell)
    else byUnit.set(cell.unitId, [cell])
  }
  return [...byUnit.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([unitId, unitCells]) => {
      let sum = 0
      for (const cell of unitCells.sort((left, right) =>
        compareCodeUnits(left.cellId, right.cellId),
      )) {
        sum += cell.score
      }
      return { unitId, sum, count: unitCells.length, mean: sum / unitCells.length }
    })
}

/**
 * A read of `SearchState` at one ledger position. Header, head, audit and
 * claim are values. Node, edge, cell and score reads go to the live indexes and
 * throw once the state has applied a later entry.
 */
export class SearchStateView {
  readonly searchId: string
  readonly header: SearchOpenedEvent | null
  readonly closed: SearchClosedEvent | null
  readonly head: { sequence: number; entryHash: SearchLedgerHash } | null
  /** `occurredAt` of the head entry; a writer stamps later events at or after it. */
  readonly lastOccurredAt: string | null
  readonly audit: SearchAudit
  readonly completion: SearchCompletion
  /**
   * The admission rule's room: `headroomUsd` is the largest reservation a new
   * non-claim cell or operation may hold (committed spend, open holds and the
   * unspent claim reserve all count against the cap), or null when the search
   * declares no cap. `claimReserveUsd` is what claim cells may still draw.
   */
  readonly budget: { headroomUsd: number | null; claimReserveUsd: number }
  private readonly state: SearchState
  private readonly version: number

  constructor(state: SearchState, version: number) {
    this.state = state
    this.version = version
    this.searchId = state.searchId
    const position = state.readPosition()
    this.header = position.header
    this.closed = position.closed
    this.head = position.head
    this.lastOccurredAt = position.lastOccurredAt
    this.audit = position.audit
    this.budget = position.budget
    const reasons = state.incompleteReasons()
    if (!this.closed) reasons.unshift('search is open')
    this.completion = { complete: this.closed !== null, reasons }
  }

  /** The node the search started from: the first registered. */
  get rootNodeId(): string | null {
    return this.live().nodeIds()[0] ?? null
  }

  node(nodeId: string): SearchNode | undefined {
    return this.live().node(nodeId)
  }

  hasNode(nodeId: string): boolean {
    return this.live().hasNode(nodeId)
  }

  /** Node ids in registration order. */
  nodeIds(): string[] {
    return [...this.live().nodeIds()]
  }

  /** Nodes in registration order. */
  nodes(): SearchNode[] {
    const state = this.live()
    return state.nodeIds().map((nodeId) => state.node(nodeId)!)
  }

  nodeIdForDigest(artifactDigest: string): string | undefined {
    return this.live().nodeIdForDigest(artifactDigest)
  }

  edge(edgeId: string): SearchEdgeRecordedEvent | undefined {
    return this.live().edge(edgeId)
  }

  /** Edges in ledger order. */
  edges(): SearchEdgeRecordedEvent[] {
    const state = this.live()
    return state.edgeIds().map((edgeId) => state.edge(edgeId)!)
  }

  cell(cellId: string): SearchCell | undefined {
    return this.live().cell(cellId)
  }

  /** Cells in allocation order, optionally of one node. */
  cells(filter: { nodeId?: string } = {}): SearchCell[] {
    const state = this.live()
    return state.cellIds(filter.nodeId).map((cellId) => state.cell(cellId)!)
  }

  operation(operationId: string): SearchOperation | undefined {
    return this.live().operation(operationId)
  }

  /** A node's scored cells on one split, in allocation order. Unscored cells
   * (errored, cancelled or in flight) are absent, never zero. */
  scoredCells(nodeId: string, split: SearchSplit): SearchScoredCell[] {
    return this.live().scoredCells(nodeId, split)
  }

  /** Per-unit score means of a node on one split, in unitId order. */
  unitScores(nodeId: string, split: SearchSplit): SearchUnitScore[] {
    return searchUnitScores(this.scoredCells(nodeId, split))
  }

  /** The lineage a RunRecord mint needs for one cell attempt. */
  lineage(coordinates: RunSearchCoordinates): RolloutSearchLineage {
    const state = this.live()
    if (coordinates.searchId !== this.searchId) {
      throw new SearchLedgerError(
        `coordinates name search ${coordinates.searchId}, not ${this.searchId}`,
      )
    }
    const cell = state.cell(coordinates.cellId)
    if (!cell || cell.nodeId !== coordinates.nodeId) {
      throw new SearchLedgerError(
        `cell ${coordinates.cellId} of node ${coordinates.nodeId} is not in search ${this.searchId}`,
      )
    }
    if (coordinates.attempt < 1 || coordinates.attempt > cell.attempts) {
      throw new SearchLedgerError(
        `cell ${coordinates.cellId} has ${cell.attempts} settled attempt(s), not attempt ${coordinates.attempt}`,
      )
    }
    const node = state.node(cell.nodeId)!
    if (node.depth === null) {
      throw new SearchLedgerError(
        `node ${node.nodeId} has unknown lineage, so its depth is unknown`,
      )
    }
    const containment = this.header?.containment ?? null
    return {
      depth: node.depth,
      ordinal: node.ordinal,
      rep: cell.rep,
      containingRunId: containment
        ? searchCellRunId({ cellId: containment.cellId, attempt: containment.attempt })
        : null,
    }
  }

  private live(): SearchLedgerIndexes {
    if (!this.state.isAt(this.version)) {
      throw new SearchLedgerError(
        `this SearchStateView is from sequence ${this.head?.sequence ?? -1}, and the ledger has moved on; read the ledger's state again`,
      )
    }
    return this.state.index
  }
}
