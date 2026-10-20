/** Final unclaimed selections and verification of the closed search receipt. */
import { estimateNode } from './estimate-node'
import { verifySearchClaim } from './search-claim'
import type { SearchRunResult } from './search-kernel-contract'
import type { NodeEstimate, SearchCloseReason } from './search-ledger-types'
import type { SearchPolicyView } from './search-policy'
import type { SearchNode, SearchStateView } from './search-state'

/** Decisions for a search without a held-out claim, derived before its ledger advances. */
export function unclaimedSearchDecisions(
  state: SearchStateView,
  view: SearchPolicyView,
  leader: string,
  context: { rule: string; stopReason: SearchCloseReason | null; screened: ReadonlySet<string> },
) {
  const { split } = view
  const root = state.rootNodeId!
  const leaderUnits = view.unitScores(leader).map((unit) => unit.unitId)
  // Decide from one read of the state, then append: an append moves the
  // ledger on and retires the view.
  return state
    .nodes()
    .filter((node) => !isTerminal(node))
    .map((node) => {
      const scored = state.scoredCells(node.nodeId, split).length > 0
      const lead = node.nodeId === leader && scored
      const against = node.nodeId === leader ? root : leader
      const basis: NodeEstimate | null =
        node.nodeId === against || !scored
          ? null
          : estimateNode(state, node.nodeId, { against, split })
      const units = new Set(view.unitScores(node.nodeId).map((unit) => unit.unitId))
      return {
        nodeId: node.nodeId,
        decision: { status: lead ? ('selected' as const) : ('rejected' as const) },
        basis,
        rule: context.rule,
        reason: lead
          ? `the leader when the search stopped (${context.stopReason}): a budget decision on the ${split} split, which claims nothing`
          : !context.screened.has(node.nodeId) || !scored
            ? 'the search stopped before this node was measured'
            : !view.complete(node.nodeId)
              ? 'it left a unit unscored, so it could not lead'
              : leaderUnits.some((unitId) => !units.has(unitId))
                ? 'the search stopped before it was measured on every unit the leader was'
                : 'it did not beat the leader on the units they share',
      }
    })
}

export function closedSearchResult(state: SearchStateView): SearchRunResult {
  const claimVerification = verifySearchClaim(state)
  if (claimVerification?.status === 'mismatch') {
    throw new Error(
      `runSearch: search ${state.searchId} closed with a claim its ledger does not support: ${claimVerification.differences.join('; ')}`,
    )
  }
  return {
    state,
    leader: state.audit.selectedNodeId ?? state.rootNodeId!,
    reason: state.closed!.reason,
    claim: state.closed!.claim,
    claimVerification,
  }
}

export function isTerminal(node: SearchNode): boolean {
  return node.status !== null && node.status !== 'advanced'
}
