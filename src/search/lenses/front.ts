/**
 * `front(state, axes)`: the Pareto front over a node's score and its known
 * cost per cell, with room for caller-declared axes (search-tree-design §12).
 *
 * Reuses the existing frontier primitive (`../../pareto`, already the parent
 * selector behind `crowdedFrontierParent` in `search-policy.ts`) rather than
 * a second dominance implementation.
 *
 * The cost axis is the node's cost per attempted cell on the ranking split,
 * not its total spend: an allocator gives a node more cells as it advances,
 * so a total would rank a node by how far it was measured, and a node pruned
 * after its screen would look cheap only for having run fewer cells. A node
 * enters the frontier only when its score rests on 2 or more units (one unit
 * is no estimate, §6.4), every attempted cell on the split has a known cost
 * (an unknown cost is never floored to its known partial or imputed), and it
 * was not decided `invalid` (a judge integrity or admission failure, whose
 * score a reward hack may have produced; such a node never becomes a parent,
 * §6.6).
 */

import { searchEstimateMethod } from '../../campaign/estimate-node'
import type { SearchEstimateMethod } from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { type Objective, paretoFrontier } from '../../pareto'
import { rankingSplit } from './shared'

export interface FrontExtraAxis {
  name: string
  direction: 'maximize' | 'minimize'
  /** Reads the axis value for one node from the same state the lens holds.
   * Returning a non-finite number excludes the node from this axis's frontier
   * pass the same way an unknown score or cost does. */
  value(state: SearchStateView, nodeId: string): number
}

export interface FrontRow {
  nodeId: string
  /** Mean per-unit score on the ranking split, in the objective's own units;
   * null when the node has no scored cell there. */
  score: number | null
  /** Units `score` averages over, and the method that many units supports. */
  units: number
  method: SearchEstimateMethod
  /** Known cost per attempted cell on the ranking split; null when any of
   * those cells has an unknown cost, or none was attempted. */
  costPerCellUsd: number | null
  /** Everything the node has spent so far, in every split: how far it was
   * measured, not what it costs to run. */
  knownCostUsd: number
  /** False when any of the node's cells has an unknown-cost attempt: its true
   * spend may be higher than `knownCostUsd`. */
  costKnown: boolean
  /** True only for an eligible node that no other eligible node dominates on
   * every declared axis. */
  onFront: boolean
  /** Why the node is off every frontier pass; null when it is eligible. */
  excluded: FrontExclusion | null
}

export type FrontExclusion = 'invalid' | 'unscored' | 'one-unit' | 'unknown-cost' | 'extra-axis'

export interface FrontData {
  split: 'train' | 'selection'
  axes: string[]
  rows: FrontRow[]
  frontierSize: number
  /** Rows excluded from every frontier pass. */
  excludedCount: number
  /** `excludedCount` by reason. */
  exclusions: Record<FrontExclusion, number>
}

export interface FrontOptions {
  split?: 'train' | 'selection'
  axes?: FrontExtraAxis[]
}

/** nodeId → 1 on the frontier, 0 off it. Every node appears; an excluded
 * node reads 0, same as a dominated one, because "on the front" is the only
 * claim this signal makes. */
export type FrontSignal = Record<string, number>

export function front(
  state: SearchStateView,
  options: FrontOptions = {},
): { data: FrontData; signal: { name: string; value: FrontSignal } } {
  const split = options.split ?? rankingSplit(state)
  const direction = state.header?.objective.direction ?? 'maximize'
  const extraAxes = options.axes ?? []

  const rows = state.nodes().map((node) => {
    const units = state.unitScores(node.nodeId, split)
    const score = units.length > 0 ? units.reduce((sum, u) => sum + u.mean, 0) / units.length : null
    let attempted = 0
    let spent = 0
    let known = true
    for (const cell of state.cells({ nodeId: node.nodeId })) {
      if (cell.split !== split || cell.attempts === 0) continue
      attempted += 1
      spent += cell.spentUsd
      if (!cell.costKnown) known = false
    }
    const extra = extraAxes.map((axis) => axis.value(state, node.nodeId))
    const costPerCellUsd = known && attempted > 0 ? spent / attempted : null
    const excluded: FrontExclusion | null =
      node.status === 'invalid'
        ? 'invalid'
        : score === null
          ? 'unscored'
          : units.length < 2
            ? 'one-unit'
            : costPerCellUsd === null
              ? 'unknown-cost'
              : extra.every((value) => Number.isFinite(value))
                ? null
                : 'extra-axis'
    return {
      nodeId: node.nodeId,
      score,
      units: units.length,
      method: searchEstimateMethod(units.length),
      costPerCellUsd,
      knownCostUsd: node.spend.knownUsd,
      costKnown: node.spend.unknownCostCells === 0,
      excluded,
      extra,
    }
  })

  type Eligible = (typeof rows)[number] & { score: number; costPerCellUsd: number }
  const eligible = rows.filter((row): row is Eligible => row.excluded === null)

  const objectives: Objective<Eligible>[] = [
    { name: 'score', direction, value: (row) => row.score },
    { name: 'costPerCellUsd', direction: 'minimize', value: (row) => row.costPerCellUsd },
    ...extraAxes.map(
      (axis, index): Objective<Eligible> => ({
        name: axis.name,
        direction: axis.direction,
        value: (row) => row.extra[index]!,
      }),
    ),
  ]

  const frontierIds =
    eligible.length > 0
      ? new Set(paretoFrontier(eligible, objectives).frontier.map((r) => r.nodeId))
      : new Set<string>()

  const exclusions: Record<FrontExclusion, number> = {
    invalid: 0,
    unscored: 0,
    'one-unit': 0,
    'unknown-cost': 0,
    'extra-axis': 0,
  }
  const outRows: FrontRow[] = rows.map(({ extra: _extra, ...row }) => {
    if (row.excluded) exclusions[row.excluded] += 1
    return { ...row, onFront: frontierIds.has(row.nodeId) }
  })

  const signalValue: FrontSignal = {}
  for (const row of outRows) signalValue[row.nodeId] = row.onFront ? 1 : 0

  return {
    data: {
      split,
      axes: objectives.map((o) => o.name),
      rows: outRows,
      frontierSize: frontierIds.size,
      excludedCount: rows.length - eligible.length,
      exclusions,
    },
    signal: { name: 'front.membership', value: signalValue },
  }
}
