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
 * `posteriorMean / screenCostUsd`: the gain over the known cost of producing
 * and screening the node, which is the operator's doing. That cost is the
 * node's share of its proposal (the candidate-generation operation's cost
 * split evenly over every child edge the operation recorded, re-proposals
 * included) plus its cells allocated before its first decision: the first
 * rung and the proposer's train feedback, which the allocator plans together
 * at admission. Cells a later rung or the claim adds come after an
 * `advanced` or `finalist` decision; they are the allocator's and the
 * claim's choice, not the operator's, so an operator whose children advance
 * is not charged for the measurement their success earned. A seed edge
 * proposed nothing, so the root's cost is its cells alone.
 *
 * A child enters the sample only when both numbers are known: the node
 * shares 2 or more units with the root (one shared unit is no estimate,
 * §6.4); the edge names a recorded proposal operation whose cost is known;
 * every screen cell has run and has a known cost (an unpriced or unrecorded
 * part never floors a node to an artificially cheap, inflated yield); and it
 * was not decided `invalid` (a judge integrity or admission failure: its
 * score is not evidence of improvement, and `editCredit` excludes such nodes
 * the same way). A $0-known-cost node is excluded from yield (division by
 * zero is not a yield), not treated as free.
 */

import { searchPosterior } from '../../campaign/estimate-node'
import type {
  SearchEdgeOperator,
  SearchEdgeRecordedEvent,
  SearchNodeStatus,
} from '../../campaign/search-ledger-types'
import type { SearchNode, SearchStateView } from '../../campaign/search-state'
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

const YIELD_METHOD =
  "per registered node, searchPosterior's mean gain over the root divided by the known cost of producing and screening the node: its even share of the proposal operation's cost over the operation's child edges, plus its cells allocated before its first decision (first rung and train feedback; later rungs and the claim excluded); no sample when the node was decided invalid, shares fewer than 2 units with the root, or any part of that cost is unknown, unrecorded or zero"

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
   * units shared with the root, or a proposal or screen cost that is
   * unknown, unrecorded or zero. Never imputed into `yield`. */
  excluded: number
  yield: SampleSummary
}

export interface OperatorYieldData {
  split: 'train' | 'selection'
  /** How a yield sample is computed. */
  method: string
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

  const edges = state.edges()
  // Every child a proposal returned shares its cost evenly, a re-proposal's
  // share included: the proposal produced that artifact too.
  const childEdges = new Map<string, number>()
  for (const edge of edges) {
    const operationId = edge.proposer?.operationId
    if (operationId) childEdges.set(operationId, (childEdges.get(operationId) ?? 0) + 1)
  }

  for (const edge of edges) {
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
    const costUsd = screenCostUsd(state, child, edge, childEdges)
    if (
      child.status === 'invalid' ||
      !posterior ||
      posterior.mean === null ||
      posterior.pairs < 2 ||
      costUsd === null ||
      costUsd <= 0
    ) {
      bucket.excluded += 1
      continue
    }
    bucket.samples.push(posterior.mean / costUsd)
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

  return {
    data: { split, method: YIELD_METHOD, rows },
    signal: { name: 'operatorYield.weights', value: signalValue },
  }
}

/** The known cost of producing and screening `node`, which `edge` registered;
 * null when any part of it is unknown. The screen ends at the node's first
 * decision: the allocator records `advanced` before it allocates a further
 * rung, and the claim decides `finalist` before it allocates test cells. */
function screenCostUsd(
  state: SearchStateView,
  node: SearchNode,
  edge: SearchEdgeRecordedEvent,
  childEdges: ReadonlyMap<string, number>,
): number | null {
  let usd = 0
  if (edge.proposer !== null) {
    const { operationId } = edge.proposer
    if (operationId === null) return null
    const operation = state.operation(operationId)
    if (!operation?.recorded || !operation.costKnown) return null
    usd += operation.spentUsd / childEdges.get(operationId)!
  }
  const screenEnd = node.decisions[0]?.sequence ?? Number.POSITIVE_INFINITY
  for (const cell of state.cells({ nodeId: node.nodeId })) {
    if (cell.allocatedSequence > screenEnd) continue
    // A cell that has not run has no cost yet, so its cost is not known.
    if (!cell.costKnown || (cell.attempts === 0 && cell.cancelled === null)) return null
    usd += cell.spentUsd
  }
  return usd
}

function statusKey(status: SearchNodeStatus | null): keyof OperatorOutcomeCounts {
  return status ?? 'undecided'
}
