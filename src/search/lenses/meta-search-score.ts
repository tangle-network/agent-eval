import { estimateNode } from '../../campaign/estimate-node'
import { type SearchClaimVerification, verifySearchClaim } from '../../campaign/search-claim'
import type { SearchClaim, SearchSourceRef } from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { hashCanonical } from '../../ledger-core/canonical'
import { roundDecimal as round } from '../../math/round-decimal'
import type {
  MetaSearchLiftPerUsd,
  MetaSearchScore,
  MetaSearchSpend,
  MetaSearchUnscoredReason,
} from './meta-search-contract'

/**
 * Every rule the per-search score depends on. Its digest is the score's
 * revision, which an outer search pins as its judge, so an outer climb's
 * cells and the lens report one number.
 */
const META_SEARCH_SCORE_DEFINITION = {
  name: 'tangle.meta-search-score.2026-09',
  node: 'the claim selection on ship; on hold, the first finalist in claim order not decided invalid',
  lift: 'estimateNode(node, against root, split test), oriented so a gain is positive',
  unscored: [
    'open',
    'no claim',
    'claim the ledger contradicts (verifySearchClaim mismatch)',
    'test-cannot-resolve',
    'hold with no finalist tested',
    'fewer than 2 shared test units',
  ],
  dollars: 'committed spend of every cell and operation, claim cells included',
  unknownCost: 'a floor only: the lift per dollar is a bound and enters no estimate',
} as const

/** The per-search score `metaSearchScore` computes. An outer search names it
 * as its objective's judge. */
export const META_SEARCH_SCORE_SOURCE: SearchSourceRef = {
  uri: 'npm:@tangle-network/agent-eval#metaSearchScore',
  revision: hashCanonical(META_SEARCH_SCORE_DEFINITION),
}

/**
 * A search's held-out lift per known dollar, from its claim and its test
 * cells. Pure; it reads the test split, so a policy view (which holds no test
 * cells) cannot call it; an outer search reads it from a closed inner search.
 */
export function metaSearchScore(state: SearchStateView): MetaSearchScore {
  return scoreSearch(state, state.closed?.claim ? verifySearchClaim(state) : null)
}

export function scoreSearch(
  state: SearchStateView,
  verification: SearchClaimVerification | null,
): MetaSearchScore {
  const header = state.header
  if (!header) throw new Error(`search ${state.searchId} has not been opened`)
  const { spend: audit } = state.audit
  const spend: MetaSearchSpend = {
    knownUsd: audit.knownUsd,
    floorUsd: audit.floorUsd,
    unknownCost: audit.unknownCostCells + audit.unknownCostOperations,
  }
  const unscored = (
    reason: MetaSearchUnscoredReason,
    detail: string,
    decision: SearchClaim['decision'] | null = null,
  ): MetaSearchScore => ({ status: 'unscored', decision, reason, detail, spend })

  const closed = state.closed
  if (!closed) return unscored('open', 'the search is open; its claim is made when it closes')
  const claim = closed.claim
  if (!claim) {
    return unscored(
      'no-claim',
      `the search closed (${closed.reason}) without a claim on a test split`,
    )
  }
  if (verification?.status === 'mismatch') {
    return unscored(
      'claim-mismatch',
      `the claim differs from what its ledger supports: ${verification.differences.join('; ')}`,
      claim.decision,
    )
  }
  if (claim.decision === 'test-cannot-resolve') {
    return unscored('test-cannot-resolve', claim.reason, claim.decision)
  }
  const root = state.rootNodeId!
  const nodeId =
    claim.decision === 'ship'
      ? claim.selected
      : (claim.finalists.find((finalist) => state.node(finalist.nodeId)?.status !== 'invalid')
          ?.nodeId ?? null)
  if (nodeId === null || nodeId === root) {
    return unscored(
      'no-valid-finalist',
      claim.finalists.length === 0
        ? `hold: no finalist went to test (${claim.reason})`
        : `hold: every finalist was decided invalid (${claim.finalists.length})`,
      claim.decision,
    )
  }
  const estimate = estimateNode(state, nodeId, { against: root, split: 'test' })
  if (estimate.delta === null) {
    return unscored(
      'insufficient',
      `${nodeId} and the root share ${estimate.pairs} scored test unit${estimate.pairs === 1 ? '' : 's'}; a lift needs 2`,
      claim.decision,
    )
  }
  const maximize = header.objective.direction === 'maximize'
  const lift = orient(estimate.delta, maximize)
  const liftInterval = estimate.interval ? orientInterval(estimate.interval, maximize) : null
  return {
    status: 'scored',
    decision: claim.decision,
    nodeId,
    estimate,
    lift,
    liftInterval,
    spend,
    liftPerUsd: liftPerUsd(lift, liftInterval, spend),
  }
}

function liftPerUsd(
  lift: number,
  interval: [number, number] | null,
  spend: MetaSearchSpend,
): MetaSearchLiftPerUsd {
  const committed = spend.knownUsd + spend.floorUsd
  if (spend.unknownCost > 0) {
    if (committed <= 0) {
      return {
        status: 'unknown',
        reason: `${spend.unknownCost} cost${spend.unknownCost === 1 ? ' is' : 's are'} unknown with no proven floor`,
      }
    }
    return {
      status: 'bound',
      value: lift / committed,
      bound: lift >= 0 ? 'at-most' : 'at-least',
      reason: `${spend.unknownCost} cost${spend.unknownCost === 1 ? ' is' : 's are'} known only as a floor; $${round(committed, 6)} is the least the search spent`,
    }
  }
  if (spend.knownUsd <= 0) {
    return {
      status: 'unknown',
      reason: 'the search recorded no spend, so a lift per dollar is undefined',
    }
  }
  return {
    status: 'known',
    value: lift / spend.knownUsd,
    interval: interval ? [interval[0] / spend.knownUsd, interval[1] / spend.knownUsd] : null,
  }
}

function orient(delta: number, maximize: boolean): number {
  return maximize ? delta : delta === 0 ? 0 : -delta
}

function orientInterval(interval: [number, number], maximize: boolean): [number, number] {
  return maximize ? interval : [orient(interval[1], false), orient(interval[0], false)]
}
