/**
 * `taskMatrix(state)`: nodes × units, both clustered by a simple deterministic
 * method (search-tree-design §12). No numeric-matrix clustering primitive
 * exists elsewhere in agent-eval (`pipelines/failure-cluster.ts` groups by an
 * exact categorical key, not by distance over a score matrix), so this lens
 * adds one: single-linkage agglomerative clustering with a data-derived
 * cutoff (the median of the finite pairwise distances), so nothing is a fixed
 * magic constant and two items with no shared observation never merge — they
 * have no finite distance to compare. A distance is the root mean square
 * difference over the observations both items share, so a pair measured on
 * 24 shared units is not farther apart than a pair on 6 only because it has
 * more terms.
 *
 * The signal, specialist gain per unit cluster, is the spread between a
 * cluster's best node and the mean of its nodes, in the objective's
 * direction: a large gap says some node specializes on that task family
 * rather than the field being uniform. Node means compare on shared units
 * only (a node contributes when it scored every unit of the cluster), a node
 * decided invalid never contributes, and a gain needs 2 contributing nodes
 * and 6 units (§6.4's `descriptive` threshold); below that it is null with
 * the reason, never 0.
 */

import type { SearchStateView } from '../../campaign/search-state'
import { INSUFFICIENT_FROM, rankingSplit } from './shared'

const SPECIALIST_GAIN_METHOD = `per unit cluster, the best node's mean over the cluster's units minus the mean of the node means, in the objective's direction and the metric's units, among nodes not decided invalid that scored every unit of the cluster; reported from 2 such nodes and ${INSUFFICIENT_FROM} units; a point value with no interval: the largest of several noisy means exceeds their mean even when no node specializes, so read it against the spread of the node means`

export interface TaskMatrixCell {
  nodeId: string
  unitId: string
  /** Mean of the node's scored cells on this unit; absent (not zero) when
   * the node never scored the unit. */
  mean: number | null
}

export interface TaskMatrixCluster {
  /** Stable id: the lexicographically first member. */
  id: string
  members: string[]
}

export interface TaskMatrixSpecialistRow {
  clusterId: string
  unitIds: string[]
  /** Best node mean minus the mean of node means over the cluster's units,
   * oriented so a larger gain is a larger advantage in the objective's
   * direction. Null below 2 contributing nodes or below 6 units, with the
   * reason in `insufficient`: never reported as 0. */
  gain: number | null
  /** The contributing node with the best mean; null without one. */
  bestNodeId: string | null
  /** Nodes not decided invalid that scored every unit of the cluster. */
  nodesContributing: number
  /** Why `gain` is null; null when it is not. */
  insufficient: string | null
}

export interface TaskMatrixData {
  split: 'train' | 'selection'
  direction: 'maximize' | 'minimize'
  /** How `specialistGain` is computed. */
  method: string
  nodeIds: string[]
  unitIds: string[]
  nodeClusters: TaskMatrixCluster[]
  unitClusters: TaskMatrixCluster[]
  cells: TaskMatrixCell[]
  specialistGain: TaskMatrixSpecialistRow[]
}

export interface TaskMatrixOptions {
  split?: 'train' | 'selection'
}

/** unitClusterId → specialist gain; a cluster whose gain is null (fewer than
 * 2 contributing nodes or 6 units) is omitted, not zeroed. */
export type TaskMatrixSignal = Record<string, number>

export function taskMatrix(
  state: SearchStateView,
  options: TaskMatrixOptions = {},
): { data: TaskMatrixData; signal: { name: string; value: TaskMatrixSignal } } {
  const split = options.split ?? rankingSplit(state)
  const direction = state.header?.objective.direction ?? 'maximize'
  const sign = direction === 'maximize' ? 1 : -1
  const nodeIds = state.nodeIds()
  const invalid = new Set(
    state
      .nodes()
      .filter((node) => node.status === 'invalid')
      .map((node) => node.nodeId),
  )

  const byNodeUnit = new Map<string, Map<string, number>>()
  const unitSet = new Set<string>()
  for (const nodeId of nodeIds) {
    const units = new Map<string, number>()
    for (const unit of state.unitScores(nodeId, split)) {
      units.set(unit.unitId, unit.mean)
      unitSet.add(unit.unitId)
    }
    byNodeUnit.set(nodeId, units)
  }
  const unitIds = [...unitSet].sort((a, b) => a.localeCompare(b))

  const nodeClusters = clusterBy(nodeIds, (a, b) => nodeDistance(byNodeUnit, a, b))
  const unitClusters = clusterBy(unitIds, (a, b) => unitDistance(byNodeUnit, nodeIds, a, b))

  const orderedNodeIds = nodeClusters.flatMap((c) => c.members)
  const orderedUnitIds = unitClusters.flatMap((c) => c.members)

  const cells: TaskMatrixCell[] = []
  for (const nodeId of orderedNodeIds) {
    const units = byNodeUnit.get(nodeId)!
    for (const unitId of orderedUnitIds)
      cells.push({ nodeId, unitId, mean: units.get(unitId) ?? null })
  }

  const specialistGain: TaskMatrixSpecialistRow[] = unitClusters.map((cluster) => {
    // Oriented node means over the whole cluster, from nodes that scored
    // every unit of it, so every mean is over the same units.
    const contributing: Array<{ nodeId: string; oriented: number }> = []
    for (const nodeId of nodeIds) {
      if (invalid.has(nodeId)) continue
      const units = byNodeUnit.get(nodeId)!
      let total = 0
      let complete = true
      for (const unitId of cluster.members) {
        const value = units.get(unitId)
        if (value === undefined) {
          complete = false
          break
        }
        total += value
      }
      if (complete) contributing.push({ nodeId, oriented: (sign * total) / cluster.members.length })
    }
    let best: { nodeId: string; oriented: number } | null = null
    for (const entry of contributing) if (best === null || entry.oriented > best.oriented) best = entry
    const row = {
      clusterId: cluster.id,
      unitIds: cluster.members,
      bestNodeId: best?.nodeId ?? null,
      nodesContributing: contributing.length,
    }
    if (contributing.length < 2 || cluster.members.length < INSUFFICIENT_FROM) {
      return {
        ...row,
        gain: null,
        insufficient:
          contributing.length < 2
            ? `${contributing.length} node${contributing.length === 1 ? '' : 's'} scored every unit of the cluster; a gain needs 2`
            : `${cluster.members.length} of ${INSUFFICIENT_FROM} units`,
      }
    }
    const mean = contributing.reduce((sum, entry) => sum + entry.oriented, 0) / contributing.length
    return { ...row, gain: best!.oriented - mean, insufficient: null }
  })

  const signalValue: TaskMatrixSignal = {}
  for (const row of specialistGain) if (row.gain !== null) signalValue[row.clusterId] = row.gain

  return {
    data: {
      split,
      direction,
      method: SPECIALIST_GAIN_METHOD,
      nodeIds: orderedNodeIds,
      unitIds: orderedUnitIds,
      nodeClusters,
      unitClusters,
      cells,
      specialistGain,
    },
    signal: { name: 'taskMatrix.specialistGain', value: signalValue },
  }
}

function nodeDistance(byNodeUnit: Map<string, Map<string, number>>, a: string, b: string): number {
  const unitsA = byNodeUnit.get(a)!
  const unitsB = byNodeUnit.get(b)!
  let sumSquares = 0
  let shared = 0
  for (const [unitId, valueA] of unitsA) {
    const valueB = unitsB.get(unitId)
    if (valueB === undefined) continue
    sumSquares += (valueA - valueB) ** 2
    shared += 1
  }
  return shared === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(sumSquares / shared)
}

function unitDistance(
  byNodeUnit: Map<string, Map<string, number>>,
  nodeIds: readonly string[],
  a: string,
  b: string,
): number {
  let sumSquares = 0
  let shared = 0
  for (const nodeId of nodeIds) {
    const units = byNodeUnit.get(nodeId)!
    const valueA = units.get(a)
    const valueB = units.get(b)
    if (valueA === undefined || valueB === undefined) continue
    sumSquares += (valueA - valueB) ** 2
    shared += 1
  }
  return shared === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(sumSquares / shared)
}

/**
 * Single-linkage agglomerative clustering. The cutoff is the median of the
 * finite pairwise distances measured before any merge — a threshold the data
 * itself sets, not a constant this lens chooses. Two items with no finite
 * distance (no shared observation) can never merge. Deterministic: ties in
 * the merge order break on the lexicographically smaller pair, and the
 * returned clusters and their members are both sorted.
 */
function clusterBy(
  ids: readonly string[],
  distance: (a: string, b: string) => number,
): TaskMatrixCluster[] {
  let clusters: string[][] = ids.map((id) => [id])
  if (clusters.length <= 1) return clusters.map(toCluster)

  const finite: number[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = distance(ids[i]!, ids[j]!)
      if (Number.isFinite(d)) finite.push(d)
    }
  }
  if (finite.length === 0) return clusters.map(toCluster)
  finite.sort((a, b) => a - b)
  const cutoff = finite[Math.floor(finite.length / 2)]!

  for (;;) {
    let best: { i: number; j: number; d: number } | null = null
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let d = Number.POSITIVE_INFINITY
        for (const a of clusters[i]!) for (const b of clusters[j]!) d = Math.min(d, distance(a, b))
        if (d > cutoff) continue
        if (best === null || d < best.d) best = { i, j, d }
      }
    }
    if (!best) break
    const merged = [...clusters[best.i]!, ...clusters[best.j]!]
    clusters = clusters.filter((_, index) => index !== best!.i && index !== best!.j)
    clusters.push(merged)
  }

  return clusters.map(toCluster).sort((a, b) => a.id.localeCompare(b.id))
}

function toCluster(members: string[]): TaskMatrixCluster {
  const sorted = [...members].sort((a, b) => a.localeCompare(b))
  return { id: sorted[0]!, members: sorted }
}
