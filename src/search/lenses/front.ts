/**
 * `front(state, axes)`: the Pareto front over a node's score and known cost,
 * with room for caller-declared axes (search-tree-design §12).
 *
 * Reuses the existing frontier primitive (`../../pareto`, already the parent
 * selector behind `crowdedFrontierParent` in `search-policy.ts`) rather than
 * a second dominance implementation. A node enters the frontier only when
 * both its score and its cost are known in full: an unknown-cost node (any
 * cell whose cost is `unknown`, per `SearchSpend.unknownCostCells`) is never
 * floored to its known partial and never imputed onto the front.
 */

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
  knownCostUsd: number
  /** False when any of the node's cells has unknown-cost attempts: its true
   * cost may be higher than `knownCostUsd`, so it never competes on cost. */
  costKnown: boolean
  /** True only for a node with a known score and a known cost that no other
   * such node dominates on every declared axis. */
  onFront: boolean
}

export interface FrontData {
  split: 'train' | 'selection'
  axes: string[]
  rows: FrontRow[]
  frontierSize: number
  /** Rows excluded from every frontier pass: unknown score, unknown cost, or
   * a non-finite extra-axis read. */
  excludedCount: number
}

export interface FrontOptions {
  split?: 'train' | 'selection'
  axes?: FrontExtraAxis[]
}

/** nodeId → 1 on the frontier, 0 off it. Every scored node appears; an
 * excluded (unknown-score or unknown-cost) node reads 0, same as a dominated
 * one, because "on the front" is the only claim this signal makes. */
export type FrontSignal = Record<string, number>

export function front(
  state: SearchStateView,
  options: FrontOptions = {},
): { data: FrontData; signal: { name: string; value: FrontSignal } } {
  const split = options.split ?? rankingSplit(state)
  const direction = state.header?.objective.direction ?? 'maximize'
  const extraAxes = options.axes ?? []

  const rows: Array<{
    nodeId: string
    score: number | null
    knownCostUsd: number
    costKnown: boolean
    extra: number[]
  }> = state.nodes().map((node) => {
    const units = state.unitScores(node.nodeId, split)
    const score = units.length > 0 ? units.reduce((sum, u) => sum + u.mean, 0) / units.length : null
    return {
      nodeId: node.nodeId,
      score,
      knownCostUsd: node.spend.knownUsd,
      costKnown: node.spend.unknownCostCells === 0,
      extra: extraAxes.map((axis) => axis.value(state, node.nodeId)),
    }
  })

  const eligible = rows.filter(
    (row) =>
      row.score !== null && row.costKnown && row.extra.every((value) => Number.isFinite(value)),
  ) as Array<{
    nodeId: string
    score: number
    knownCostUsd: number
    costKnown: true
    extra: number[]
  }>

  const objectives: Objective<(typeof eligible)[number]>[] = [
    { name: 'score', direction, value: (row) => row.score },
    { name: 'knownCostUsd', direction: 'minimize', value: (row) => row.knownCostUsd },
    ...extraAxes.map(
      (axis, index): Objective<(typeof eligible)[number]> => ({
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

  const outRows: FrontRow[] = rows.map((row) => ({
    nodeId: row.nodeId,
    score: row.score,
    knownCostUsd: row.knownCostUsd,
    costKnown: row.costKnown,
    onFront: frontierIds.has(row.nodeId),
  }))

  const signalValue: FrontSignal = {}
  for (const row of outRows) signalValue[row.nodeId] = row.onFront ? 1 : 0

  return {
    data: {
      split,
      axes: objectives.map((o) => o.name),
      rows: outRows,
      frontierSize: frontierIds.size,
      excludedCount: rows.length - eligible.length,
    },
    signal: { name: 'front.membership', value: signalValue },
  }
}
