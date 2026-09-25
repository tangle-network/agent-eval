/**
 * `operatorYield(state)`: outcome counts and yield per known dollar, by the
 * operator each edge names (search-tree-design §12).
 *
 * "Yield" reuses `searchPosterior` (E3, `../../campaign/estimate-node`): its
 * per-node mean is already the node's improvement over the root, oriented so
 * larger is always better regardless of the objective's direction, and it is
 * null exactly when the node shares no unit with the root — this lens adds
 * no second orientation or "no shared unit" rule of its own. A child's
 * sample is `posteriorMean / knownCostUsd`, and only enters the sample when
 * both are known: `costKnown` requires every one of the node's cells to have
 * a known-cost attempt (`SearchSpend.unknownCostCells === 0`), so an
 * unpriced cell never floors a node to an artificially cheap, inflated
 * yield. A $0-known-cost node is excluded from yield (division by zero is
 * not a yield), not treated as free.
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
  /** Edges recorded with this operator, regardless of whether their child
   * yields a usable sample. */
  proposals: number
  outcomes: OperatorOutcomeCounts
  /** Children excluded from `yield`: no shared unit with the root (unknown
   * posterior) or an unknown/zero known cost. Never imputed into `yield`. */
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
  const posteriorByNode = new Map(
    searchPosterior(state, { split }).nodes.map((node) => [node.nodeId, node]),
  )

  const grouped = new Map<
    SearchEdgeOperator,
    { outcomes: OperatorOutcomeCounts; excluded: number; samples: number[] }
  >()
  const group = (operator: SearchEdgeOperator) => {
    let existing = grouped.get(operator)
    if (!existing) {
      existing = {
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
    bucket.outcomes[statusKey(child.status)] += 1

    const posterior = posteriorByNode.get(child.nodeId)
    const costKnown = child.spend.unknownCostCells === 0
    if (!posterior || posterior.mean === null || !costKnown || child.spend.knownUsd <= 0) {
      bucket.excluded += 1
      continue
    }
    bucket.samples.push(posterior.mean / child.spend.knownUsd)
  }

  const rows: OperatorYieldRow[] = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([operator, bucket]) => ({
      operator,
      proposals: sumCounts(bucket.outcomes),
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

function sumCounts(counts: OperatorOutcomeCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0)
}
