import { type SearchAllocator } from '../../src/campaign/allocation'
import { estimateNode } from '../../src/campaign/estimate-node'
import { searchExpansionIndex, searchPolicyView } from '../../src/campaign/search-kernel'
import { parseSearchLedgerLine, replaySearchLedgerText } from '../../src/campaign/search-ledger'
import { SearchState, type SearchStateView } from '../../src/campaign/search-state'
import { type SearchPolicy, type SearchPolicyView } from '../../src/campaign/search-policy'
import { canonicalString } from '../../src/ledger-core/canonical'
import { MAX_ATTEMPTS } from './policy'

/** No cell of the node can run again, as the kernel counts it. */
function idle(state: SearchStateView, nodeId: string): boolean {
  const node = state.node(nodeId)
  if (!node || node.edgeIds.length === 0 || node.status === 'invalid') return false
  return state
    .cells({ nodeId })
    .every(
      (cell) =>
        cell.final ||
        cell.cancelled !== null ||
        (cell.outcome === 'errored' && cell.attempts >= MAX_ATTEMPTS),
    )
}

/**
 * The view the kernel hands the policy, rebuilt from the ledger alone: the
 * admitted nodes (an edge, not invalid), the screened ones (every cell done,
 * or advanced by the allocator, in registration order) and the proposals that
 * completed.
 */
function policyViewAt(state: SearchStateView): SearchPolicyView {
  const admitted = state.nodes().filter((node) => node.edgeIds.length > 0 && node.status !== 'invalid')
  const screened = admitted
    .filter((node) => node.status === 'advanced' || idle(state, node.nodeId))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((node) => node.nodeId)
  let expansions = 0
  for (let index = 0; ; index++) {
    const operation = state.operation(`expand-${index}`)
    if (!operation) break
    if (operation.outcome === 'completed') expansions += 1
  }
  return searchPolicyView(state, {
    screened,
    screening: admitted.length - screened.length,
    expansions,
    maxAttempts: MAX_ATTEMPTS,
  })
}

/**
 * Audit a closed ledger. Each `advanced` and `pruned` decision, with its rule,
 * rank reason and estimate, must be one the allocator returns again from the
 * ledger just before it, and each proposal's parents, operator and selection
 * evidence must be the expansion the policy returns again from the ledger
 * just before the proposal started, so every decision derives from recorded
 * evidence. Each measured node's contrast with its parent is counted by the
 * units they pair on, and cells are counted by stage.
 */
export function checkLedger(
  text: string,
  searchId: string,
  allocation: SearchAllocator,
  policy: SearchPolicy,
): Record<string, unknown> {
  const final = replaySearchLedgerText(text, searchId, 'sim-ledger')
  const state = new SearchState(searchId)
  const decisions = { advanced: 0, pruned: 0, unexplained: [] as string[] }
  // A proposal's expansion is recorded on each edge it produced.
  const proposed = new Map<string, string>()
  for (const edge of final.edges()) {
    const operationId = edge.proposer?.operationId
    if (!operationId || proposed.has(operationId)) continue
    const parents = edge.parents.map((parent) => parent.nodeId)
    proposed.set(operationId, canonicalString([parents, edge.operator, edge.selection]))
  }
  const expansions = { rederived: 0, withoutEdge: 0, unexplained: [] as string[] }
  const lines = text.trim().split('\n')
  for (const [index, line] of lines.entries()) {
    const entry = parseSearchLedgerLine(line, searchId, { path: 'sim-ledger', line: index + 1 })
    const { event } = entry
    if (event.kind === 'operation-started' && searchExpansionIndex(event.operationId) !== null) {
      const recorded = proposed.get(event.operationId)
      if (recorded === undefined) {
        expansions.withoutEdge += 1
      } else {
        const made = policy.expand(policyViewAt(state.snapshot()))
        if (made && canonicalString([made.parents, made.operator, made.selection]) === recorded) {
          expansions.rederived += 1
        } else {
          expansions.unexplained.push(`${index}:${event.operationId}`)
        }
      }
    }
    if (
      event.kind === 'node-decided' &&
      (event.decision.status === 'advanced' || event.decision.status === 'pruned')
    ) {
      const before = state.snapshot()
      const view = { state: before, idle: (nodeId: string) => idle(before, nodeId) }
      // The kernel keeps the policy's leader from pruning; asking with the
      // root gives a superset, which is all the audit needs.
      const expected =
        event.decision.status === 'advanced'
          ? allocation.advance(view)
          : allocation.prune(view, before.rootNodeId!)
      // The decision, its rank reason and its estimate must all re-derive.
      const recorded = canonicalString([event.decision, event.rule, event.reason, event.basis])
      if (
        !expected.some(
          (made) =>
            made.nodeId === event.nodeId &&
            canonicalString([made.decision, made.rule, made.reason, made.basis]) === recorded,
        )
      ) {
        decisions.unexplained.push(`${index}:${event.nodeId}:${canonicalString(event.decision)}`)
      }
      decisions[event.decision.status] += 1
    }
    state.apply(entry, index)
  }
  const split = final.header!.splits.selection.tasks.length > 0 ? 'selection' : 'train'
  const edgePairs: Record<string, number> = {}
  for (const node of final.nodes()) {
    if (node.primaryParentId === null || final.scoredCells(node.nodeId, split).length === 0) {
      continue
    }
    const { pairs } = estimateNode(final, node.nodeId, { against: node.primaryParentId, split })
    edgePairs[pairs] = (edgePairs[pairs] ?? 0) + 1
  }
  const advancedTo: Record<string, number> = {}
  for (const node of final.nodes()) {
    for (const { decision } of node.decisions) {
      if (decision.status === 'advanced') {
        advancedTo[decision.rung] = (advancedTo[decision.rung] ?? 0) + 1
      }
    }
  }
  const cellsByStage: Record<string, number> = {}
  for (const cell of final.cells()) cellsByStage[cell.stage] = (cellsByStage[cell.stage] ?? 0) + 1
  const operators: Record<string, number> = {}
  for (const edge of final.edges()) operators[edge.operator] = (operators[edge.operator] ?? 0) + 1
  let maxDepth = 0
  for (const node of final.nodes()) maxDepth = Math.max(maxDepth, node.depth ?? 0)
  const statuses: Record<string, number> = {}
  for (const node of final.nodes()) {
    statuses[node.status ?? 'none'] = (statuses[node.status ?? 'none'] ?? 0) + 1
  }
  return {
    ok: decisions.unexplained.length === 0 && expansions.unexplained.length === 0,
    decisions,
    expansions,
    edgePairs,
    advancedTo,
    cellsByStage,
    statuses,
    operators,
    maxDepth,
  }
}
