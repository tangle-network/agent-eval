/**
 * `taskMatrix(state)`: nodes × units, both clustered by a simple deterministic
 * method (search-tree-design §12). No numeric-matrix clustering primitive
 * exists elsewhere in agent-eval (`pipelines/failure-cluster.ts` groups by an
 * exact categorical key, not by distance over a score matrix), so this lens
 * adds one: single-linkage agglomerative clustering with a data-derived
 * cutoff (the median of the finite pairwise distances), so nothing is a fixed
 * magic constant and two items with no shared observation never merge — they
 * have no finite distance to compare.
 *
 * The signal, specialist gain per unit cluster, is the spread between a
 * cluster's best-scoring node and its mean: a large gap says some node
 * specializes on that task family rather than the field being uniform.
 */

import type { SearchStateView } from '../../campaign/search-state'
import { rankingSplit } from './shared'

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
   * among nodes that scored at least one of them. Null with fewer than 2
   * contributing nodes: no spread to measure, never reported as 0. */
  gain: number | null
  nodesContributing: number
}

export interface TaskMatrixData {
  split: 'train' | 'selection'
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

/** unitClusterId → specialist gain; null clusters (fewer than 2 contributing
 * nodes) are omitted, not zeroed. */
export type TaskMatrixSignal = Record<string, number>

export function taskMatrix(
  state: SearchStateView,
  options: TaskMatrixOptions = {},
): { data: TaskMatrixData; signal: { name: string; value: TaskMatrixSignal } } {
  const split = options.split ?? rankingSplit(state)
  const nodeIds = state.nodeIds()

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
    const nodeMeans: number[] = []
    for (const nodeId of nodeIds) {
      const units = byNodeUnit.get(nodeId)!
      const scored = cluster.members
        .map((unitId) => units.get(unitId))
        .filter((v): v is number => v !== undefined)
      if (scored.length > 0) nodeMeans.push(scored.reduce((a, b) => a + b, 0) / scored.length)
    }
    if (nodeMeans.length < 2) {
      return {
        clusterId: cluster.id,
        unitIds: cluster.members,
        gain: null,
        nodesContributing: nodeMeans.length,
      }
    }
    const mean = nodeMeans.reduce((a, b) => a + b, 0) / nodeMeans.length
    const gain = Math.max(...nodeMeans) - mean
    return {
      clusterId: cluster.id,
      unitIds: cluster.members,
      gain,
      nodesContributing: nodeMeans.length,
    }
  })

  const signalValue: TaskMatrixSignal = {}
  for (const row of specialistGain) if (row.gain !== null) signalValue[row.clusterId] = row.gain

  return {
    data: {
      split,
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
  return shared === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(sumSquares)
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
  return shared === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(sumSquares)
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
