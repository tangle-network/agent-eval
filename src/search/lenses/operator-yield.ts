/**
 * `operatorYield(state)`: outcome counts and yield per known dollar, by the
 * operator each edge names (search-tree-design §12).
 *
 * A node counts once, under the operator of the edge that registered it. A
 * re-proposal (an edge into a node an earlier edge registered) adds a
 * proposal and a `reproposals` count to its operator, but no outcome and no
 * yield sample: it produced no new artifact and no new measurement, so
 * counting its node again would repeat one measurement as independent
 * evidence.
 *
 * "Yield" reuses `searchPosterior` (E3, `../../campaign/estimate-node`): its
 * per-node mean is already the node's improvement over the root, oriented so
 * larger is always better regardless of the objective's direction — this
 * lens adds no second orientation rule of its own. A child's sample is
 * `posteriorMean / knownCostUsd`, and only enters the sample when both are
 * known: the node shares 2 or more units with the root (one shared unit is
 * no estimate, §6.4), every one of its cells has a known cost
 * (`SearchSpend.unknownCostCells === 0`, so an unpriced cell never floors a
 * node to an artificially cheap, inflated yield), and it was not decided
 * `invalid` (a judge integrity or admission failure: its score is not
 * evidence of improvement, and `editCredit` excludes such nodes the same
 * way). A $0-known-cost node is excluded from yield (division by zero is not
 * a yield), not treated as free.
 */

import { searchPosterior } from '../../campaign/estimate-node'
import type { SearchEdgeOperator, SearchNodeStatus } from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { rankingSplit, type SampleSummary, summarizeSamples } from './shared'

/** The operators an expansion may choose (`SearchExpansion.operator` in
 * `search-policy.ts`): every edge operator except `seed` (the search's own
 * start) and `derive` (a cross-search edge a proposer never chooses). */
export const EXPANSION_OPERATORS = ['draft', 'improve', 'debug', 'merge'] as const
export type ExpansionOperator = (typeof EXPANSION_OPERATORS)[number]

/** The bandit's own gate: an operator's weight is used only once it has this
 * many yield-eligible outcomes; below it, the policy falls back to a fixed
 * weight for that operator. Same threshold `NodeEstimate.method` uses for
 * `insufficient` (`minimumPairsForPairedDeltaTest(0.95)` = 6). */
export const MIN_OUTCOMES_FOR_WEIGHT = 6

export interface OperatorOutcomeCounts {
  advanced: number
  finalist: number
  selected: number
  pruned: number
  rejected: number
  invalid: number
  undecided: number
}

export interface OperatorYieldRow {
  operator: SearchEdgeOperator
  /** Edges recorded with this operator, re-proposals included. */
  proposals: number
  /** Of `proposals`, edges into a node an earlier edge registered. */
  reproposals: number
  /** Nodes this operator registered, by their latest status: one per node. */
  outcomes: OperatorOutcomeCounts
  /** Registered nodes excluded from `yield`: decided invalid, fewer than 2
   * units shared with the root, or an unknown or zero known cost. Never
   * imputed into `yield`. */
  excluded: number
  yield: SampleSummary
}

export interface OperatorYieldData {
  split: 'train' | 'selection'
  rows: OperatorYieldRow[]
}

export interface OperatorYieldOptions {
  split?: 'train' | 'selection'
}

/** One weight per expandable operator: an operator's yield mean once it has
 * `MIN_OUTCOMES_FOR_WEIGHT` or more samples, else `null` (not yet trusted —
 * the policy's own fallback decides what an untrusted operator gets). */
export type OperatorYieldSignal = Record<ExpansionOperator, number | null>

export function operatorYield(
  state: SearchStateView,
  options: OperatorYieldOptions = {},
): { data: OperatorYieldData; signal: { name: string; value: OperatorYieldSignal } } {
  const split = options.split ?? rankingSplit(state)
  // `searchPosterior` needs an opened search with a root; before that there
  // is no edge to count either.
  const posteriorByNode = new Map(
    state.header && state.rootNodeId !== null
      ? searchPosterior(state, { split }).nodes.map((node) => [node.nodeId, node])
      : [],
  )

  const grouped = new Map<
    SearchEdgeOperator,
    {
      proposals: number
      reproposals: number
      outcomes: OperatorOutcomeCounts
      excluded: number
      samples: number[]
    }
  >()
  const group = (operator: SearchEdgeOperator) => {
    let existing = grouped.get(operator)
    if (!existing) {
      existing = {
        proposals: 0,
        reproposals: 0,
        outcomes: {
          advanced: 0,
          finalist: 0,
          selected: 0,
          pruned: 0,
          rejected: 0,
          invalid: 0,
          undecided: 0,
        },
        excluded: 0,
        samples: [],
      }
      grouped.set(operator, existing)
    }
    return existing
  }

  for (const edge of state.edges()) {
    const child = state.node(edge.childNodeId)
    if (!child) continue
    const bucket = group(edge.operator)
    bucket.proposals += 1
    if (child.edgeIds[0] !== edge.edgeId) {
      bucket.reproposals += 1
      continue
    }
    bucket.outcomes[statusKey(child.status)] += 1

    const posterior = posteriorByNode.get(child.nodeId)
    const costKnown = child.spend.unknownCostCells === 0
    if (
      child.status === 'invalid' ||
      !posterior ||
      posterior.mean === null ||
      posterior.pairs < 2 ||
      !costKnown ||
      child.spend.knownUsd <= 0
    ) {
      bucket.excluded += 1
      continue
    }
    bucket.samples.push(posterior.mean / child.spend.knownUsd)
  }

  const rows: OperatorYieldRow[] = [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([operator, bucket]) => ({
      operator,
      proposals: bucket.proposals,
      reproposals: bucket.reproposals,
      outcomes: bucket.outcomes,
      excluded: bucket.excluded,
      yield: summarizeSamples(bucket.samples),
    }))

  const signalValue = {} as OperatorYieldSignal
  for (const operator of EXPANSION_OPERATORS) {
    const row = rows.find((r) => r.operator === operator)
    signalValue[operator] =
      row && row.yield.n >= MIN_OUTCOMES_FOR_WEIGHT && row.yield.mean !== null
        ? row.yield.mean
        : null
  }

  return { data: { split, rows }, signal: { name: 'operatorYield.weights', value: signalValue } }
}

function statusKey(status: SearchNodeStatus | null): keyof OperatorOutcomeCounts {
  return status ?? 'undecided'
}
