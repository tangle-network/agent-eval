/** Persistent score peaks over a connected symmetric nearest-neighbour graph. */
import { zQuantile } from '../../statistics/internal'
import { evenSample, plural, round9 } from './geometry'
import type { LandscapeData, LandscapeNode } from './landscape-contract'
import {
  BASIN_ALPHA,
  BASIN_METHOD,
  BASIN_NEIGHBOURS,
  BASIN_NODES,
  BASIN_TOP,
  SURFACE_MIN_NODES,
} from './landscape-contract'

export function graphBasins(
  records: readonly LandscapeNode[],
  scoredNodes: readonly LandscapeNode[],
  fullOf: ReadonlyMap<string, readonly number[]>,
  space: { axes: number; explained: number | null },
  pooledVariance: number | null,
  degreesOfFreedom: number,
): LandscapeData['basins'] {
  const empty = (reason: string): LandscapeData['basins'] => ({
    count: null,
    neighbours: 0,
    localMaxima: 0,
    z: null,
    graphNodes: 0,
    graphAxes: 0,
    graphExplained: null,
    method: BASIN_METHOD,
    insufficient: reason,
    peaks: [],
  })
  let scored = scoredNodes
  if (scored.length < SURFACE_MIN_NODES) {
    return empty(
      `${plural(scored.length, 'placed node')} not decided invalid share 2 or more units with the root; basins need ${SURFACE_MIN_NODES}`,
    )
  }
  if (pooledVariance === null || pooledVariance <= 0) {
    return empty('no pooled between-unit variance, so the noise a peak must clear is unknown')
  }
  const sample = new Set(evenSample(scored, BASIN_NODES))
  for (const node of [...scored]
    .sort((left, right) => right.score! - left.score! || left.ordinal - right.ordinal)
    .slice(0, BASIN_TOP)) {
    sample.add(node)
  }
  scored = scoredNodes.filter((node) => sample.has(node))
  const k = Math.min(BASIN_NEIGHBOURS, scored.length - 1)
  const points = scored.map((node) => fullOf.get(node.nodeId) ?? [node.x!, node.y!])
  const adjacency = connectComponents(points, nearestNeighbours(points, k))
  const variance = (index: number) => pooledVariance / scored[index]!.pairs
  const order = scored
    .map((_, index) => index)
    .sort(
      (left, right) =>
        scored[right]!.score! - scored[left]!.score! ||
        scored[left]!.ordinal - scored[right]!.ordinal,
    )
  const rank = new Int32Array(scored.length)
  order.forEach((index, position) => {
    rank[index] = position
  })
  const parent = new Int32Array(scored.length).fill(-1)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]!
    let at = index
    while (parent[at] !== root) {
      const next = parent[at]!
      parent[at] = root
      at = next
    }
    return root
  }
  // Every local maximum could survive its saddle, so each is a test.
  let maxima = 0
  for (let index = 0; index < scored.length; index++) {
    if (adjacency[index]!.every((neighbour) => rank[neighbour]! > rank[index]!)) maxima += 1
  }
  const z = zQuantile(1 - BASIN_ALPHA / Math.max(1, maxima - 1))
  const survived = new Map<number, { saddle: number; persistence: number; threshold: number }>()
  for (const index of order) {
    let highest = -1
    for (const neighbour of adjacency[index]!) {
      if (parent[neighbour] === -1) continue
      if (highest === -1 || rank[neighbour]! < rank[highest]!) highest = neighbour
    }
    if (highest === -1) {
      parent[index] = index
      continue
    }
    parent[index] = find(highest)
    for (const neighbour of adjacency[index]!) {
      if (parent[neighbour] === -1) continue
      const mine = find(index)
      const theirs = find(neighbour)
      if (mine === theirs) continue
      const [high, low] = rank[mine]! < rank[theirs]! ? [mine, theirs] : [theirs, mine]
      const persistence = scored[low]!.score! - scored[index]!.score!
      const threshold = z * Math.sqrt(variance(low) + variance(index))
      if (persistence < threshold) {
        parent[low] = high
      } else if (!survived.has(low)) {
        survived.set(low, { saddle: index, persistence, threshold })
      }
    }
  }
  const peaks = [...new Set(order.map(find))].sort((left, right) => rank[left]! - rank[right]!)
  const basinOf = new Map(peaks.map((peak, basin) => [peak, basin]))
  const members = new Array<number>(peaks.length).fill(0)
  const byNode = new Map<string, number>()
  scored.forEach((node, index) => {
    const basin = basinOf.get(find(index))!
    byNode.set(node.nodeId, basin)
    members[basin]! += 1
  })
  for (const record of records) record.basin = byNode.get(record.nodeId) ?? null
  return {
    count: peaks.length,
    neighbours: k,
    localMaxima: maxima,
    z: round9(z),
    graphNodes: scored.length,
    graphAxes: space.axes,
    graphExplained: space.explained === null ? null : round9(space.explained),
    method: `${BASIN_METHOD}; pooled over ${degreesOfFreedom} degrees of freedom`,
    insufficient: null,
    peaks: peaks.map((peak, basin) => {
      const node = scored[peak]!
      const own = survived.get(peak) ?? null
      return {
        peak: {
          nodeId: node.nodeId,
          x: node.x!,
          y: node.y!,
          score: node.score!,
          pairs: node.pairs,
        },
        persistence: own === null ? null : round9(own.persistence),
        threshold: own === null ? null : round9(own.threshold),
        saddle: own === null ? null : scored[own.saddle]!.nodeId,
        nodes: members[basin]!,
      }
    }),
  }
}

function connectComponents(
  points: readonly (readonly number[])[],
  adjacency: number[][],
): number[][] {
  const n = points.length
  const parent = Int32Array.from({ length: n }, (_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]!
    while (parent[index] !== root) {
      const next = parent[index]!
      parent[index] = root
      index = next
    }
    return root
  }
  for (let a = 0; a < n; a++) for (const b of adjacency[a]!) parent[find(a)] = find(b)
  const edges = adjacency.map((list) => new Set(list))
  for (;;) {
    const component = Int32Array.from({ length: n }, (_, index) => find(index))
    const best = new Map<number, { a: number; b: number; distance: number }>()
    for (let a = 0; a < n; a++) {
      const own = component[a]!
      for (let b = 0; b < n; b++) {
        if (component[b] === own) continue
        const distance = euclidean(points[a]!, points[b]!)
        const known = best.get(own)
        if (!known || distance < known.distance) best.set(own, { a, b, distance })
      }
    }
    if (best.size === 0) break
    for (const { a, b } of best.values()) {
      edges[a]!.add(b)
      edges[b]!.add(a)
      parent[find(a)] = find(b)
    }
  }
  return edges.map((set) => [...set].sort((left, right) => left - right))
}

function nearestNeighbours(points: readonly (readonly number[])[], k: number): number[][] {
  const n = points.length
  const adjacency: Set<number>[] = Array.from({ length: n }, () => new Set<number>())
  if (n < 2 || k < 1) return adjacency.map(() => [])
  for (let index = 0; index < n; index++) {
    const best: Array<{ index: number; distance: number }> = []
    for (let other = 0; other < n; other++) {
      if (other === index) continue
      const distance = euclidean(points[index]!, points[other]!)
      if (best.length === k && distance >= best[k - 1]!.distance) continue
      best.push({ index: other, distance })
      best.sort((left, right) => left.distance - right.distance || left.index - right.index)
      if (best.length > k) best.length = k
    }
    for (const { index: other } of best) {
      adjacency[index]!.add(other)
      adjacency[other]!.add(index)
    }
  }
  return adjacency.map((set) => [...set].sort((left, right) => left - right))
}

function euclidean(left: readonly number[], right: readonly number[]): number {
  let sum = 0
  for (let d = 0; d < left.length; d++) sum += (left[d]! - (right[d] ?? 0)) ** 2
  return Math.sqrt(sum)
}
