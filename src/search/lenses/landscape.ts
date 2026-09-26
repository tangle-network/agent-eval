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
 * over the root on the units both scored, in the objective's direction, and
 * a Gaussian kernel regression weighted by those shared units interpolates
 * the scores over a grid. Basins are the grid's peaks that stand above their
 * surroundings by more than the noise of one node's score (0-dimensional
 * persistence of the superlevel sets).
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
import type { SearchPolicyView } from '../../campaign/search-policy'
import type { SearchNode, SearchStateView } from '../../campaign/search-state'
import { canonicalString, compareCodeUnits } from '../../ledger-core/canonical'
import { symmetricEigen } from '../../math/symmetric-eigen'
import {
  DESCRIPTIVE_FROM_UNITS,
  estimateMethodFor,
  headSequence,
  median,
  rankedSplit,
  round9,
  screenedNodes,
} from './shared'
import type { SearchLensResult, SearchLensSignal } from './types'

// ── Embeddings ───────────────────────────────────────────────────────

/**
 * How the lens measures the distance between two nodes' profiles.
 *
 * - `lineage`: edits along the lineage graph, one per recorded edge, through
 *   every in-search parent. Nodes the root's lineage does not reach are
 *   unplaced, never guessed.
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
      'edits between the two profiles along the recorded lineage: the fewest edges joining them through in-search parents',
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

// ── The plateau signal ───────────────────────────────────────────────

/** What the plateau reads: a policy view, or the lens's own reading of one. */
export type SearchPlateauView = Pick<
  SearchPolicyView,
  'direction' | 'rootNodeId' | 'screened' | 'complete' | 'unitScores'
>

export interface SearchPlateau {
  /** `rise / noise`; null when insufficient. */
  value: number | null
  window: number
  /** Screened, complete non-root nodes with at least 2 units shared with the root. */
  accepted: number
  /** Best improvement over the root after the window minus before it. */
  rise: number | null
  /** Standard error of the best node's improvement: sqrt(pooled variance / its shared units). */
  noise: number | null
  best: { nodeId: string; gain: number; pairs: number } | null
  pooledVariance: number | null
  degreesOfFreedom: number
  method: string
  insufficient: string | null
}

const PLATEAU_METHOD =
  'rise of the best improvement over the root across the last `window` screened nodes, divided by the best node’s standard error; each improvement is the mean per-unit gain over the root on shared units in the objective’s direction, and the variance is the between-unit variance of those gains pooled over every accepted node with 2 or more shared units'

/**
 * The plateau score of a search: how many standard errors the best
 * improvement over the root rose across the last `window` screened nodes.
 * Nodes are taken in registration order; a node counts once its screen
 * finished, it dodged no unit, and it shares at least 2 units with the root.
 * Insufficient with fewer than `window` such nodes, with no pooled variance,
 * or when the best node shares fewer than 6 units with the root (the design's
 * `insufficient` threshold).
 */
export function searchPlateau(
  view: SearchPlateauView,
  options: { window?: number } = {},
): SearchPlateau {
  const window = options.window ?? 6
  if (!Number.isSafeInteger(window) || window < 1) {
    throw new TypeError(`searchPlateau: window must be a positive integer, got ${String(window)}`)
  }
  const sign = view.direction === 'maximize' ? 1 : -1
  const root = new Map(view.unitScores(view.rootNodeId).map((unit) => [unit.unitId, unit.mean]))
  const gains: Array<{ nodeId: string; gain: number; pairs: number }> = []
  let squares = 0
  let degreesOfFreedom = 0
  for (const nodeId of view.screened) {
    if (nodeId === view.rootNodeId || !view.complete(nodeId)) continue
    const deltas: number[] = []
    for (const unit of view.unitScores(nodeId)) {
      const base = root.get(unit.unitId)
      if (base !== undefined) deltas.push(sign * (unit.mean - base))
    }
    if (deltas.length < 2) continue
    const mean = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
    for (const delta of deltas) squares += (delta - mean) ** 2
    degreesOfFreedom += deltas.length - 1
    gains.push({ nodeId, gain: mean, pairs: deltas.length })
  }
  const pooledVariance = degreesOfFreedom > 0 ? squares / degreesOfFreedom : null
  const base = {
    window,
    accepted: gains.length,
    pooledVariance: pooledVariance === null ? null : round9(pooledVariance),
    degreesOfFreedom,
    method: PLATEAU_METHOD,
  }
  const empty = { value: null, rise: null, noise: null }
  // The root is the reference at exactly 0, so the best-so-far starts there.
  let best: { nodeId: string; gain: number; pairs: number } | null = null
  let before = 0
  for (let index = 0; index < gains.length; index++) {
    if (index === gains.length - window) before = best === null ? 0 : Math.max(0, best.gain)
    const entry = gains[index]!
    if (best === null || entry.gain > best.gain) best = entry
  }
  const bestOut = best === null ? null : roundBest(best)
  if (gains.length < window) {
    return {
      ...base,
      ...empty,
      best: bestOut,
      insufficient: `${gains.length} of ${window} screened nodes share 2 or more units with the root`,
    }
  }
  const leader = best as { nodeId: string; gain: number; pairs: number }
  if (pooledVariance === null || pooledVariance === 0) {
    return {
      ...base,
      ...empty,
      best: bestOut,
      insufficient:
        pooledVariance === null
          ? 'no pooled between-unit variance'
          : 'every shared-unit gain is identical within its node, so the noise is unmeasured',
    }
  }
  if (leader.pairs < DESCRIPTIVE_FROM_UNITS) {
    return {
      ...base,
      ...empty,
      best: bestOut,
      insufficient: `the best node shares ${leader.pairs} of ${DESCRIPTIVE_FROM_UNITS} units with the root`,
    }
  }
  const after = Math.max(0, leader.gain)
  const rise = after - before
  const noise = Math.sqrt(pooledVariance / leader.pairs)
  return {
    ...base,
    value: round9(rise / noise),
    rise: round9(rise),
    noise: round9(noise),
    best: bestOut,
    insufficient: null,
  }
}

function roundBest(best: { nodeId: string; gain: number; pairs: number }) {
  return { nodeId: best.nodeId, gain: round9(best.gain), pairs: best.pairs }
}

// ── The lens ─────────────────────────────────────────────────────────

export interface LandscapeOptions {
  /** The split scores come from. Default: the ranked split. */
  split?: 'selection' | 'train'
  /** Landmarks of the scaling. Default 32; a search with fewer nodes scales exactly. */
  landmarks?: number
  /** Grid columns and rows. Default 24. */
  grid?: number
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
  pairs: number
  method: SearchEstimateMethod
  /** Index into `basins.peaks`; null when unplaced, off the supported grid,
   * or when basins are insufficient. */
  basin: number | null
}

export interface LandscapeGrid {
  columns: number
  rows: number
  x: [number, number]
  y: [number, number]
  bandwidth: number
  /** `values[row][column]`; row 0 is the lowest y. Null where the nodes
   * nearby carry less than one unit of evidence. */
  values: (number | null)[][]
  supportedCells: number
  method: string
}

export interface LandscapeBasin {
  peak: { x: number; y: number; value: number }
  /** How far the peak stands above the saddle joining it to a higher peak;
   * null for the highest peak. */
  persistence: number | null
  cells: number
  nodes: number
  best: { nodeId: string; score: number; pairs: number } | null
}

export interface LandscapeData {
  split: 'selection' | 'train'
  direction: 'maximize' | 'minimize'
  embedding: {
    name: string
    method: string
    landmarks: number
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
    /** Persistence a peak needs to count: the standard error of a node's
     * score at the median shared units. */
    threshold: number | null
    method: string
    insufficient: string | null
    peaks: LandscapeBasin[]
  }
  plateau: SearchPlateau
}

const GRID_METHOD =
  'Nadaraya-Watson regression of node scores with a Gaussian kernel, each node weighted by its units shared with the root; nodes with fewer than 2 shared units are left out; a cell whose weight sums to less than 1 unit is null'
const BASIN_METHOD =
  '0-dimensional persistence of the grid’s superlevel sets over 8-neighbour cells; a peak counts when it stands above the saddle to a higher peak by at least the threshold, the standard error sqrt(pooled variance / median shared units)'

/**
 * The landscape of a search: every node placed by `embed`, the interpolated
 * score over the placement, the basins of that surface, and the plateau
 * signal. Pure: it reads the state and calls `embed`.
 */
export function landscape(
  state: SearchStateView,
  embed: LandscapeEmbedding = lineageEdits(),
  options: LandscapeOptions = {},
): SearchLensResult<LandscapeData> {
  const landmarkCap = positiveInteger('landmarks', options.landmarks ?? 32)
  const columns = positiveInteger('grid', options.grid ?? 24)
  const window = options.window ?? 6
  const header = state.header
  const split = options.split ?? rankedSplit(state)
  const direction = header?.objective.direction ?? 'maximize'
  const plateauEmpty = (reason: string): SearchPlateau => ({
    value: null,
    window,
    accepted: 0,
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
  const placement = placeNodes(nodes, index, rootNodeId, embed, landmarkCap)

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
  const gridResult = interpolate(records, scored, columns)
  const noiseUnits = median(scored.map((record) => record.pairs))
  const pooled = posterior.pooledVariance
  let basins: LandscapeData['basins']
  if (gridResult.grid === null) {
    basins = {
      count: null,
      threshold: null,
      method: BASIN_METHOD,
      insufficient: gridResult.insufficient,
      peaks: [],
    }
  } else if (pooled === null || noiseUnits === null) {
    basins = {
      count: null,
      threshold: null,
      method: BASIN_METHOD,
      insufficient: 'no pooled between-unit variance, so the noise a peak must clear is unknown',
      peaks: [],
    }
  } else {
    const threshold = Math.sqrt(pooled / noiseUnits)
    const found = persistentPeaks(gridResult.grid, threshold)
    for (const record of records) {
      if (record.x === null || record.y === null) continue
      const cell = cellOf(gridResult.grid, record.x, record.y)
      record.basin = cell === null ? null : (found.labels[cell] ?? null)
    }
    const peaks = found.peaks.map((peak, basin) => {
      const members = records.filter((record) => record.basin === basin)
      let best: LandscapeBasin['best'] = null
      for (const member of members) {
        if (member.score === null || member.pairs < 2) continue
        if (best === null || member.score > best.score) {
          best = { nodeId: member.nodeId, score: member.score, pairs: member.pairs }
        }
      }
      return { ...peak, nodes: members.length, best }
    })
    basins = {
      count: peaks.length,
      threshold: round9(threshold),
      method: `${BASIN_METHOD}; pooled over ${posterior.degreesOfFreedom} degrees of freedom, median ${noiseUnits} shared units`,
      insufficient: null,
      peaks,
    }
  }

  const view = searchPolicyView(state, {
    screened: screenedNodes(state, { maxAttempts: options.maxAttempts }),
    screening: 0,
    expansions: 0,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  })
  const plateau = searchPlateau(
    split === view.split
      ? view
      : { ...view, unitScores: (nodeId: string) => state.unitScores(nodeId, split) },
    { window },
  )

  return result(state, {
    split,
    direction,
    embedding: {
      name: embed.name,
      method: embed.method,
      landmarks: placement.landmarks,
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

function result(state: SearchStateView, data: LandscapeData): SearchLensResult<LandscapeData> {
  const { plateau } = data
  const signal: SearchLensSignal = {
    name: 'plateau',
    value: plateau.value,
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
    basins: { count: null, threshold: null, method: BASIN_METHOD, insufficient: reason, peaks: [] },
    plateau,
  }
}

// ── Placement: landmark classical MDS ────────────────────────────────

interface Placement {
  coordinates: Array<[number, number] | undefined>
  unplaced: Map<number, string>
  landmarks: number
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
): Placement {
  const n = nodes.length
  const distancesFrom = distanceRows(nodes, index, embed)
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
    eigenvalues: values,
    explained:
      positiveMass > 0
        ? axes.reduce((sum, axis) => sum + (axis?.value ?? 0), 0) / positiveMass
        : null,
    negativeMass:
      positiveMass + negativeMass > 0 ? negativeMass / (positiveMass + negativeMass) : null,
  }
}

/** Distances from one node to every node, by the embedding's kind. */
function distanceRows(
  nodes: readonly SearchNode[],
  index: ReadonlyMap<string, number>,
  embed: LandscapeEmbedding,
): (from: number) => Array<number | null> {
  const n = nodes.length
  if (embed.kind === 'lineage') {
    const neighbours: number[][] = nodes.map(() => [])
    nodes.forEach((node, child) => {
      for (const parent of node.parents) {
        const at = index.get(parent.nodeId)
        if (at === undefined || at === child) continue
        neighbours[child]!.push(at)
        neighbours[at]!.push(child)
      }
    })
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

function interpolate(
  records: readonly LandscapeNode[],
  scored: readonly LandscapeNode[],
  columns: number,
): { grid: LandscapeGrid | null; insufficient: string | null } {
  if (scored.length < 3) {
    return {
      grid: null,
      insufficient: `${scored.length} placed node${scored.length === 1 ? '' : 's'} share 2 or more units with the root; a surface needs 3`,
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
  // Bandwidth: the median nearest-neighbour distance among scored
  // nodes (at most 2000, evenly spaced by registration), and never below one
  // grid cell, so a lone node still covers its own cell.
  const sample =
    scored.length <= 2000
      ? scored
      : Array.from({ length: 2000 }, (_, i) => scored[Math.floor((i * scored.length) / 2000)]!)
  const nearest = sample.map((a) => {
    let best = Number.POSITIVE_INFINITY
    for (const b of sample) {
      if (a === b) continue
      const d = Math.hypot(a.x! - b.x!, a.y! - b.y!)
      if (d > 0 && d < best) best = d
    }
    return best
  })
  const cell = Math.max(x1 - x0, y1 - y0) / columns
  const typical = median(nearest.filter(Number.isFinite)) ?? cell
  const bandwidth = Math.max(typical, cell)
  const rows = columns
  const values: (number | null)[][] = []
  let supported = 0
  for (let r = 0; r < rows; r++) {
    const row: (number | null)[] = []
    const y = y0 + ((r + 0.5) * (y1 - y0)) / rows
    for (let c = 0; c < columns; c++) {
      const x = x0 + ((c + 0.5) * (x1 - x0)) / columns
      let weight = 0
      let total = 0
      for (const node of scored) {
        const d2 = (node.x! - x) ** 2 + (node.y! - y) ** 2
        const w = node.pairs * Math.exp(-d2 / (2 * bandwidth * bandwidth))
        weight += w
        total += w * node.score!
      }
      if (weight >= 1) {
        row.push(round9(total / weight))
        supported += 1
      } else {
        row.push(null)
      }
    }
    values.push(row)
  }
  return {
    grid: {
      columns,
      rows,
      x: [round9(x0), round9(x1)],
      y: [round9(y0), round9(y1)],
      bandwidth: round9(bandwidth),
      values,
      supportedCells: supported,
      method: GRID_METHOD,
    },
    insufficient: null,
  }
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
 * Peaks of the grid by persistence. Cells enter from highest to lowest value;
 * a cell with no entered neighbour starts a component at its peak, and when
 * two components meet the one with the lower peak dies at that saddle. A
 * component counts as a basin when its peak stands at least `threshold` above
 * its saddle; the highest never dies. Each cell is labelled by the basin its
 * component resolves to: itself when it counts, else the one it merged into.
 */
function persistentPeaks(
  grid: LandscapeGrid,
  threshold: number,
): { peaks: Omit<LandscapeBasin, 'nodes' | 'best'>[]; labels: Array<number | undefined> } {
  const { columns, rows, values } = grid
  const cells: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) if (values[r]![c] !== null) cells.push(r * columns + c)
  }
  const heightOf = (cell: number) => values[Math.floor(cell / columns)]![cell % columns]!
  cells.sort((a, b) => heightOf(b) - heightOf(a) || a - b)
  const parent = new Map<number, number>()
  const find = (cell: number): number => {
    let root = cell
    while (parent.get(root) !== root) root = parent.get(root)!
    let at = cell
    while (parent.get(at) !== root) {
      const next = parent.get(at)!
      parent.set(at, root)
      at = next
    }
    return root
  }
  /** Per component (keyed by its peak cell): death saddle and merge target. */
  const death = new Map<number, { saddle: number; into: number }>()
  const joined = new Map<number, number>()
  for (const cell of cells) {
    parent.set(cell, cell)
    const r = Math.floor(cell / columns)
    const c = cell % columns
    const roots = new Set<number>()
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue
        const nr = r + dr
        const nc = c + dc
        if (nr < 0 || nr >= rows || nc < 0 || nc >= columns) continue
        const neighbour = nr * columns + nc
        if (parent.has(neighbour)) roots.add(find(neighbour))
      }
    }
    if (roots.size === 0) {
      joined.set(cell, cell)
      continue
    }
    // Peaks are the component keys: the highest (earliest) survives.
    const ordered = [...roots].sort((a, b) => heightOf(b) - heightOf(a) || a - b)
    const survivor = ordered[0]!
    for (const other of ordered.slice(1)) {
      death.set(other, { saddle: heightOf(cell), into: survivor })
      parent.set(other, survivor)
    }
    parent.set(cell, survivor)
    joined.set(cell, survivor)
  }
  const counts = (peak: number): boolean => {
    const died = death.get(peak)
    return died === undefined || heightOf(peak) - died.saddle >= threshold
  }
  const resolve = (peak: number): number => {
    let at = peak
    while (!counts(at)) at = death.get(at)!.into
    return at
  }
  const peakCells = [...new Set(joined.values())]
    .filter(counts)
    .sort((a, b) => heightOf(b) - heightOf(a) || a - b)
  const basinOf = new Map(peakCells.map((peak, basin) => [peak, basin]))
  const labels: Array<number | undefined> = new Array(rows * columns).fill(undefined)
  const sizes = new Array<number>(peakCells.length).fill(0)
  for (const [cell, component] of joined) {
    const basin = basinOf.get(resolve(component))!
    labels[cell] = basin
    sizes[basin]! += 1
  }
  const at = (cell: number) => ({
    x: round9(grid.x[0] + ((cell % columns) + 0.5) * ((grid.x[1] - grid.x[0]) / columns)),
    y: round9(grid.y[0] + (Math.floor(cell / columns) + 0.5) * ((grid.y[1] - grid.y[0]) / rows)),
  })
  return {
    peaks: peakCells.map((peak, basin) => {
      const died = death.get(peak)
      return {
        peak: { ...at(peak), value: heightOf(peak) },
        persistence: died === undefined ? null : round9(heightOf(peak) - died.saddle),
        cells: sizes[basin]!,
      }
    }),
    labels,
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`landscape: ${name} must be a positive integer, got ${String(value)}`)
  }
  return value
}

// ── Text ─────────────────────────────────────────────────────────────

const SHADES = ' .:-=+*#%@'

/** The landscape as text for a terminal or a proposer's context: the same
 * numbers the view draws, with a coarse shaded map. */
export function formatLandscape(lens: SearchLensResult<LandscapeData>): string {
  const { data } = lens
  const lines: string[] = []
  const { embedding } = data
  lines.push(
    `Landscape (${data.split} split, larger is better; ${embedding.name}: ${embedding.method})`,
  )
  lines.push(
    `  placed ${embedding.placed} of ${embedding.placed + embedding.unplaced} nodes by landmark MDS on ${embedding.landmarks} landmark${embedding.landmarks === 1 ? '' : 's'}; two axes hold ${percent(embedding.explained)} of the positive eigenvalue mass (negative mass ${percent(embedding.negativeMass)})`,
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
    lines.push(`  surface: insufficient (${data.gridInsufficient})`)
  } else {
    const { grid } = data
    lines.push(
      `  surface: ${grid.columns}×${grid.rows} grid, bandwidth ${fixed(grid.bandwidth)}, ${grid.supportedCells} of ${grid.columns * grid.rows} cells supported`,
    )
  }
  const { basins } = data
  if (basins.count === null) {
    lines.push(`  basins: insufficient (${basins.insufficient})`)
  } else {
    lines.push(
      `  basins: ${basins.count} (a peak counts at persistence ≥ ${fixed(basins.threshold!)}, one node's standard error)`,
    )
    basins.peaks.forEach((peak, basin) => {
      const persistence =
        peak.persistence === null
          ? 'the highest in its region'
          : `persistence ${fixed(peak.persistence)}`
      const best = peak.best
        ? `; best ${peak.best.nodeId} ${signed(peak.best.score)} on ${peak.best.pairs} units`
        : ''
      lines.push(
        `    ${basin + 1}. peak ${signed(peak.peak.value)} at (${fixed(peak.peak.x)}, ${fixed(peak.peak.y)}), ${persistence}; ${peak.nodes} node${peak.nodes === 1 ? '' : 's'}${best}`,
      )
    })
  }
  const { plateau } = data
  if (plateau.value === null) {
    lines.push(`  plateau: insufficient (${plateau.insufficient})`)
  } else {
    const verdict = plateau.value < 1 ? 'on a plateau' : 'still climbing'
    lines.push(
      `  plateau: ${fixed(plateau.value)} — the best improvement rose ${signed(plateau.rise!)} over the last ${plateau.window} screened nodes, noise ${fixed(plateau.noise!)} (best ${plateau.best!.nodeId} on ${plateau.best!.pairs} units, ${plateau.degreesOfFreedom} pooled df): ${verdict}`,
    )
  }
  if (data.grid !== null) {
    const { grid } = data
    const present = grid.values.flat().filter((value): value is number => value !== null)
    const low = Math.min(...present)
    const high = Math.max(...present)
    const marks = new Map<number, string>()
    for (const node of data.nodes) {
      if (node.x === null || node.y === null || node.basin === null) continue
      const peak = basins.peaks[node.basin]
      if (peak?.best?.nodeId === node.nodeId) {
        const cell = cellOf(grid, node.x, node.y)
        if (cell !== null) marks.set(cell, String((node.basin + 1) % 10))
      }
    }
    lines.push(
      `  map (top row is the highest y; shade ${JSON.stringify(SHADES)} runs from ${signed(low)} to ${signed(high)}; digits mark each basin's best node):`,
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
