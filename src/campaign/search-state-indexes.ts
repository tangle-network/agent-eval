/** The live indexes of one search ledger, and the reads a `SearchStateView` makes of them. */

import type { SearchEdgeRecordedEvent, SearchSplit } from './search-ledger-types'
import type {
  CellRecord,
  NodeRecord,
  OperationRecord,
  SearchCell,
  SearchNode,
  SearchOperation,
  SearchScoredCell,
} from './search-state-types'

export class SearchLedgerIndexes {
  readonly tasks = new Map<string, { split: SearchSplit; unitId: string }>()
  readonly nodes = new Map<string, NodeRecord>()
  readonly nodeOrder: string[] = []
  readonly nodeByDigest = new Map<string, string>()
  readonly edges = new Map<string, SearchEdgeRecordedEvent>()
  readonly edgeOrder: string[] = []
  readonly cells = new Map<string, CellRecord>()
  readonly operations = new Map<string, OperationRecord>()

  node(nodeId: string): SearchNode | undefined {
    const record = this.nodes.get(nodeId)
    return record ? nodeView(record) : undefined
  }

  nodeIds(): readonly string[] {
    return this.nodeOrder
  }

  hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId)
  }

  nodeIdForDigest(artifactDigest: string): string | undefined {
    return this.nodeByDigest.get(artifactDigest)
  }

  edge(edgeId: string): SearchEdgeRecordedEvent | undefined {
    return this.edges.get(edgeId)
  }

  edgeIds(): readonly string[] {
    return this.edgeOrder
  }

  cell(cellId: string): SearchCell | undefined {
    const cell = this.cells.get(cellId)
    return cell ? { ...cell } : undefined
  }

  cellIds(nodeId?: string): readonly string[] {
    if (nodeId === undefined) return [...this.cells.keys()]
    return this.nodes.get(nodeId)?.cellIds ?? []
  }

  operation(operationId: string): SearchOperation | undefined {
    const operation = this.operations.get(operationId)
    return operation ? { ...operation } : undefined
  }

  scoredCells(nodeId: string, split: SearchSplit): SearchScoredCell[] {
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
