/**
 * `SearchState`: the one projection of a search ledger.
 *
 * The same code checks every invariant for the producer's journal, the kernel,
 * and the Intelligence verifier, and builds the read model they share. It keeps
 * compact indexes (nodes, edges, cells, per-unit score sums, running audit
 * totals), not the raw event list, and applies each entry in time proportional
 * to that entry, so a search of any length appends at a constant cost.
 *
 * The journal asks for a snapshot after every append. A snapshot is a
 * `SearchStateView` that reads the live indexes, so taking one costs nothing.
 * The view is valid until the state applies its next entry; a read after that
 * throws rather than returning numbers from a later ledger position. Read the
 * ledger's state again to see newer entries. The audit, header, head and claim
 * on a view are plain values and stay readable.
 */

import { createHash } from 'node:crypto'
import type { LedgerProjector } from '../ledger-core'
import { canonicalString, compareCodeUnits, hashCanonical } from '../ledger-core/canonical'
import type { RolloutSearchLineage } from '../rollout/mint'
import { type RunSearchCoordinates, searchCellRunId } from '../run-record'
import { SearchLedgerError, SearchLedgerIntegrityError } from './search-ledger-errors'
import { artifactKey } from './search-ledger-ordering'
import type {
  NodeEstimate,
  SearchArtifactRef,
  SearchAttemptAccounting,
  SearchAudit,
  SearchCandidateSurface,
  SearchCellAllocatedEvent,
  SearchCellCancelledEvent,
  SearchCellSettledEvent,
  SearchCellStage,
  SearchClaim,
  SearchClosedEvent,
  SearchEdgeRecordedEvent,
  SearchLedgerEntry,
  SearchLedgerEvent,
  SearchLedgerHash,
  SearchNodeDecidedEvent,
  SearchNodeDecision,
  SearchNodeRef,
  SearchNodeRegisteredEvent,
  SearchNodeStatus,
  SearchOpenedEvent,
  SearchOperationKind,
  SearchOperationRecordedEvent,
  SearchOperationStartedEvent,
  SearchReservation,
  SearchSplit,
  SearchTask,
  SearchTaskOutcome,
} from './search-ledger-types'

/** Deterministic node id: identical content in one search is one node. */
export function searchNodeId(searchId: string, artifactDigest: string): string {
  return `node_${shortDigest([searchId, artifactDigest])}`
}

/** Deterministic cell id: one node on one task in one split at one repeat. */
export function searchCellId(
  searchId: string,
  nodeId: string,
  taskId: string,
  split: SearchSplit,
  rep: number,
): string {
  return `cell_${shortDigest([searchId, nodeId, taskId, split, rep])}`
}

/** Digest a split's task list in taskId order. */
export function searchTaskSetDigest(tasks: readonly SearchTask[]): SearchLedgerHash {
  return hashCanonical(
    [...tasks].sort((left, right) => compareCodeUnits(left.taskId, right.taskId)),
  )
}

/** 128 bits of SHA-256 over the canonical encoding: collision-safe and short
 * enough for directory names. */
function shortDigest(value: unknown): string {
  return createHash('sha256').update(canonicalString(value)).digest('hex').slice(0, 32)
}

const MAX_LABEL_CHARS = 200
const USD_TOLERANCE = 1e-9
/** A claim tests at most this many finalists against the root. */
export const SEARCH_CLAIM_MAX_FINALISTS = 3
const SPLITS: readonly SearchSplit[] = ['train', 'selection', 'test']

export interface SearchDecisionRecord {
  sequence: number
  decision: SearchNodeDecision
  basis: NodeEstimate | null
  rule: string
  reason: string
}

export interface SearchSpend {
  knownUsd: number
  floorUsd: number
  unknownCostCells: number
  boxMinutes: number
}

/** Scores of one node on one unit of one split: the sum and count of its
 * scored cells. Repeats and sibling tasks of the unit average inside it. */
export interface SearchUnitScore {
  unitId: string
  sum: number
  count: number
  mean: number
}

/** A cell's scored attempt: the inputs of every per-unit statistic. */
export interface SearchScoredCell {
  cellId: string
  unitId: string
  /** The attempt that produced the score, which is the cell's last. */
  attempt: number
  score: number
}

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

export interface SearchNode {
  nodeId: string
  /** Registration order; the root is 0. */
  ordinal: number
  artifactDigest: SearchLedgerHash
  artifact: SearchArtifactRef
  surfaces: readonly SearchCandidateSurface[]
  /** First in-search parent of the node's first edge; null for the root, a
   * derived root, or a node whose parents are unknown. */
  primaryParentId: string | null
  /** Edges from the root along primary parents; null while unknown. */
  depth: number | null
  /** Every parent named by any edge into the node, in edge order. */
  parents: readonly SearchNodeRef[]
  children: readonly string[]
  edgeIds: readonly string[]
  status: SearchNodeStatus | null
  rung: number | null
  /** The node was decided `finalist` at some point, so its test cells are legal. */
  finalist: boolean
  decisions: readonly SearchDecisionRecord[]
  cellCount: number
  spend: SearchSpend
  registeredSequence: number
  updatedSequence: number
}

export interface SearchCell {
  cellId: string
  nodeId: string
  taskId: string
  unitId: string
  split: SearchSplit
  rep: number
  stage: SearchCellStage
  lane: string | null
  reservation: SearchReservation | null
  attempts: number
  lastRunId: string | null
  outcome: SearchTaskOutcome['status'] | null
  /** Score of the scored attempt; null when no attempt was scored. */
  score: number | null
  /** No further attempt is legal: a scored or non-retryable outcome. */
  final: boolean
  cancelled: SearchCellCancelledEvent['reason'] | null
  /** Known cost plus proven floors across attempts. */
  spentUsd: number
  /** Every attempt's cost is known. */
  costKnown: boolean
  traceId: string | null
  allocatedSequence: number
  updatedSequence: number
}

export interface SearchOperation {
  operationId: string
  operationKind: SearchOperationKind
  reservation: SearchReservation | null
  recorded: boolean
  /** The recorded outcome; null until the operation is recorded. */
  outcome: SearchOperationRecordedEvent['outcome']['status'] | null
  /** Artifacts the started event bound, then those the recorded event bound,
   * for example a claim's plan or a proposal's output. */
  artifacts: readonly SearchArtifactRef[]
  spentUsd: number
}

export interface SearchCompletion {
  complete: boolean
  reasons: string[]
}

interface NodeRecord {
  event: SearchNodeRegisteredEvent
  ordinal: number
  registeredSequence: number
  updatedSequence: number
  edgeIds: string[]
  parents: SearchNodeRef[]
  parentKeys: Set<string>
  primaryParentId: string | null
  depth: number | null
  children: string[]
  decisions: SearchDecisionRecord[]
  finalist: boolean
  cellIds: string[]
  scoredCells: number
  spend: SearchSpend
}

type CellRecord = SearchCell
type OperationRecord = SearchOperation

/**
 * The pure, incremental projection of one search ledger. `apply` refuses any
 * entry that breaks an invariant; the journal then discards this instance and
 * replays into a new one, so a refused entry leaves no partial state behind.
 */
export class SearchState implements LedgerProjector<SearchLedgerEntry, SearchStateView> {
  readonly searchId: string
  private version = 0
  private header: SearchOpenedEvent | null = null
  private closed: SearchClosedEvent | null = null
  private head: { sequence: number; entryHash: SearchLedgerHash } | null = null
  private lastOccurredAt = Number.NEGATIVE_INFINITY
  private lastOccurredAtText: string | null = null
  private readonly tasks = new Map<string, { split: SearchSplit; unitId: string }>()
  private readonly nodes = new Map<string, NodeRecord>()
  private readonly nodeOrder: string[] = []
  private readonly nodeByDigest = new Map<string, string>()
  private readonly edges = new Map<string, SearchEdgeRecordedEvent>()
  private readonly edgeOrder: string[] = []
  private readonly cells = new Map<string, CellRecord>()
  private readonly operations = new Map<string, OperationRecord>()
  private selectedNodeId: string | null = null
  private claimUsedUsd = 0
  /** Nodes ever decided `finalist`. */
  private readonly finalists = new Set<string>()
  /** Claim cells allocated. Once one exists, the finalists are fixed. */
  private claimCells = 0
  private readonly audit: SearchAudit

  constructor(searchId: string) {
    this.searchId = searchId
    this.audit = {
      searchId,
      eventCount: 0,
      headHash: null,
      status: 'open',
      closeReason: null,
      nodes: 0,
      nodesWithoutEdge: 0,
      undecidedNodes: 0,
      selectedNodeId: null,
      edges: { explicit: 0, correlated: 0, unknown: 0, reproposals: 0 },
      cells: { allocated: 0, settled: 0, cancelled: 0, open: 0 },
      attempts: 0,
      outcomes: { passed: 0, failed: 0, errored: 0 },
      operations: { started: 0, recorded: 0, open: 0 },
      spend: {
        knownUsd: 0,
        floorUsd: 0,
        unknownCostCells: 0,
        unknownCostOperations: 0,
        committedUsd: 0,
        openReservationUsd: 0,
        overspendUsd: 0,
        unreservedCells: 0,
        boxMinutes: 0,
      },
      tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, unknownTokenAttempts: 0 },
    }
  }

  apply(entry: SearchLedgerEntry, index: number): void {
    const event = entry.event
    if (this.closed) {
      throw integrity(`event ${event.eventId} follows search-closed ${this.closed.eventId}`)
    }
    const occurredAt = Date.parse(event.occurredAt)
    if (occurredAt < this.lastOccurredAt) {
      throw integrity(`event ${event.eventId} occurred before the preceding event`)
    }
    assertUnique(event.artifacts.map(artifactKey), 'artifact receipt', event.eventId)
    if (event.kind === 'search-opened') {
      if (index !== 0 || this.header) {
        throw integrity('search-opened must be the first and only opening event')
      }
      this.open(event)
    } else {
      if (!this.header) {
        throw integrity(`event ${event.eventId} appears before search-opened`)
      }
      this.applyEvent(event, index)
    }
    this.lastOccurredAt = occurredAt
    this.lastOccurredAtText = event.occurredAt
    this.head = { sequence: index, entryHash: entry.entryHash }
    this.audit.eventCount = index + 1
    this.audit.headHash = entry.entryHash
    this.version += 1
  }

  snapshot(): SearchStateView {
    return new SearchStateView(this, this.version)
  }

  /** @internal Views check this before every read of the live indexes. */
  isAt(version: number): boolean {
    return this.version === version
  }

  private applyEvent(event: Exclude<SearchLedgerEvent, SearchOpenedEvent>, index: number): void {
    switch (event.kind) {
      case 'operation-started':
        this.startOperation(event)
        return
      case 'operation-recorded':
        this.recordOperation(event)
        return
      case 'node-registered':
        this.registerNode(event, index)
        return
      case 'edge-recorded':
        this.recordEdge(event, index)
        return
      case 'cell-allocated':
        this.allocateCell(event, index)
        return
      case 'cell-settled':
        this.settleCell(event, index)
        return
      case 'cell-cancelled':
        this.cancelCell(event, index)
        return
      case 'node-decided':
        this.decideNode(event, index)
        return
      case 'search-closed':
        this.close(event)
        return
    }
  }

  private open(event: SearchOpenedEvent): void {
    if (event.containment?.searchId === this.searchId) {
      throw integrity('a search cannot contain itself')
    }
    if (event.derivedFrom?.searchId === this.searchId) {
      throw integrity('a search cannot derive from itself')
    }
    const units: Record<SearchSplit, Set<string>> = {
      train: new Set(),
      selection: new Set(),
      test: new Set(),
    }
    for (const split of SPLITS) {
      const { tasks, taskSetDigest } = event.splits[split]
      if (searchTaskSetDigest(tasks) !== taskSetDigest) {
        throw integrity(`the ${split} split's taskSetDigest does not match its tasks`)
      }
      for (const task of tasks) {
        const owner = this.tasks.get(task.taskId)
        if (owner) {
          throw integrity(`task ${task.taskId} is in both the ${owner.split} and ${split} splits`)
        }
        this.tasks.set(task.taskId, { split, unitId: task.unitId })
        units[split].add(task.unitId)
      }
    }
    if (event.splits.heldOutUnits) {
      const seen = [...units.test].filter(
        (unit) => units.train.has(unit) || units.selection.has(unit),
      )
      if (seen.length > 0) {
        throw integrity(
          `test units ${seen.join(', ')} also appear in train or selection, but the splits declare heldOutUnits`,
        )
      }
    }
    const { budget } = event
    if (budget.maxUsd !== null && budget.reservedClaimUsd > budget.maxUsd + USD_TOLERANCE) {
      throw integrity(
        `the claim reserve $${budget.reservedClaimUsd} exceeds the search cap $${budget.maxUsd}`,
      )
    }
    this.header = event
  }

  private startOperation(event: SearchOperationStartedEvent): void {
    if (this.operations.has(event.operationId)) {
      throw integrity(`operation ${event.operationId} was started twice`)
    }
    this.assertSearching(`operation ${event.operationId}`)
    this.admit(event.reservation, false, `operation ${event.operationId}`)
    this.operations.set(event.operationId, {
      operationId: event.operationId,
      operationKind: event.operationKind,
      reservation: event.reservation,
      recorded: false,
      outcome: null,
      artifacts: event.artifacts,
      spentUsd: 0,
    })
    this.audit.operations.started += 1
    this.audit.operations.open += 1
    this.audit.spend.openReservationUsd += event.reservation?.usd ?? 0
  }

  private recordOperation(event: SearchOperationRecordedEvent): void {
    const operation = this.operations.get(event.operationId)
    if (!operation) {
      throw integrity(`operation ${event.operationId} was recorded before it started`)
    }
    if (operation.recorded) {
      throw integrity(`operation ${event.operationId} was recorded twice`)
    }
    if (operation.operationKind !== event.operationKind) {
      throw integrity(
        `operation ${event.operationId} started as ${operation.operationKind} but recorded as ${event.operationKind}`,
      )
    }
    const cost = this.book(event.accounting)
    if (cost.unknown) this.audit.spend.unknownCostOperations += 1
    const reserved = operation.reservation?.usd ?? 0
    this.audit.spend.openReservationUsd -= reserved
    if (operation.reservation) {
      this.audit.spend.overspendUsd += Math.max(0, cost.usd - reserved)
    }
    operation.recorded = true
    operation.outcome = event.outcome.status
    operation.artifacts = [...operation.artifacts, ...event.artifacts]
    operation.spentUsd = cost.usd
    this.audit.operations.recorded += 1
    this.audit.operations.open -= 1
  }

  private registerNode(event: SearchNodeRegisteredEvent, index: number): void {
    const expected = searchNodeId(this.searchId, event.artifactDigest)
    if (event.nodeId !== expected) {
      throw integrity(
        `node ${event.nodeId} does not match its artifact digest (expected ${expected})`,
      )
    }
    if (this.nodes.has(event.nodeId)) {
      throw integrity(
        `node ${event.nodeId} was registered twice; a re-proposal is a second edge into it`,
      )
    }
    this.assertSearching(`node ${event.nodeId}`)
    assertUnique(
      event.surfaces.map((surface) => surface.surfaceId),
      'surfaceId',
      event.eventId,
    )
    const maxNodes = this.header!.budget.maxNodes
    if (maxNodes !== null && this.nodes.size + 1 > maxNodes) {
      throw integrity(`node ${event.nodeId} exceeds the search's maxNodes ${maxNodes}`)
    }
    this.nodes.set(event.nodeId, {
      event,
      ordinal: this.nodeOrder.length,
      registeredSequence: index,
      updatedSequence: index,
      edgeIds: [],
      parents: [],
      parentKeys: new Set(),
      primaryParentId: null,
      depth: null,
      children: [],
      decisions: [],
      finalist: false,
      cellIds: [],
      scoredCells: 0,
      spend: { knownUsd: 0, floorUsd: 0, unknownCostCells: 0, boxMinutes: 0 },
    })
    this.nodeOrder.push(event.nodeId)
    this.nodeByDigest.set(event.artifactDigest, event.nodeId)
    this.audit.nodes += 1
    this.audit.nodesWithoutEdge += 1
    this.audit.undecidedNodes += 1
  }

  private recordEdge(event: SearchEdgeRecordedEvent, index: number): void {
    if (this.edges.has(event.edgeId)) {
      throw integrity(`edge ${event.edgeId} was recorded twice`)
    }
    const child = this.nodes.get(event.childNodeId)
    if (!child) {
      throw integrity(`edge ${event.edgeId} names unregistered child ${event.childNodeId}`)
    }
    this.assertSearching(`edge ${event.edgeId}`)
    if (event.label.length > MAX_LABEL_CHARS) {
      throw integrity(`edge ${event.edgeId} label exceeds ${MAX_LABEL_CHARS} characters`)
    }
    if (event.diffs.length !== event.parents.length) {
      throw integrity(`edge ${event.edgeId} needs one diff per parent`)
    }
    assertUnique(
      event.parents.map((parent) => canonicalString(parent)),
      'parent',
      event.eventId,
    )
    const { operator, attribution, parents } = event
    if ((operator === 'seed') !== (event.proposer === null)) {
      throw integrity(`edge ${event.edgeId}: exactly the seed edge has no proposer`)
    }
    if (operator === 'seed' && (parents.length > 0 || attribution === 'unknown')) {
      throw integrity(`seed edge ${event.edgeId} must have no parents and a known attribution`)
    }
    if (attribution === 'unknown' && parents.length > 0) {
      throw integrity(`edge ${event.edgeId} has unknown attribution but names parents`)
    }
    if (operator !== 'seed' && attribution !== 'unknown' && parents.length === 0) {
      throw integrity(`${operator} edge ${event.edgeId} names no parent`)
    }
    if (operator === 'merge' && attribution !== 'unknown' && parents.length < 2) {
      throw integrity(`merge edge ${event.edgeId} needs at least two parents`)
    }
    const operationId = event.proposer?.operationId ?? null
    if (operationId !== null && !this.operations.has(operationId)) {
      throw integrity(`edge ${event.edgeId} names operation ${operationId}, which never started`)
    }
    const inSearch: NodeRecord[] = []
    for (const parent of parents) {
      if (parent.searchId !== this.searchId) {
        const from = this.header!.derivedFrom
        if (
          operator !== 'derive' ||
          parents.length !== 1 ||
          !from ||
          from.searchId !== parent.searchId ||
          from.nodeId !== parent.nodeId
        ) {
          throw integrity(
            `edge ${event.edgeId} names a parent in search ${parent.searchId}; only a derive edge matching derivedFrom may`,
          )
        }
        continue
      }
      if (operator === 'derive') {
        throw integrity(`derive edge ${event.edgeId} must name the parent in derivedFrom`)
      }
      const record = this.nodes.get(parent.nodeId)
      if (!record) {
        throw integrity(`edge ${event.edgeId} names unregistered parent ${parent.nodeId}`)
      }
      if (record.ordinal >= child.ordinal) {
        throw integrity(
          `edge ${event.edgeId}: parent ${parent.nodeId} registered after child ${child.event.nodeId}`,
        )
      }
      if (record.edgeIds.length === 0) {
        throw integrity(`edge ${event.edgeId}: parent ${parent.nodeId} has no edge of its own yet`)
      }
      if (record.decisions.at(-1)?.decision.status === 'invalid') {
        throw integrity(
          `edge ${event.edgeId}: parent ${parent.nodeId} was decided invalid, and an invalid node never becomes a parent`,
        )
      }
      inSearch.push(record)
    }

    if (child.edgeIds.length === 0) {
      const primary = inSearch[0]
      child.primaryParentId = primary?.event.nodeId ?? null
      child.depth =
        operator === 'seed' || operator === 'derive'
          ? 0
          : primary && primary.depth !== null
            ? primary.depth + 1
            : null
      this.audit.nodesWithoutEdge -= 1
    } else {
      this.audit.edges.reproposals += 1
    }
    child.edgeIds.push(event.edgeId)
    for (const parent of parents) {
      const key = canonicalString(parent)
      if (child.parentKeys.has(key)) continue
      child.parentKeys.add(key)
      child.parents.push(parent)
    }
    for (const parent of inSearch) {
      if (!parent.children.includes(child.event.nodeId)) parent.children.push(child.event.nodeId)
    }
    child.updatedSequence = index
    this.edges.set(event.edgeId, event)
    this.edgeOrder.push(event.edgeId)
    this.audit.edges[attribution] += 1
  }

  private allocateCell(event: SearchCellAllocatedEvent, index: number): void {
    const expected = searchCellId(this.searchId, event.nodeId, event.taskId, event.split, event.rep)
    if (event.cellId !== expected) {
      throw integrity(`cell ${event.cellId} does not match its coordinates (expected ${expected})`)
    }
    if (this.cells.has(event.cellId)) {
      throw integrity(`cell ${event.cellId} was allocated twice`)
    }
    const node = this.nodes.get(event.nodeId)
    if (!node) throw integrity(`cell ${event.cellId} names unregistered node ${event.nodeId}`)
    if (node.edgeIds.length === 0) {
      throw integrity(`cell ${event.cellId}: node ${event.nodeId} has no edge yet`)
    }
    const task = this.tasks.get(event.taskId)
    if (!task || task.split !== event.split) {
      throw integrity(
        `cell ${event.cellId}: task ${event.taskId} is not in the ${event.split} split`,
      )
    }
    if (task.unitId !== event.unitId) {
      throw integrity(`cell ${event.cellId}: task ${event.taskId} samples unit ${task.unitId}`)
    }
    assertStageSplit(event.cellId, event.stage, event.split, node.ordinal === 0)
    if (event.split === 'test' && node.ordinal !== 0 && !node.finalist) {
      throw integrity(
        `cell ${event.cellId}: the test split is sealed; only the root and finalists run on it`,
      )
    }
    if (event.stage !== 'claim') this.assertSearching(`cell ${event.cellId}`)
    const maxCells = this.header!.budget.maxCells
    if (maxCells !== null && this.audit.cells.allocated + 1 > maxCells) {
      throw integrity(`cell ${event.cellId} exceeds the search's maxCells ${maxCells}`)
    }
    this.admit(event.reservation, event.stage === 'claim', `cell ${event.cellId}`)
    this.cells.set(event.cellId, {
      cellId: event.cellId,
      nodeId: event.nodeId,
      taskId: event.taskId,
      unitId: event.unitId,
      split: event.split,
      rep: event.rep,
      stage: event.stage,
      lane: event.lane,
      reservation: event.reservation,
      attempts: 0,
      lastRunId: null,
      outcome: null,
      score: null,
      final: false,
      cancelled: null,
      spentUsd: 0,
      costKnown: true,
      traceId: null,
      allocatedSequence: index,
      updatedSequence: index,
    })
    node.cellIds.push(event.cellId)
    node.updatedSequence = index
    this.audit.cells.allocated += 1
    this.audit.cells.open += 1
    this.audit.spend.openReservationUsd += event.reservation?.usd ?? 0
    if (event.stage === 'claim') {
      this.claimUsedUsd += event.reservation?.usd ?? 0
      this.claimCells += 1
    }
  }

  private settleCell(event: SearchCellSettledEvent, index: number): void {
    const cell = this.cells.get(event.cellId)
    if (!cell) throw integrity(`attempt ${event.eventId} names unallocated cell ${event.cellId}`)
    if (cell.cancelled) throw integrity(`cell ${event.cellId} was settled after it was cancelled`)
    if (cell.final) {
      throw integrity(
        `cell ${event.cellId} was attempted again after a final ${cell.outcome} outcome; only a retryable error admits another attempt`,
      )
    }
    if (event.attempt !== cell.attempts + 1) {
      throw integrity(
        `cell ${event.cellId} attempt ${event.attempt} is not contiguous (expected ${cell.attempts + 1})`,
      )
    }
    const runId = searchCellRunId({ cellId: event.cellId, attempt: event.attempt })
    if (event.runId !== runId) {
      throw integrity(`cell ${event.cellId} attempt ${event.attempt} must have runId ${runId}`)
    }
    const node = this.nodes.get(cell.nodeId)!
    const declared = new Set(node.event.surfaces.map((surface) => surface.surfaceId))
    assertUnique(
      event.surfaceEvidence.map((evidence) => evidence.surfaceId),
      'surface evidence',
      event.eventId,
    )
    for (const evidence of event.surfaceEvidence) {
      if (!declared.has(evidence.surfaceId)) {
        throw integrity(
          `attempt ${event.eventId} reports surface ${evidence.surfaceId}, which node ${cell.nodeId} does not declare`,
        )
      }
    }
    if (event.artifacts.filter((artifact) => artifact.role === 'run-record').length > 1) {
      throw integrity(`attempt ${event.eventId} binds more than one RunRecord`)
    }

    const before = this.reservationParts(cell)
    const cost = this.book(event.accounting)
    if (cell.attempts === 0) {
      this.audit.cells.settled += 1
      this.audit.cells.open -= 1
      if (cell.reservation === null) this.audit.spend.unreservedCells += 1
    }
    if (cost.unknown && cell.costKnown) {
      cell.costKnown = false
      this.audit.spend.unknownCostCells += 1
      node.spend.unknownCostCells += 1
    }
    cell.attempts = event.attempt
    cell.lastRunId = runId
    cell.outcome = event.outcome.status
    cell.spentUsd += cost.usd
    cell.updatedSequence = index
    if ('traceId' in event.traceRef) cell.traceId = event.traceRef.traceId
    if (event.outcome.status === 'errored') {
      cell.final = !event.outcome.error.retryable
    } else {
      cell.final = true
      cell.score = event.outcome.score
      node.scoredCells += 1
    }
    const after = this.reservationParts(cell)
    this.audit.spend.openReservationUsd += after.open - before.open
    this.audit.spend.overspendUsd += after.over - before.over
    if (cell.stage === 'claim') this.claimUsedUsd += after.used - before.used

    if (cost.unknown) node.spend.floorUsd += cost.usd
    else node.spend.knownUsd += cost.usd
    const boxMinutes = event.boxMinutes ?? 0
    node.spend.boxMinutes += boxMinutes
    this.audit.spend.boxMinutes += boxMinutes
    node.updatedSequence = index
    this.audit.attempts += 1
    this.audit.outcomes[event.outcome.status] += 1
  }

  private cancelCell(event: SearchCellCancelledEvent, index: number): void {
    const cell = this.cells.get(event.cellId)
    if (!cell)
      throw integrity(`cancellation ${event.eventId} names unallocated cell ${event.cellId}`)
    if (cell.cancelled) throw integrity(`cell ${event.cellId} was cancelled twice`)
    if (cell.final) throw integrity(`cell ${event.cellId} was cancelled after a final outcome`)
    const before = this.reservationParts(cell)
    cell.cancelled = event.reason
    cell.updatedSequence = index
    const after = this.reservationParts(cell)
    this.audit.spend.openReservationUsd += after.open - before.open
    this.audit.spend.overspendUsd += after.over - before.over
    if (cell.stage === 'claim') this.claimUsedUsd += after.used - before.used
    if (cell.attempts === 0) {
      this.audit.cells.cancelled += 1
      this.audit.cells.open -= 1
    }
    this.nodes.get(cell.nodeId)!.updatedSequence = index
  }

  private decideNode(event: SearchNodeDecidedEvent, index: number): void {
    const node = this.nodes.get(event.nodeId)
    if (!node) throw integrity(`decision ${event.eventId} names unregistered node ${event.nodeId}`)
    if (node.edgeIds.length === 0) {
      throw integrity(`decision ${event.eventId}: node ${event.nodeId} has no edge yet`)
    }
    const status = event.decision.status
    if (status === 'finalist' && !this.finalists.has(event.nodeId)) {
      if (node.ordinal === 0) {
        throw integrity(`the root ${event.nodeId} is the claim's control and cannot be a finalist`)
      }
      if (this.claimCells > 0) {
        throw integrity(
          `node ${event.nodeId} was decided finalist after a claim cell ran; the finalists are fixed before the test`,
        )
      }
      if (this.finalists.size >= SEARCH_CLAIM_MAX_FINALISTS) {
        throw integrity(
          `node ${event.nodeId} would be finalist ${this.finalists.size + 1}; at most ${SEARCH_CLAIM_MAX_FINALISTS} are allowed`,
        )
      }
      this.finalists.add(event.nodeId)
    }
    if (status === 'selected') {
      if (this.selectedNodeId !== null && this.selectedNodeId !== event.nodeId) {
        throw integrity(
          `node ${event.nodeId} was selected while ${this.selectedNodeId} is still selected`,
        )
      }
      if (node.scoredCells === 0) {
        throw integrity(`node ${event.nodeId} cannot be selected without a scored cell`)
      }
    }
    const previous = node.decisions.at(-1)?.decision.status ?? null
    const wasUndecided = previous === null || previous === 'advanced'
    const isUndecided = status === 'advanced'
    this.audit.undecidedNodes += (isUndecided ? 1 : 0) - (wasUndecided ? 1 : 0)
    if (previous === 'selected' && status !== 'selected') this.selectedNodeId = null
    if (status === 'selected') this.selectedNodeId = event.nodeId
    if (status === 'finalist') node.finalist = true
    node.decisions.push({
      sequence: index,
      decision: event.decision,
      basis: event.basis,
      rule: event.rule,
      reason: event.reason,
    })
    node.updatedSequence = index
    this.audit.selectedNodeId = this.selectedNodeId
  }

  private close(event: SearchClosedEvent): void {
    const reasons = this.incompleteReasons()
    if (reasons.length > 0) {
      throw integrity(`search-closed while incomplete: ${reasons.join('; ')}`)
    }
    if (event.claim) this.checkClaim(event.claim)
    this.closed = event
    this.audit.status = 'closed'
    this.audit.closeReason = event.reason
    // Nothing runs after the close, so every hold is released.
    this.audit.spend.openReservationUsd = 0
  }

  private checkClaim(claim: SearchClaim): void {
    const named = claim.finalists.map((finalist) => finalist.nodeId)
    assertUnique(named, 'claim finalist', 'search-closed')
    for (const nodeId of named) {
      if (!this.finalists.has(nodeId)) {
        throw integrity(`claim finalist ${nodeId} was never decided finalist`)
      }
    }
    // Every finalist stays in the family the confidence is divided among, so
    // a finalist that lost cannot be dropped to relax the correction.
    for (const nodeId of this.finalists) {
      if (!named.includes(nodeId)) {
        throw integrity(`finalist ${nodeId} is missing from the claim`)
      }
    }
    const root = this.nodeOrder[0] ?? null
    const perFinalist = 1 - (1 - claim.confidence) / Math.max(1, named.length)
    for (const finalist of claim.finalists) {
      const { estimate, test } = finalist
      if (estimate && (estimate.against !== root || estimate.split !== 'test')) {
        throw integrity(
          `claim finalist ${finalist.nodeId} is estimated against something other than the root on test`,
        )
      }
      if (test && Math.abs(test.confidence - perFinalist) > 1e-12) {
        throw integrity(
          `claim finalist ${finalist.nodeId} is tested at confidence ${test.confidence}; ${named.length} finalists at family-wise ${claim.confidence} need ${perFinalist}`,
        )
      }
      if (finalist.promote && test === null) {
        throw integrity(`claim finalist ${finalist.nodeId} is promoted without a test`)
      }
    }
    if (claim.selected !== this.selectedNodeId) {
      throw integrity(
        `the claim selects ${claim.selected ?? 'nothing'} but the selected node is ${this.selectedNodeId ?? 'none'}`,
      )
    }
    if (claim.decision === 'ship') {
      const shipped = claim.finalists.find((finalist) => finalist.nodeId === claim.selected)
      if (claim.selected === null || claim.selected === root || !shipped?.promote) {
        throw integrity('a ship claim must select a finalist that the paired test promoted')
      }
      if (!this.header!.splits.heldOutUnits) {
        throw integrity('a ship claim needs test units held out from train and selection')
      }
      if ('unknown' in this.header!.objective.judge) {
        throw integrity(
          "a ship claim needs a pinned judge; with an unknown judge a resumed search could mix two judges' verdicts",
        )
      }
      const testUnits = new Set(this.header!.splits.test.tasks.map((task) => task.unitId))
      for (const nodeId of [root!, claim.selected]) {
        const scored = new Set(this.readScoredCells(nodeId, 'test').map((cell) => cell.unitId))
        const missing = [...testUnits].filter((unit) => !scored.has(unit))
        if (missing.length > 0) {
          throw integrity(
            `a ship claim needs every test unit scored by the root and the finalist; ${nodeId} has none on ${missing.join(', ')}`,
          )
        }
      }
    } else if (claim.selected !== null && claim.selected !== root) {
      throw integrity(`a ${claim.decision} claim keeps the root; it cannot select another node`)
    }
    if (claim.decision === 'test-cannot-resolve') {
      for (const cell of this.cells.values()) {
        if (cell.split === 'test' && cell.attempts > 0) {
          throw integrity('a test-cannot-resolve claim spends nothing on test cells')
        }
      }
    }
  }

  /** Once the first finalist is decided, the search only runs its claim:
   * nothing new is proposed, registered or allocated outside the test. */
  private assertSearching(subject: string): void {
    if (this.finalists.size > 0 || this.claimCells > 0) {
      throw integrity(
        `${subject} follows the start of the claim; the search stopped when its finalists were decided`,
      )
    }
  }

  /** @internal */
  incompleteReasons(): string[] {
    const reasons: string[] = []
    if (!this.header) reasons.push('search-opened is missing')
    if (this.audit.cells.open > 0)
      reasons.push(count(this.audit.cells.open, 'cell', 'has no outcome'))
    if (this.audit.operations.open > 0) {
      reasons.push(count(this.audit.operations.open, 'operation', 'is unrecorded'))
    }
    if (this.audit.nodesWithoutEdge > 0) {
      reasons.push(count(this.audit.nodesWithoutEdge, 'node', 'has no edge'))
    }
    if (this.audit.undecidedNodes > 0) {
      reasons.push(count(this.audit.undecidedNodes, 'node', 'has no terminal decision'))
    }
    return reasons
  }

  /** Book an attempt's or operation's accounting into the running totals. An
   * unknown cost counts as its proven floor. */
  private book(accounting: SearchAttemptAccounting): { usd: number; unknown: boolean } {
    const { tokens, cost } = accounting
    if (tokens.status === 'known') {
      this.audit.tokens.inputTokens += tokens.inputTokens
      this.audit.tokens.outputTokens += tokens.outputTokens
      this.audit.tokens.cachedTokens += tokens.cachedTokens
    } else {
      this.audit.tokens.unknownTokenAttempts += 1
    }
    const usd = cost.status === 'known' ? cost.usd : cost.knownLowerBoundUsd
    if (cost.status === 'known') this.audit.spend.knownUsd += usd
    else this.audit.spend.floorUsd += usd
    this.audit.spend.committedUsd += usd
    return { usd, unknown: cost.status === 'unknown' }
  }

  /** A cell's share of the open reservations, its overspend, and what it draws
   * from the claim reserve: the larger of its hold and its spend. */
  private reservationParts(cell: CellRecord): { open: number; over: number; used: number } {
    const reserved = cell.reservation?.usd ?? 0
    const holding = !cell.final && cell.cancelled === null
    return {
      open: holding ? Math.max(0, reserved - cell.spentUsd) : 0,
      over: cell.reservation ? Math.max(0, cell.spentUsd - reserved) : 0,
      used: holding ? Math.max(reserved, cell.spentUsd) : cell.spentUsd,
    }
  }

  /** The admission rule: committed spend, open holds, the unspent claim
   * reserve and the new hold stay within the cap. A claim cell draws on the
   * claim reserve instead of adding to it. */
  private admit(reservation: SearchReservation | null, claim: boolean, subject: string): void {
    const { maxUsd, reservedClaimUsd } = this.header!.budget
    if (maxUsd === null) return
    const hold = reservation?.usd ?? 0
    const remainingClaim = Math.max(0, reservedClaimUsd - this.claimUsedUsd)
    const total =
      this.audit.spend.committedUsd +
      this.audit.spend.openReservationUsd +
      (claim ? Math.max(0, remainingClaim - hold) : remainingClaim) +
      hold
    if (total > maxUsd + USD_TOLERANCE) {
      throw integrity(
        `${subject} is not admissible: committed $${round(this.audit.spend.committedUsd)} + open $${round(this.audit.spend.openReservationUsd)} + claim reserve $${round(remainingClaim)} + hold $${round(hold)} exceeds the cap $${maxUsd}`,
      )
    }
  }

  // ── Reads, for SearchStateView ─────────────────────────────────────────

  /** @internal The largest hold a new non-claim cell or operation may take,
   * and the claim reserve still unspent. */
  readBudget(): { headroomUsd: number | null; claimReserveUsd: number } {
    const { maxUsd, reservedClaimUsd } = this.header?.budget ?? {
      maxUsd: null,
      reservedClaimUsd: 0,
    }
    const claimReserveUsd = Math.max(0, reservedClaimUsd - this.claimUsedUsd)
    if (maxUsd === null) return { headroomUsd: null, claimReserveUsd }
    const used =
      this.audit.spend.committedUsd + this.audit.spend.openReservationUsd + claimReserveUsd
    return { headroomUsd: Math.max(0, maxUsd - used), claimReserveUsd }
  }

  /** @internal */
  readHeader(): SearchOpenedEvent | null {
    return this.header
  }

  /** @internal */
  readClosed(): SearchClosedEvent | null {
    return this.closed
  }

  /** @internal */
  readHead(): { sequence: number; entryHash: SearchLedgerHash } | null {
    return this.head
  }

  /** @internal */
  readLastOccurredAt(): string | null {
    return this.lastOccurredAtText
  }

  /** @internal */
  readAudit(): SearchAudit {
    const audit = this.audit
    return {
      ...audit,
      edges: { ...audit.edges },
      cells: { ...audit.cells },
      outcomes: { ...audit.outcomes },
      operations: { ...audit.operations },
      spend: { ...audit.spend },
      tokens: { ...audit.tokens },
    }
  }

  /** @internal */
  readNode(nodeId: string): SearchNode | undefined {
    const record = this.nodes.get(nodeId)
    return record ? nodeView(record) : undefined
  }

  /** @internal */
  readNodeIds(): readonly string[] {
    return this.nodeOrder
  }

  /** @internal */
  readHasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId)
  }

  /** @internal */
  readNodeIdForDigest(artifactDigest: string): string | undefined {
    return this.nodeByDigest.get(artifactDigest)
  }

  /** @internal */
  readEdge(edgeId: string): SearchEdgeRecordedEvent | undefined {
    return this.edges.get(edgeId)
  }

  /** @internal */
  readEdgeIds(): readonly string[] {
    return this.edgeOrder
  }

  /** @internal */
  readCell(cellId: string): SearchCell | undefined {
    const cell = this.cells.get(cellId)
    return cell ? { ...cell } : undefined
  }

  /** @internal */
  readCellIds(nodeId?: string): readonly string[] {
    if (nodeId === undefined) return [...this.cells.keys()]
    return this.nodes.get(nodeId)?.cellIds ?? []
  }

  /** @internal */
  readOperation(operationId: string): SearchOperation | undefined {
    const operation = this.operations.get(operationId)
    return operation ? { ...operation } : undefined
  }

  /** @internal */
  readScoredCells(nodeId: string, split: SearchSplit): SearchScoredCell[] {
    const scored: SearchScoredCell[] = []
    for (const cellId of this.nodes.get(nodeId)?.cellIds ?? []) {
      const cell = this.cells.get(cellId)!
      if (cell.split === split && cell.score !== null) {
        scored.push({ cellId, unitId: cell.unitId, attempt: cell.attempts, score: cell.score })
      }
    }
    return scored
  }
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
    this.header = state.readHeader()
    this.closed = state.readClosed()
    this.head = state.readHead()
    this.lastOccurredAt = state.readLastOccurredAt()
    this.audit = state.readAudit()
    this.budget = state.readBudget()
    const reasons = state.incompleteReasons()
    if (!this.closed) reasons.unshift('search is open')
    this.completion = { complete: this.closed !== null, reasons }
  }

  /** The node the search started from: the first registered. */
  get rootNodeId(): string | null {
    return this.live().readNodeIds()[0] ?? null
  }

  node(nodeId: string): SearchNode | undefined {
    return this.live().readNode(nodeId)
  }

  hasNode(nodeId: string): boolean {
    return this.live().readHasNode(nodeId)
  }

  /** Node ids in registration order. */
  nodeIds(): string[] {
    return [...this.live().readNodeIds()]
  }

  /** Nodes in registration order. */
  nodes(): SearchNode[] {
    const state = this.live()
    return state.readNodeIds().map((nodeId) => state.readNode(nodeId)!)
  }

  nodeIdForDigest(artifactDigest: string): string | undefined {
    return this.live().readNodeIdForDigest(artifactDigest)
  }

  edge(edgeId: string): SearchEdgeRecordedEvent | undefined {
    return this.live().readEdge(edgeId)
  }

  /** Edges in ledger order. */
  edges(): SearchEdgeRecordedEvent[] {
    const state = this.live()
    return state.readEdgeIds().map((edgeId) => state.readEdge(edgeId)!)
  }

  cell(cellId: string): SearchCell | undefined {
    return this.live().readCell(cellId)
  }

  /** Cells in allocation order, optionally of one node. */
  cells(filter: { nodeId?: string } = {}): SearchCell[] {
    const state = this.live()
    return state.readCellIds(filter.nodeId).map((cellId) => state.readCell(cellId)!)
  }

  operation(operationId: string): SearchOperation | undefined {
    return this.live().readOperation(operationId)
  }

  /** A node's scored cells on one split, in allocation order. Unscored cells
   * (errored, cancelled or in flight) are absent, never zero. */
  scoredCells(nodeId: string, split: SearchSplit): SearchScoredCell[] {
    return this.live().readScoredCells(nodeId, split)
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
    const cell = state.readCell(coordinates.cellId)
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
    const node = state.readNode(cell.nodeId)!
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

  private live(): SearchState {
    if (!this.state.isAt(this.version)) {
      throw new SearchLedgerError(
        `this SearchStateView is from sequence ${this.head?.sequence ?? -1}, and the ledger has moved on; read the ledger's state again`,
      )
    }
    return this.state
  }
}

function nodeView(record: NodeRecord): SearchNode {
  const latest = record.decisions.at(-1)?.decision ?? null
  return {
    nodeId: record.event.nodeId,
    ordinal: record.ordinal,
    artifactDigest: record.event.artifactDigest,
    artifact: record.event.artifact,
    surfaces: record.event.surfaces,
    primaryParentId: record.primaryParentId,
    depth: record.depth,
    parents: [...record.parents],
    children: [...record.children],
    edgeIds: [...record.edgeIds],
    status: latest?.status ?? null,
    rung: latest?.status === 'advanced' ? latest.rung : null,
    finalist: record.finalist,
    decisions: [...record.decisions],
    cellCount: record.cellIds.length,
    spend: { ...record.spend },
    registeredSequence: record.registeredSequence,
    updatedSequence: record.updatedSequence,
  }
}

function assertStageSplit(
  cellId: string,
  stage: SearchCellStage,
  split: SearchSplit,
  isRoot: boolean,
): void {
  const allowed: Record<SearchCellStage, readonly SearchSplit[]> = {
    root: ['train', 'selection'],
    train: ['train'],
    screen: ['selection'],
    rung: ['selection'],
    claim: ['test'],
    external: ['train', 'selection'],
  }
  if (!allowed[stage].includes(split)) {
    throw integrity(`cell ${cellId}: a ${stage} cell cannot run on the ${split} split`)
  }
  if (stage === 'root' && !isRoot) {
    throw integrity(`cell ${cellId}: only the root node runs root cells`)
  }
}

function assertUnique(values: readonly string[], label: string, eventId: string): void {
  if (new Set(values).size !== values.length) {
    throw integrity(`event ${eventId} contains duplicate ${label} values`)
  }
}

function count(value: number, noun: string, predicate: string): string {
  const verb = predicate.replace(/^(has|is) /, (word) =>
    value === 1 ? word : word === 'has ' ? 'have ' : 'are ',
  )
  return `${value} ${value === 1 ? noun : `${noun}s`} ${verb}`
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}

function integrity(message: string): SearchLedgerIntegrityError {
  return new SearchLedgerIntegrityError(message)
}
