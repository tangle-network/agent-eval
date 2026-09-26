/**
 * The landscape lens: where each node sits in edit space, and how the score
 * varies over it.
 *
 * Nodes are placed in two dimensions by landmark classical multidimensional
 * scaling (de Silva and Tenenbaum, 2004) of a pluggable distance between
 * their profiles. The default distance counts the edits the ledger recorded
 * between two profiles along their lineage; a caller that can read the
 * surface blobs passes `surfaceTextEdits`, and a caller with a model
 * embedding passes `vectorEmbedding`. Every node's score is its improvement
 * over the root on the units both scored, in the objective's direction, with
 * the standard error its shared units give it. Kriging (Gaussian-process
 * regression with each node's own noise) interpolates the scores over a grid
 * and leaves a cell unknown where the nodes do not constrain it. Basins are
 * the peaks of the node scores on the nearest-neighbour graph that stand
 * above their saddle by two standard errors (0-dimensional persistence of the
 * superlevel sets, ToMATo).
 *
 * The signal is `plateau`: how far the best improvement over the root rose
 * across the last `window` screened nodes, in units of that node's standard
 * error. Below 1 the search is on a plateau; a policy that drafts afresh when
 * it is (`draftOnPlateau`) reads the same function on its own view.
 */

import { searchPosterior } from '../../campaign/estimate-node'
import { searchPolicyView } from '../../campaign/search-kernel'
import type {
  SearchCandidateSurface,
  SearchEstimateMethod,
  SearchNodeStatus,
} from '../../campaign/search-ledger-types'
import type { SearchNode, SearchStateView } from '../../campaign/search-state'
import { canonicalString, compareCodeUnits } from '../../ledger-core/canonical'
import { cholesky } from '../../math/cholesky'
import { symmetricEigen } from '../../math/symmetric-eigen'
import {
  estimateMethodFor,
  evenSample,
  type GeometryLensResult,
  type GeometrySignal,
  headSequence,
  median,
  plural,
  positiveInteger,
  round9,
  screenedNodes,
} from './geometry'
import { PLATEAU_METHOD, type SearchPlateau, searchPlateau } from './plateau'
import { INSUFFICIENT_FROM, rankingSplit } from './shared'

// ── Embeddings ───────────────────────────────────────────────────────

/**
 * How the lens measures the distance between two nodes' profiles.
 *
 * - `lineage`: edits along the lineage graph, one per recorded improve,
 *   debug or merge edge between nodes of this search. A draft edge is not an
 *   edit (the draft is written afresh), so a draft's lineage is unreachable
 *   by this distance and unplaced, never guessed; `surfaceTextEdits` places it.
 * - `distance`: any symmetric distance; null when it cannot be measured.
 * - `vector`: a vector per node, for example a model embedding of the
 *   profile; nodes are compared by Euclidean distance.
 */
export type LandscapeEmbedding =
  | { kind: 'lineage'; name: string; method: string }
  | {
      kind: 'distance'
      name: string
      method: string
      distance(a: SearchNode, b: SearchNode): number | null
    }
  | {
      kind: 'vector'
      name: string
      method: string
      vector(node: SearchNode): readonly number[] | null
    }

/** The default: edits recorded between two profiles along the lineage. */
export function lineageEdits(): LandscapeEmbedding {
  return {
    kind: 'lineage',
    name: 'lineage-edits',
    method:
      'edits between the two profiles along the recorded lineage: the fewest improve, debug or merge edges joining them (a re-proposal edge counts; a draft is written afresh, so its edge is no edit of its anchor)',
  }
}

/** Surfaces whose content digests differ: the edit distance between two
 * profiles at the granularity of their declared surfaces. */
export function surfaceDigestEdits(): LandscapeEmbedding {
  return {
    kind: 'distance',
    name: 'surface-digest-edits',
    method: 'declared surfaces whose content digests differ (a surface only one node has counts)',
    distance(a, b) {
      const left = new Map(
        a.surfaces.map((surface) => [surface.surfaceId, surface.artifact.sha256]),
      )
      let count = 0
      const seen = new Set<string>()
      for (const surface of b.surfaces) {
        seen.add(surface.surfaceId)
        if (left.get(surface.surfaceId) !== surface.artifact.sha256) count += 1
      }
      for (const surfaceId of left.keys()) if (!seen.has(surfaceId)) count += 1
      return count
    },
  }
}

/**
 * Line edits between the surfaces' texts: for each declared surface, the
 * fewest line insertions and deletions that turn one text into the other
 * (Myers, 1986), summed over surfaces. `read` returns a surface's content:
 * a string, parsed JSON (flattened with `profileTextLines`), or null when it
 * cannot be read, which leaves every distance of that node unknown. The lens
 * stays pure; the caller owns the I/O and its verification.
 */
export function surfaceTextEdits(
  read: (surface: SearchCandidateSurface) => unknown,
): LandscapeEmbedding {
  const lines = new Map<string, string[] | null>()
  const linesOf = (surface: SearchCandidateSurface): string[] | null => {
    const key = surface.artifact.sha256
    if (!lines.has(key)) {
      const content = read(surface)
      lines.set(
        key,
        content === null || content === undefined
          ? null
          : typeof content === 'string'
            ? content.split('\n')
            : profileTextLines(content),
      )
    }
    return lines.get(key)!
  }
  return {
    kind: 'distance',
    name: 'surface-text-edits',
    method:
      'line insertions plus deletions between the surface texts (Myers diff), summed over declared surfaces; JSON is flattened to one line per leaf and per line of a string',
    distance(a, b) {
      const right = new Map(b.surfaces.map((surface) => [surface.surfaceId, surface]))
      let total = 0
      const seen = new Set<string>()
      for (const surface of a.surfaces) {
        seen.add(surface.surfaceId)
        const own = linesOf(surface)
        if (own === null) return null
        const other = right.get(surface.surfaceId)
        if (!other) {
          total += own.length
          continue
        }
        if (other.artifact.sha256 === surface.artifact.sha256) continue
        const theirs = linesOf(other)
        if (theirs === null) return null
        total += lineEditDistance(own, theirs)
      }
      for (const surface of b.surfaces) {
        if (seen.has(surface.surfaceId)) continue
        const theirs = linesOf(surface)
        if (theirs === null) return null
        total += theirs.length
      }
      return total
    },
  }
}

/** A caller's vector per node, for example a model embedding of its profile. */
export function vectorEmbedding(
  name: string,
  vector: (node: SearchNode) => readonly number[] | null,
): LandscapeEmbedding {
  return {
    kind: 'vector',
    name,
    method: `Euclidean distance between ${name} vectors`,
    vector,
  }
}

/**
 * JSON as lines a diff can count: one line per scalar leaf, `path=value`, and
 * one line per line of a string, so an edit inside a long prompt counts the
 * lines it changed rather than the whole prompt. Object keys are visited in
 * code-unit order.
 */
export function profileTextLines(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    const parts = value.split('\n')
    return parts.length === 1
      ? [`${path}=${canonicalString(value)}`]
      : parts.map((line, index) => `${path}[${index}]=${canonicalString(line)}`)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${path}=[]`]
    return value.flatMap((entry, index) => profileTextLines(entry, `${path}[${index}]`))
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort(compareCodeUnits)
    if (keys.length === 0) return [`${path}={}`]
    return keys.flatMap((key) =>
      profileTextLines((value as Record<string, unknown>)[key], `${path}.${key}`),
    )
  }
  return [`${path}=${canonicalString(value ?? null)}`]
}

/** Fewest line insertions plus deletions turning `a` into `b` (Myers' O(ND)
 * greedy algorithm, which is fast when the texts are close). */
export function lineEditDistance(a: readonly string[], b: readonly string[]): number {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return 0
  const offset = max
  const v = new Int32Array(2 * max + 2)
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) return d
    }
  }
  return max
}

// ── The lens ─────────────────────────────────────────────────────────

export interface LandscapeOptions {
  /** The split scores come from. Default: the ranked split. */
  split?: 'selection' | 'train'
  /** Landmarks of the scaling. Default 32; a search with fewer nodes scales exactly. */
  landmarks?: number
  /** Grid columns and rows. Default 24. */
  grid?: number
  /** Scored nodes the surface is fitted on, evenly spaced in registration
   * order with the root and the best node always in. Default 400. */
  surfaceNodes?: number
  /** Screened nodes the plateau reads. Default 6. */
  window?: number
  /** Attempts the kernel gives an errored cell. Default 3. */
  maxAttempts?: number
}

export interface LandscapeNode {
  nodeId: string
  ordinal: number
  depth: number | null
  status: SearchNodeStatus | null
  /** The operator of the node's first edge. */
  operator: string | null
  /** Null when the node could not be placed; `unplaced` says why. */
  x: number | null
  y: number | null
  unplaced: string | null
  /** Improvement over the root on shared units, larger is better; null
   * without a shared unit. */
  score: number | null
  /** Standard error of `score`: sqrt(pooled variance / pairs); 0 for the
   * root, null when the pooled variance is unknown. */
  standardError: number | null
  pairs: number
  method: SearchEstimateMethod
  /** Index into `basins.peaks`; null when unplaced, unscored, or when basins
   * are insufficient. */
  basin: number | null
}

export interface LandscapeGrid {
  columns: number
  rows: number
  x: [number, number]
  y: [number, number]
  /** Posterior mean of the improvement over the root, `values[row][column]`;
   * row 0 is the lowest y. Null where the nodes explain less than half the
   * prior variance: the surface there is unknown, not flat. */
  values: (number | null)[][]
  /** Posterior standard deviation at each cell, supported or not. */
  sd: number[][]
  supportedCells: number
  /** The kriging model: a constant mean, a squared-exponential covariance of
   * `priorVariance` and `lengthScale` (in coordinate units), and each node's
   * own noise variance, pooled variance over its shared units. */
  model: {
    mean: number
    priorVariance: number
    lengthScale: number
    /** Log marginal likelihood of the chosen length scale. */
    logLikelihood: number
    /** Nodes the surface was fitted on (at most `surfaceNodes`). */
    fitNodes: number
  }
  method: string
}

export interface LandscapeBasin {
  /** The basin's best node: the peak of its component. */
  peak: { nodeId: string; x: number; y: number; score: number; pairs: number }
  /** How far the peak stands above the saddle node where its component first
   * met a higher one; null for the highest peak and for a component that
   * never met a higher one (a separate region of the graph). */
  persistence: number | null
  /** The persistence this peak needed: two standard errors of the difference
   * between the peak's and the saddle's scores. Null for the highest peak. */
  threshold: number | null
  saddle: string | null
  nodes: number
}

export interface LandscapeData {
  split: 'selection' | 'train'
  direction: 'maximize' | 'minimize'
  embedding: {
    name: string
    method: string
    landmarks: number
    /** Median and largest distance between two landmarks, in the embedding's
     * own unit (for example lines edited): how far apart the profiles are. */
    landmarkDistance: { median: number; max: number } | null
    /** Of the scaled landmark matrix, largest first. */
    eigenvalues: number[]
    /** Share of the positive eigenvalue mass the two axes hold. */
    explained: number | null
    /** Share of the absolute eigenvalue mass that is negative: how far the
     * distance departs from a Euclidean one. */
    negativeMass: number | null
    placed: number
    unplaced: number
  }
  nodes: LandscapeNode[]
  /** Parent-to-child segments of every node's lineage. */
  lineage: Array<{ parent: string; child: string; operator: string }>
  grid: LandscapeGrid | null
  gridInsufficient: string | null
  basins: {
    count: number | null
    /** Neighbours each node joins in the graph the basins are read on. */
    neighbours: number
    method: string
    insufficient: string | null
    peaks: LandscapeBasin[]
  }
  plateau: SearchPlateau
}

const GRID_METHOD =
  "Gaussian-process regression (ordinary kriging) of node scores: a constant mean (generalized least squares), a squared-exponential covariance whose prior variance is the between-node variance of the scores minus their mean noise and whose length scale maximizes the marginal likelihood over 0.5, 1, 2 and 4 times the median nearest-neighbour distance, and each node's own noise variance (the pooled between-unit variance over its units shared with the root; the root is the reference at exactly 0); nodes with fewer than 2 shared units are left out; a cell is null where the posterior variance exceeds half the prior variance, so the surface never extends past the nodes that support it"
/** Scored nodes a surface or a basin count needs: the library's minimum
 * sample for anything descriptive, as for units. */
const SURFACE_MIN_NODES = INSUFFICIENT_FROM
const BASIN_METHOD =
  '0-dimensional persistence of node scores on the symmetric k-nearest-neighbour graph of placed nodes (ToMATo, Chazal et al. 2013): nodes enter from the highest score down, and where two components meet, the lower peak merges into the higher unless it stands above that saddle node by two standard errors of their difference, sqrt(pooled variance / shared units) per node'

/**
 * The landscape of a search: every node placed by `embed`, the interpolated
 * score over the placement, the basins of that surface, and the plateau
 * signal. Pure: it reads the state and calls `embed`.
 */
export function landscape(
  state: SearchStateView,
  embed: LandscapeEmbedding = lineageEdits(),
  options: LandscapeOptions = {},
): GeometryLensResult<LandscapeData> {
  const landmarkCap = positiveInteger('landscape', 'landmarks', options.landmarks ?? 32)
  const columns = positiveInteger('landscape', 'grid', options.grid ?? 24)
  const surfaceNodes = positiveInteger('landscape', 'surfaceNodes', options.surfaceNodes ?? 400)
  const window = options.window ?? 6
  const header = state.header
  const split = options.split ?? rankingSplit(state)
  const direction = header?.objective.direction ?? 'maximize'
  const plateauEmpty = (reason: string): SearchPlateau => ({
    value: null,
    window,
    accepted: 0,
    windowNodes: [],
    rise: null,
    noise: null,
    best: null,
    pooledVariance: null,
    degreesOfFreedom: 0,
    method: PLATEAU_METHOD,
    insufficient: reason,
  })
  const rootNodeId = header ? state.rootNodeId : null
  if (!header || rootNodeId === null) {
    const reason = header ? 'the search has no root node yet' : 'the search has not been opened'
    return result(state, emptyData(split, direction, embed, reason, plateauEmpty(reason)))
  }

  const nodes = state.nodes()
  const index = new Map(nodes.map((node, position) => [node.nodeId, position]))
  const posterior = searchPosterior(state, { split })
  const scoreOf = new Map(posterior.nodes.map((entry) => [entry.nodeId, entry]))
  const placement = placeNodes(nodes, index, rootNodeId, embed, landmarkCap, () =>
    lineageAdjacency(state, index),
  )

  const records: LandscapeNode[] = nodes.map((node, position) => {
    const entry = scoreOf.get(node.nodeId)!
    const firstEdge = node.edgeIds[0] ? state.edge(node.edgeIds[0]) : undefined
    const at = placement.coordinates[position]
    return {
      nodeId: node.nodeId,
      ordinal: node.ordinal,
      depth: node.depth,
      status: node.status,
      operator: firstEdge?.operator ?? null,
      x: at ? round9(at[0]) : null,
      y: at ? round9(at[1]) : null,
      unplaced: at ? null : (placement.unplaced.get(position) ?? 'not placed'),
      score: entry.mean === null ? null : round9(entry.mean),
      standardError: entry.variance === null ? null : round9(Math.sqrt(entry.variance)),
      pairs: entry.pairs,
      method: estimateMethodFor(entry.pairs),
      basin: null,
    }
  })
  const lineage: LandscapeData['lineage'] = []
  for (const node of nodes) {
    const operator = node.edgeIds[0] ? (state.edge(node.edgeIds[0])?.operator ?? 'unknown') : 'none'
    for (const parent of node.parents) {
      if (parent.searchId !== state.searchId) continue
      lineage.push({ parent: parent.nodeId, child: node.nodeId, operator })
    }
  }

  const scored = records.filter(
    (record) => record.x !== null && record.score !== null && record.pairs >= 2,
  )
  const variances = new Map(posterior.nodes.map((entry) => [entry.nodeId, entry.variance]))
  const gridResult = krige(records, scored, variances, columns, surfaceNodes)
  const basins = graphBasins(records, scored, posterior.pooledVariance, posterior.degreesOfFreedom)

  const view = searchPolicyView(state, {
    screened: screenedNodes(state, { maxAttempts: options.maxAttempts }),
    screening: 0,
    expansions: 0,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  })
  // The plateau reads the policy's own view, so a policy that drafts on it
  // (`draftOnPlateau`) sees this number; it ranks on the policy's split.
  const plateau = searchPlateau(view, { window })

  return result(state, {
    split,
    direction,
    embedding: {
      name: embed.name,
      method: embed.method,
      landmarks: placement.landmarks,
      landmarkDistance: placement.landmarkDistance,
      eigenvalues: placement.eigenvalues.map(round9),
      explained: placement.explained === null ? null : round9(placement.explained),
      negativeMass: placement.negativeMass === null ? null : round9(placement.negativeMass),
      placed: records.filter((record) => record.x !== null).length,
      unplaced: records.filter((record) => record.x === null).length,
    },
    nodes: records,
    lineage,
    grid: gridResult.grid,
    gridInsufficient: gridResult.insufficient,
    basins,
    plateau,
  })
}

function result(state: SearchStateView, data: LandscapeData): GeometryLensResult<LandscapeData> {
  const { plateau } = data
  const signal: GeometrySignal = {
    name: 'plateau',
    value: plateau.value,
    subject: plateau.best?.nodeId ?? null,
    method: plateau.method,
    n: plateau.accepted,
    insufficient: plateau.insufficient,
  }
  return {
    lens: 'landscape',
    searchId: state.searchId,
    sequence: headSequence(state),
    data,
    signal,
  }
}

function emptyData(
  split: 'selection' | 'train',
  direction: 'maximize' | 'minimize',
  embed: LandscapeEmbedding,
  reason: string,
  plateau: SearchPlateau,
): LandscapeData {
  return {
    split,
    direction,
    embedding: {
      name: embed.name,
      method: embed.method,
      landmarks: 0,
      landmarkDistance: null,
      eigenvalues: [],
      explained: null,
      negativeMass: null,
      placed: 0,
      unplaced: 0,
    },
    nodes: [],
    lineage: [],
    grid: null,
    gridInsufficient: reason,
    basins: { count: null, neighbours: 0, method: BASIN_METHOD, insufficient: reason, peaks: [] },
    plateau,
  }
}

// ── Placement: landmark classical MDS ────────────────────────────────

interface Placement {
  coordinates: Array<[number, number] | undefined>
  unplaced: Map<number, string>
  landmarks: number
  landmarkDistance: { median: number; max: number } | null
  eigenvalues: number[]
  explained: number | null
  negativeMass: number | null
}

function placeNodes(
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
  const grand = columnMean.reduce((sum, value) => sum + value, 0) / L
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
  const axes = [0, 1].map((k) =>
    (values[k] ?? 0) > 1e-12 ? { value: values[k]!, vector: vectors[k]! } : null,
  )
  for (let j = 0; j < n; j++) {
    if (unplaced.has(j)) continue
    const coordinate = axes.map((axis) => {
      if (axis === null) return 0
      let sum = 0
      for (let l = 0; l < L; l++) {
        const d = landmarks[l]!.row[j]!
        sum += (d * d - columnMean[l]!) * axis.vector[l]!
      }
      return (-0.5 * sum) / Math.sqrt(axis.value)
    })
    coordinates[j] = [coordinate[0]!, coordinate[1]!]
  }
  return {
    coordinates,
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
function lineageAdjacency(state: SearchStateView, index: ReadonlyMap<string, number>): number[][] {
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

// ── Interpolation and basins ─────────────────────────────────────────

/**
 * The score surface by ordinary kriging. Each scored node is a noisy
 * observation of the surface at its placement, with its own noise variance
 * (the root, the reference, is exact). The prior variance is the scores'
 * between-node variance minus their mean noise; when that is not positive the
 * nodes do not differ beyond noise and there is no surface to draw. The length
 * scale maximizes the marginal likelihood over a few multiples of the median
 * nearest-neighbour distance, never below one grid cell.
 */
function krige(
  records: readonly LandscapeNode[],
  scored: readonly LandscapeNode[],
  variances: ReadonlyMap<string, number | null>,
  columns: number,
  surfaceNodes: number,
): { grid: LandscapeGrid | null; insufficient: string | null } {
  if (scored.length < SURFACE_MIN_NODES) {
    return {
      grid: null,
      insufficient: `${plural(scored.length, 'placed node')} share 2 or more units with the root; a surface needs ${SURFACE_MIN_NODES}`,
    }
  }
  const noiseOf = (node: LandscapeNode): number | null => variances.get(node.nodeId) ?? null
  if (scored.some((node) => noiseOf(node) === null)) {
    return {
      grid: null,
      insufficient: 'no pooled between-unit variance, so the noise of a node’s score is unknown',
    }
  }
  let [x0, x1, y0, y1] = [
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]
  for (const record of records) {
    if (record.x === null || record.y === null) continue
    x0 = Math.min(x0, record.x)
    x1 = Math.max(x1, record.x)
    y0 = Math.min(y0, record.y)
    y1 = Math.max(y1, record.y)
  }
  const span = Math.max(x1 - x0, y1 - y0)
  if (span <= 0) {
    return { grid: null, insufficient: 'every placed node sits at one point' }
  }
  const pad = span * 0.05
  x0 -= pad
  x1 += pad
  y0 -= pad
  y1 += pad
  // Fit on at most `surfaceNodes`, evenly spaced by registration, with the
  // root (the reference) and the best node always in.
  const byScore = [...scored].sort(
    (left, right) => right.score! - left.score! || left.ordinal - right.ordinal,
  )
  const keep = new Set(evenSample(scored, surfaceNodes))
  const rootNode = scored.find((node) => noiseOf(node) === 0)
  for (const must of [rootNode, byScore[0]]) {
    if (!must || keep.has(must)) continue
    const drop = [...keep].reverse().find((node) => node !== rootNode && node !== byScore[0])
    if (drop) keep.delete(drop)
    keep.add(must)
  }
  const fit = scored.filter((node) => keep.has(node))
  const n = fit.length
  const y = fit.map((node) => node.score!)
  const noise = fit.map((node) => noiseOf(node)!)
  const meanScore = y.reduce((sum, value) => sum + value, 0) / n
  const spread = y.reduce((sum, value) => sum + (value - meanScore) ** 2, 0) / (n - 1)
  const meanNoise = noise.reduce((sum, value) => sum + value, 0) / n
  const priorVariance = spread - meanNoise
  if (!(priorVariance > 0)) {
    return {
      grid: null,
      insufficient: `the nodes' scores vary no more than their noise (between-node variance ${fixed(spread)}, mean noise variance ${fixed(meanNoise)}), so there is no surface beyond a flat one`,
    }
  }
  const cell = Math.max(x1 - x0, y1 - y0) / columns
  const nearest = evenSample(fit, 2000).map((a, _, sample) => {
    let best = Number.POSITIVE_INFINITY
    for (const b of sample) {
      if (a === b) continue
      const d = Math.hypot(a.x! - b.x!, a.y! - b.y!)
      if (d > 0 && d < best) best = d
    }
    return best
  })
  const typical = Math.max(median(nearest.filter(Number.isFinite)) ?? cell, cell)
  // Distances are squared once; each length scale reuses them.
  const d2 = fit.map((a) => fit.map((b) => (a.x! - b.x!) ** 2 + (a.y! - b.y!) ** 2))
  const jitter = priorVariance * 1e-9
  let best: {
    lengthScale: number
    lower: number[][]
    alpha: number[]
    mean: number
    logLikelihood: number
  } | null = null
  for (const multiple of [0.5, 1, 2, 4]) {
    const lengthScale = Math.max(typical * multiple, cell)
    const covariance = d2.map((row, i) =>
      row.map(
        (value, j) =>
          priorVariance * Math.exp(-value / (2 * lengthScale * lengthScale)) +
          (i === j ? noise[i]! + jitter : 0),
      ),
    )
    const lower = cholesky(covariance)
    if (lower === null) continue
    // Generalized least squares for the constant mean: 1ᵀC⁻¹y / 1ᵀC⁻¹1.
    const ones = forward(lower, new Array<number>(n).fill(1))
    const whiteY = forward(lower, y)
    let numerator = 0
    let denominator = 0
    for (let i = 0; i < n; i++) {
      numerator += ones[i]! * whiteY[i]!
      denominator += ones[i]! * ones[i]!
    }
    const mean = numerator / denominator
    const residual = forward(
      lower,
      y.map((value) => value - mean),
    )
    let quadratic = 0
    let logDeterminant = 0
    for (let i = 0; i < n; i++) {
      quadratic += residual[i]! ** 2
      logDeterminant += 2 * Math.log(lower[i]![i]!)
    }
    const logLikelihood = -0.5 * (quadratic + logDeterminant + n * Math.log(2 * Math.PI))
    if (best === null || logLikelihood > best.logLikelihood) {
      best = { lengthScale, lower, alpha: backward(lower, residual), mean, logLikelihood }
    }
  }
  if (best === null) {
    return { grid: null, insufficient: 'the kriging covariance is not positive definite' }
  }
  const { lengthScale, lower, alpha, mean } = best
  const rows = columns
  const values: (number | null)[][] = []
  const sd: number[][] = []
  let supported = 0
  for (let r = 0; r < rows; r++) {
    const row: (number | null)[] = []
    const sdRow: number[] = []
    const gy = y0 + ((r + 0.5) * (y1 - y0)) / rows
    for (let c = 0; c < columns; c++) {
      const gx = x0 + ((c + 0.5) * (x1 - x0)) / columns
      const k = fit.map(
        (node) =>
          priorVariance *
          Math.exp(-((node.x! - gx) ** 2 + (node.y! - gy) ** 2) / (2 * lengthScale * lengthScale)),
      )
      let value = mean
      for (let i = 0; i < n; i++) value += k[i]! * alpha[i]!
      const white = forward(lower, k)
      let explained = 0
      for (const entry of white) explained += entry * entry
      const variance = Math.max(0, priorVariance - explained)
      sdRow.push(round9(Math.sqrt(variance)))
      if (variance <= priorVariance / 2) {
        row.push(round9(value))
        supported += 1
      } else {
        row.push(null)
      }
    }
    values.push(row)
    sd.push(sdRow)
  }
  return {
    grid: {
      columns,
      rows,
      x: [round9(x0), round9(x1)],
      y: [round9(y0), round9(y1)],
      values,
      sd,
      supportedCells: supported,
      model: {
        mean: round9(mean),
        priorVariance: round9(priorVariance),
        lengthScale: round9(lengthScale),
        logLikelihood: round9(best.logLikelihood),
        fitNodes: n,
      },
      method: GRID_METHOD,
    },
    insufficient: null,
  }
}

/** Solves L z = b for lower-triangular L. */
function forward(lower: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = lower.length
  const z = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    const row = lower[i]!
    let value = b[i]!
    for (let k = 0; k < i; k++) value -= row[k]! * z[k]!
    z[i] = value / row[i]!
  }
  return z
}

/** Solves Lᵀ x = z for lower-triangular L. */
function backward(lower: readonly (readonly number[])[], z: readonly number[]): number[] {
  const n = lower.length
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let value = z[i]!
    for (let k = i + 1; k < n; k++) value -= lower[k]![i]! * x[k]!
    x[i] = value / lower[i]![i]!
  }
  return x
}

function cellOf(grid: LandscapeGrid, x: number, y: number): number | null {
  const c = Math.min(
    grid.columns - 1,
    Math.max(0, Math.floor(((x - grid.x[0]) / (grid.x[1] - grid.x[0])) * grid.columns)),
  )
  const r = Math.min(
    grid.rows - 1,
    Math.max(0, Math.floor(((y - grid.y[0]) / (grid.y[1] - grid.y[0])) * grid.rows)),
  )
  return grid.values[r]![c] === null ? null : r * grid.columns + c
}

/**
 * Basins on the k-nearest-neighbour graph of the scored, placed nodes, by
 * ToMATo's sweep. Nodes enter from the highest score down (earlier
 * registration first on a tie). A node with no entered neighbour starts a
 * component, of which it is the peak; otherwise it joins its highest entered
 * neighbour's component. Where it touches another component, the one with
 * the lower peak merges into the higher unless its peak stands above this
 * node, the saddle, by two standard errors of their difference; a component
 * that survives its first saddle keeps that persistence. Every component left
 * at the end is a basin, labelled by its peak.
 */
function graphBasins(
  records: readonly LandscapeNode[],
  scored: readonly LandscapeNode[],
  pooledVariance: number | null,
  degreesOfFreedom: number,
): LandscapeData['basins'] {
  const empty = (reason: string): LandscapeData['basins'] => ({
    count: null,
    neighbours: 0,
    method: BASIN_METHOD,
    insufficient: reason,
    peaks: [],
  })
  if (scored.length < SURFACE_MIN_NODES) {
    return empty(
      `${plural(scored.length, 'placed node')} share 2 or more units with the root; basins need ${SURFACE_MIN_NODES}`,
    )
  }
  if (pooledVariance === null || pooledVariance <= 0) {
    return empty('no pooled between-unit variance, so the noise a peak must clear is unknown')
  }
  const k = Math.min(BASIN_NEIGHBOURS, scored.length - 1)
  const adjacency = nearestNeighbours(
    scored.map((node) => [node.x!, node.y!] as [number, number]),
    k,
  )
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
      const threshold = 2 * Math.sqrt(variance(low) + variance(index))
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

const BASIN_NEIGHBOURS = 6

/**
 * The symmetric k-nearest-neighbour graph of 2-D points: each point joins its
 * k nearest (ties by index) and every edge is kept in both directions. Points
 * are bucketed on a square grid about k points per cell, and each search
 * widens ring by ring until the k-th nearest is closer than the next ring.
 */
export function nearestNeighbours(
  points: readonly (readonly [number, number])[],
  k: number,
): number[][] {
  const n = points.length
  const adjacency: Set<number>[] = Array.from({ length: n }, () => new Set<number>())
  if (n < 2 || k < 1) return adjacency.map(() => [])
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity]
  for (const [x, y] of points) {
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  const span = Math.max(x1 - x0, y1 - y0, 1e-12)
  const side = Math.max(1, Math.floor(Math.sqrt(n / Math.max(1, k))))
  const cell = span / side
  const key = (cx: number, cy: number) => cx * (side + 1) + cy
  const bucketOf = (value: number, origin: number) =>
    Math.min(side, Math.max(0, Math.floor((value - origin) / cell)))
  const buckets = new Map<number, number[]>()
  points.forEach(([x, y], index) => {
    const at = key(bucketOf(x, x0), bucketOf(y, y0))
    const list = buckets.get(at)
    if (list) list.push(index)
    else buckets.set(at, [index])
  })
  for (let index = 0; index < n; index++) {
    const [x, y] = points[index]!
    const cx = bucketOf(x, x0)
    const cy = bucketOf(y, y0)
    const best: Array<{ index: number; distance: number }> = []
    for (let ring = 0; ring <= side + 1; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const list = buckets.get(key(cx + dx, cy + dy))
          if (!list || cx + dx < 0 || cy + dy < 0 || cx + dx > side || cy + dy > side) continue
          for (const other of list) {
            if (other === index) continue
            const distance = Math.hypot(points[other]![0] - x, points[other]![1] - y)
            best.push({ index: other, distance })
          }
        }
      }
      best.sort((left, right) => left.distance - right.distance || left.index - right.index)
      if (best.length > k) best.length = k
      if (best.length === k && best[k - 1]!.distance <= ring * cell) break
    }
    for (const { index: other } of best) {
      adjacency[index]!.add(other)
      adjacency[other]!.add(index)
    }
  }
  return adjacency.map((set) => [...set].sort((left, right) => left - right))
}

// ── Text ─────────────────────────────────────────────────────────────

const SHADES = ' .:-=+*#%@'

/** The landscape as text for a terminal or a proposer's context: the same
 * numbers the view draws, with a coarse shaded map. */
export function formatLandscape(lens: GeometryLensResult<LandscapeData>): string {
  const { data } = lens
  const lines: string[] = []
  const { embedding } = data
  lines.push(
    `Landscape (${data.split} split, larger is better; ${embedding.name}: ${embedding.method})`,
  )
  lines.push(
    `  placed ${embedding.placed} of ${embedding.placed + embedding.unplaced} nodes by landmark MDS on ${plural(embedding.landmarks, 'landmark')}${embedding.landmarkDistance ? ` (landmarks lie a median ${fixed(embedding.landmarkDistance.median)} and at most ${fixed(embedding.landmarkDistance.max)} apart)` : ''}; two axes hold ${percent(embedding.explained)} of the positive eigenvalue mass (negative mass ${percent(embedding.negativeMass)})`,
  )
  const reasons = new Map<string, number>()
  for (const node of data.nodes) {
    if (node.unplaced) reasons.set(node.unplaced, (reasons.get(node.unplaced) ?? 0) + 1)
  }
  for (const [reason, count] of reasons) lines.push(`  unplaced ${count}: ${reason}`)
  const methods = new Map<string, number>()
  for (const node of data.nodes) methods.set(node.method, (methods.get(node.method) ?? 0) + 1)
  lines.push(
    `  scores (improvement over the root on shared units): ${[
      'bootstrap',
      'descriptive',
      'insufficient',
      'none',
    ]
      .map((method) => `${methods.get(method) ?? 0} ${method}`)
      .join(', ')}`,
  )
  if (data.grid === null) {
    lines.push(`  surface: insufficient: ${data.gridInsufficient}`)
  } else {
    const { grid } = data
    lines.push(
      `  surface: ${grid.columns}×${grid.rows} grid kriged from ${plural(grid.model.fitNodes, 'node')} (mean ${signed(grid.model.mean)}, prior sd ${fixed(Math.sqrt(grid.model.priorVariance))}, length scale ${fixed(grid.model.lengthScale)}); ${grid.supportedCells} of ${grid.columns * grid.rows} cells supported (posterior variance at most half the prior)`,
    )
  }
  const { basins } = data
  if (basins.count === null) {
    lines.push(`  basins: insufficient: ${basins.insufficient}`)
  } else {
    lines.push(
      `  basins: ${basins.count} on the ${basins.neighbours}-nearest-neighbour graph (a lower peak counts when it stands two standard errors of the difference above its saddle)`,
    )
    basins.peaks.forEach((basin, index) => {
      const standing =
        basin.persistence === null
          ? index === 0
            ? 'the highest'
            : 'a separate region of the graph'
          : `persistence ${fixed(basin.persistence)} ≥ ${fixed(basin.threshold!)} over saddle ${basin.saddle}`
      lines.push(
        `    ${index + 1}. ${basin.peak.nodeId} ${signed(basin.peak.score)} on ${basin.peak.pairs} units at (${fixed(basin.peak.x)}, ${fixed(basin.peak.y)}), ${standing}; ${plural(basin.nodes, 'node')}`,
      )
    })
  }
  const { plateau } = data
  if (plateau.value === null) {
    lines.push(`  plateau: insufficient: ${plateau.insufficient}`)
  } else {
    const verdict = plateau.value < 1 ? 'on a plateau' : 'still climbing'
    lines.push(
      `  plateau: ${fixed(plateau.value)}: the best improvement over the root rose ${signed(plateau.rise!)} across the last ${plateau.window} of ${plateau.accepted} accepted nodes, one standard error ${fixed(plateau.noise!)} (best ${plateau.best!.nodeId} on ${plateau.best!.pairs} units, ${plateau.degreesOfFreedom} pooled df): ${verdict}`,
    )
  }
  if (data.grid !== null) {
    const { grid } = data
    const present = grid.values.flat().filter((value): value is number => value !== null)
    const low = Math.min(...present)
    const high = Math.max(...present)
    const marks = new Map<number, string>()
    basins.peaks.forEach((basin, index) => {
      const cell = cellOf(grid, basin.peak.x, basin.peak.y)
      if (cell !== null) marks.set(cell, String((index + 1) % 10))
    })
    lines.push(
      `  map (top row is the highest y; shade ${JSON.stringify(SHADES)} runs from ${signed(low)} to ${signed(high)}; digits mark each basin's peak node):`,
    )
    for (let r = grid.rows - 1; r >= 0; r--) {
      let row = ''
      for (let c = 0; c < grid.columns; c++) {
        const mark = marks.get(r * grid.columns + c)
        const value = grid.values[r]![c]
        if (mark) row += mark
        else if (value === null || value === undefined) row += ' '
        else {
          const level = high > low ? (value - low) / (high - low) : 0.5
          row += SHADES[Math.min(SHADES.length - 1, Math.floor(level * SHADES.length))]!
        }
      }
      lines.push(`    |${row}|`)
    }
  }
  return lines.join('\n')
}

function percent(value: number | null): string {
  return value === null ? 'unknown' : `${Math.round(value * 1000) / 10}%`
}

function fixed(value: number): string {
  return value.toFixed(3)
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`
}
