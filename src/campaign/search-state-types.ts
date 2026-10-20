/** Read-model contracts and the projection's indexed search records. */

import type {
  NodeEstimate,
  SearchArtifactRef,
  SearchCandidateSurface,
  SearchCellCancelledEvent,
  SearchCellStage,
  SearchLedgerHash,
  SearchNodeDecision,
  SearchNodeRef,
  SearchNodeRegisteredEvent,
  SearchNodeStatus,
  SearchOperationKind,
  SearchOperationRecordedEvent,
  SearchReservation,
  SearchSplit,
  SearchTaskOutcome,
} from './search-ledger-types'

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
  /** Every lineage parent: each parent an edge into the node names that was
   * registered before it, in edge order. A re-proposal from the node itself
   * or from a later node adds none, so parents and children stay acyclic. */
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
  /** What ran the operation, for example a proposer's model; null until the
   * operation is recorded. */
  execution: SearchOperationRecordedEvent['execution'] | null
  /** Artifacts the started event bound, then those the recorded event bound,
   * for example a claim's plan or a proposal's output. */
  artifacts: readonly SearchArtifactRef[]
  /** Known cost, or the proven floor when `costKnown` is false. */
  spentUsd: number
  /** The recorded cost is known; false until the operation is recorded. */
  costKnown: boolean
}

export interface SearchCompletion {
  complete: boolean
  reasons: string[]
}

export interface NodeRecord {
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

export type CellRecord = SearchCell
export type OperationRecord = SearchOperation
