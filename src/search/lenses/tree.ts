/**
 * `tree(state)`: a tidy tree of nodes and edges — the current page (the base
 * view every other lens sits beside, search-tree-design §12).
 *
 * The design table names this lens's signal "none (base view)": it drives no
 * `SearchPolicy` and none of this group's policy wiring reads it. It still
 * returns the one named signal every lens returns, so a caller need not
 * special-case it: `tree.nodeCount`, the plain size of the tree.
 */

import type { SearchEdgeOperator, SearchNodeStatus } from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'

export interface TreeNode {
  nodeId: string
  status: SearchNodeStatus | null
  rung: number | null
  /** Edges from the root along primary parents; null when the node's
   * parents are unknown (an `unknown`-attribution edge, or a derived root). */
  depth: number | null
  cellCount: number
  knownCostUsd: number
  /** The operator of the edge that registered this node's primary parent;
   * null for the root and for a node whose parents are unknown. */
  operator: SearchEdgeOperator | null
  children: TreeNode[]
}

export interface TreeData {
  /** Normally one entry (the search's root). More than one only when a node
   * has unknown parents (`primaryParentId === null` but it is not the
   * root): such a node is shown as its own top-level entry rather than
   * folded under the root it may or may not descend from. */
  roots: TreeNode[]
  nodeCount: number
  edgeCount: number
}

export function tree(state: SearchStateView): {
  data: TreeData
  signal: { name: string; value: number }
} {
  const nodes = state.nodes()
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const childrenOf = new Map<string, string[]>()
  const topLevel: string[] = []

  for (const node of nodes) {
    if (node.primaryParentId !== null && byId.has(node.primaryParentId)) {
      const list = childrenOf.get(node.primaryParentId)
      if (list) list.push(node.nodeId)
      else childrenOf.set(node.primaryParentId, [node.nodeId])
    } else {
      topLevel.push(node.nodeId)
    }
  }

  const primaryOperator = new Map<string, SearchEdgeOperator>()
  for (const edge of state.edges()) {
    const child = byId.get(edge.childNodeId)
    if (!child) continue
    const primaryParent = edge.parents[0]?.nodeId ?? null
    if (primaryParent === child.primaryParentId && !primaryOperator.has(child.nodeId)) {
      primaryOperator.set(child.nodeId, edge.operator)
    }
  }

  const build = (nodeId: string): TreeNode => {
    const node = byId.get(nodeId)!
    return {
      nodeId: node.nodeId,
      status: node.status,
      rung: node.rung,
      depth: node.depth,
      cellCount: node.cellCount,
      knownCostUsd: node.spend.knownUsd,
      operator: primaryOperator.get(node.nodeId) ?? null,
      children: (childrenOf.get(nodeId) ?? []).map((childId) => build(childId)),
    }
  }

  return {
    data: {
      roots: topLevel.map(build),
      nodeCount: nodes.length,
      edgeCount: state.edges().length,
    },
    signal: { name: 'tree.nodeCount', value: nodes.length },
  }
}
