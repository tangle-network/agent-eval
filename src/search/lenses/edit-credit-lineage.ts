/** Ledger lineage order, parent relationships, and ordered gene membership. */
import type { SearchEdgeRecordedEvent } from '../../campaign/search-ledger-types'
import type { SearchNode, SearchStateView } from '../../campaign/search-state'
import { compareCodeUnits } from '../../ledger-core/canonical'
import type { EditLineageRow, NodeContent } from './edit-credit-contract'

export function lineageParents(
  state: SearchStateView,
  edge: SearchEdgeRecordedEvent,
  child: SearchNode,
  byId: ReadonlyMap<string, SearchNode>,
): string[] {
  const parents: string[] = []
  for (const parent of edge.parents) {
    if (parent.searchId !== state.searchId) continue
    const node = byId.get(parent.nodeId)
    if (node && node.ordinal < child.ordinal && !parents.includes(node.nodeId)) {
      parents.push(node.nodeId)
    }
  }
  return parents
}

export function lineageRows(
  state: SearchStateView,
  nodes: readonly SearchNode[],
  byId: ReadonlyMap<string, SearchNode>,
  contents: ReadonlyMap<string, NodeContent>,
  carried: ReadonlyMap<string, string[]>,
): EditLineageRow[] {
  const rows: EditLineageRow[] = []
  const placed = new Set<string>()
  const visit = (root: SearchNode) => {
    const stack = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (placed.has(node.nodeId)) continue
      placed.add(node.nodeId)
      const firstEdge = node.edgeIds[0] ? state.edge(node.edgeIds[0]) : undefined
      rows.push({
        nodeId: node.nodeId,
        ordinal: node.ordinal,
        depth: node.depth,
        primaryParentId: node.primaryParentId,
        parents: node.parents
          .filter((parent) => parent.searchId === state.searchId)
          .map((parent) => parent.nodeId),
        operator: firstEdge?.operator ?? null,
        status: node.status,
        carries: [...(carried.get(node.nodeId) ?? [])].sort(compareCodeUnits),
        contentKnown: contents.get(node.nodeId)!.known,
      })
      const children = node.children
        .map((id) => byId.get(id)!)
        .filter((child) => child.primaryParentId === node.nodeId)
        .sort((a, b) => b.ordinal - a.ordinal)
      stack.push(...children)
    }
  }
  for (const node of nodes) if (node.primaryParentId === null) visit(node)
  for (const node of nodes) visit(node)
  return rows
}

export function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

export function compareOrder(left: [number, number], right: [number, number]): number {
  return left[0] - right[0] || left[1] - right[1]
}
