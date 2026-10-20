/** Landmark multidimensional scaling and distances over the search lineage. */
import type { SearchNode, SearchStateView } from '../../campaign/search-state'
import { symmetricEigen } from '../../math/symmetric-eigen'
import { mean } from '../../statistics/mean'
import { median, round9 } from './geometry'
import type { LandscapeEmbedding } from './landscape-contract'
import { FULL_AXES_MASS, FULL_AXES_MAX } from './landscape-contract'

interface Placement {
  coordinates: Array<[number, number] | undefined>
  /** Coordinates on the leading axes that hold 80% of the positive
   * eigenvalue mass (2 to 8 axes): the space the basin graph is read in, so
   * neighbours are near in the distance itself, not only in the 2-D map. */
  full: Array<number[] | undefined>
  /** Axes `full` holds, and their share of the positive eigenvalue mass. */
  fullAxes: number
  fullExplained: number | null
  unplaced: Map<number, string>
  landmarks: number
  landmarkDistance: { median: number; max: number } | null
  eigenvalues: number[]
  explained: number | null
  negativeMass: number | null
}

export function placeNodes(
  nodes: readonly SearchNode[],
  index: ReadonlyMap<string, number>,
  rootNodeId: string,
  embed: LandscapeEmbedding,
  landmarkCap: number,
  adjacency: () => number[][],
): Placement {
  const n = nodes.length
  const distancesFrom = distanceRows(nodes, embed, adjacency)
  const unplaced = new Map<number, string>()
  const coordinates: Placement['coordinates'] = new Array(n).fill(undefined)
  const first = index.get(rootNodeId) ?? 0
  const rows: Array<Array<number | null>> = []
  const chosen: number[] = []
  const nearest = new Array<number>(n).fill(Number.POSITIVE_INFINITY)
  let pick: number | null = first
  while (pick !== null && chosen.length < landmarkCap) {
    const row = distancesFrom(pick)
    rows.push(row)
    chosen.push(pick)
    for (let j = 0; j < n; j++) {
      const d = row[j]
      if (unplaced.has(j)) continue
      if (d === null || d === undefined || !Number.isFinite(d) || d < 0) {
        unplaced.set(
          j,
          chosen.length === 1
            ? `no ${embed.name} distance to the root`
            : `no ${embed.name} distance to landmark ${nodes[pick]!.nodeId}`,
        )
        continue
      }
      nearest[j] = Math.min(nearest[j]!, d)
    }
    if (unplaced.has(first)) break
    let next: number | null = null
    for (let j = 0; j < n; j++) {
      if (unplaced.has(j) || chosen.includes(j) || nearest[j]! <= 0) continue
      if (next === null || nearest[j]! > nearest[next]!) next = j
    }
    pick = next
  }
  // A landmark that later lost its own placement cannot anchor the scaling.
  const usable = chosen.map((node, position) => ({ node, row: rows[position]! }))
  const landmarks = usable.filter(({ node }) => !unplaced.has(node))
  if (landmarks.length === 0) {
    for (let j = 0; j < n; j++) {
      if (!unplaced.has(j)) unplaced.set(j, `the root has no ${embed.name} placement`)
    }
    return {
      coordinates,
      full: new Array(n).fill(undefined),
      fullAxes: 0,
      fullExplained: null,
      unplaced,
      landmarks: 0,
      landmarkDistance: null,
      eigenvalues: [],
      explained: null,
      negativeMass: null,
    }
  }
  const L = landmarks.length
  const squared = landmarks.map(({ row: rowA, node: a }) =>
    landmarks.map(({ row: rowB, node: b }) => {
      const d = ((rowA[b] ?? 0) + (rowB[a] ?? 0)) / 2
      return d * d
    }),
  )
  const columnMean = squared[0]!.map((_, j) => squared.reduce((sum, row) => sum + row[j]!, 0) / L)
  const grand = mean(columnMean)
  const b = squared.map((row, i) =>
    row.map((value, j) => -0.5 * (value - columnMean[i]! - columnMean[j]! + grand)),
  )
  const between: number[] = []
  for (let i = 0; i < L; i++)
    for (let j = i + 1; j < L; j++) between.push(Math.sqrt(squared[i]![j]!))
  const { values, vectors } = symmetricEigen(b)
  const positive = values.filter((value) => value > 1e-12)
  const positiveMass = positive.reduce((sum, value) => sum + value, 0)
  const negativeMass = values
    .filter((value) => value < -1e-12)
    .reduce((sum, value) => sum - value, 0)
  let fullAxes = 2
  let held = values.slice(0, 2).reduce((sum, value) => sum + Math.max(value, 0), 0)
  while (
    fullAxes < FULL_AXES_MAX &&
    positiveMass > 0 &&
    held / positiveMass < FULL_AXES_MASS &&
    (values[fullAxes] ?? 0) > 1e-12
  ) {
    held += values[fullAxes]!
    fullAxes += 1
  }
  const allAxes = Array.from({ length: fullAxes }, (_, k) =>
    (values[k] ?? 0) > 1e-12 ? { value: values[k]!, vector: vectors[k]! } : null,
  )
  const axes = allAxes.slice(0, 2)
  const full: Placement['full'] = new Array(n).fill(undefined)
  for (let j = 0; j < n; j++) {
    if (unplaced.has(j)) continue
    const coordinate = allAxes.map((axis) => {
      if (axis === null) return 0
      let sum = 0
      for (let l = 0; l < L; l++) {
        const d = landmarks[l]!.row[j]!
        sum += (d * d - columnMean[l]!) * axis.vector[l]!
      }
      return (-0.5 * sum) / Math.sqrt(axis.value)
    })
    coordinates[j] = [coordinate[0]!, coordinate[1]!]
    full[j] = coordinate
  }
  return {
    coordinates,
    full,
    fullAxes,
    fullExplained: positiveMass > 0 ? Math.min(1, held / positiveMass) : null,
    unplaced,
    landmarks: L,
    landmarkDistance:
      between.length === 0
        ? null
        : { median: round9(median(between)!), max: round9(Math.max(...between)) },
    eigenvalues: values,
    explained:
      positiveMass > 0
        ? axes.reduce((sum, axis) => sum + (axis?.value ?? 0), 0) / positiveMass
        : null,
    negativeMass:
      positiveMass + negativeMass > 0 ? negativeMass / (positiveMass + negativeMass) : null,
  }
}

/**
 * The undirected lineage graph by node index: an edge joins a child to each
 * parent in this search when its operator edits a parent (improve, debug,
 * merge). Every recorded edge counts, re-proposals into an existing node
 * included, since each says the child is one edit from that parent.
 */
export function lineageAdjacency(
  state: SearchStateView,
  index: ReadonlyMap<string, number>,
): number[][] {
  const neighbours: Set<number>[] = Array.from({ length: index.size }, () => new Set<number>())
  for (const edge of state.edges()) {
    if (edge.operator !== 'improve' && edge.operator !== 'debug' && edge.operator !== 'merge') {
      continue
    }
    const child = index.get(edge.childNodeId)
    if (child === undefined) continue
    for (const parent of edge.parents) {
      if (parent.searchId !== state.searchId) continue
      const at = index.get(parent.nodeId)
      if (at === undefined || at === child) continue
      neighbours[child]!.add(at)
      neighbours[at]!.add(child)
    }
  }
  return neighbours.map((set) => [...set].sort((left, right) => left - right))
}

/** Distances from one node to every node, by the embedding's kind. */
function distanceRows(
  nodes: readonly SearchNode[],
  embed: LandscapeEmbedding,
  adjacency: () => number[][],
): (from: number) => Array<number | null> {
  const n = nodes.length
  if (embed.kind === 'lineage') {
    const neighbours = adjacency()
    return (from) => {
      const hops: Array<number | null> = new Array(n).fill(null)
      hops[from] = 0
      const queue = [from]
      for (let head = 0; head < queue.length; head++) {
        const at = queue[head]!
        for (const next of neighbours[at]!) {
          if (hops[next] !== null) continue
          hops[next] = hops[at]! + 1
          queue.push(next)
        }
      }
      return hops
    }
  }
  if (embed.kind === 'vector') {
    const vectors = nodes.map((node) => embed.vector(node))
    const size = vectors.find((vector) => vector !== null)?.length ?? 0
    return (from) =>
      vectors.map((vector) => {
        const own = vectors[from]
        if (!own || !vector || own.length !== size || vector.length !== size) return null
        let sum = 0
        for (let d = 0; d < size; d++) sum += (own[d]! - vector[d]!) ** 2
        return Math.sqrt(sum)
      })
  }
  return (from) => nodes.map((node, j) => (j === from ? 0 : embed.distance(nodes[from]!, node)))
}
