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
 * above their saddle by more than the noise, Bonferroni-bounded over the
 * graph's local maxima (0-dimensional persistence of the superlevel sets,
 * ToMATo).
 *
 * The signal is `plateau`: how far the best improvement over the root rose
 * across the last `window` screened nodes, in units of that node's standard
 * error. Below 1 the search is on a plateau; a policy that drafts afresh when
 * it is (`draftOnPlateau`) reads the same function on its own view.
 */

import { searchEstimateMethod, searchPosterior } from '../../campaign/estimate-node'
import { searchPolicyView } from '../../campaign/search-kernel'
import type { SearchStateView } from '../../campaign/search-state'
import {
  type GeometryLensResult,
  type GeometrySignal,
  headSequence,
  positiveInteger,
  round9,
  screenedNodes,
} from './geometry'
import { graphBasins } from './landscape-basins'
import type {
  LandscapeData,
  LandscapeEmbedding,
  LandscapeNode,
  LandscapeOptions,
} from './landscape-contract'
import { BASIN_METHOD } from './landscape-contract'
import { lineageEdits } from './landscape-embeddings'
import { lineageAdjacency, placeNodes } from './landscape-placement'
import { krige } from './landscape-surface'
import { PLATEAU_METHOD, type SearchPlateau, searchPlateau } from './plateau'
import { rankingSplit } from './shared'

export type {
  LandscapeBasin,
  LandscapeData,
  LandscapeEmbedding,
  LandscapeGrid,
  LandscapeNode,
  LandscapeOptions,
} from './landscape-contract'
export {
  lineageEdits,
  lineEditDistance,
  surfaceTextEdits,
  vectorEmbedding,
} from './landscape-embeddings'
export { formatLandscape } from './landscape-text'

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
      // One shared unit is no estimate (§6.4: unknown below 2 units); the
      // root is the reference, exactly 0.
      score:
        entry.mean === null || (entry.pairs < 2 && node.nodeId !== rootNodeId)
          ? null
          : round9(entry.mean),
      standardError: entry.variance === null ? null : round9(Math.sqrt(entry.variance)),
      pairs: entry.pairs,
      method: searchEstimateMethod(entry.pairs),
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

  // A node decided invalid keeps its place and score on the map, but its
  // score (a judge integrity or admission failure, possibly a reward hack)
  // shapes neither the surface nor a basin.
  const scored = records.filter(
    (record) =>
      record.x !== null &&
      record.score !== null &&
      record.pairs >= 2 &&
      record.status !== 'invalid',
  )
  const variances = new Map(posterior.nodes.map((entry) => [entry.nodeId, entry.variance]))
  const gridResult = krige(records, scored, variances, columns, surfaceNodes)
  const fullOf = new Map<string, number[]>()
  nodes.forEach((node, position) => {
    const point = placement.full[position]
    if (point) fullOf.set(node.nodeId, point)
  })
  const basins = graphBasins(
    records,
    scored,
    fullOf,
    { axes: placement.fullAxes, explained: placement.fullExplained },
    posterior.pooledVariance,
    posterior.degreesOfFreedom,
  )

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
    basins: {
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
    },
    plateau,
  }
}

// ── Placement: landmark classical MDS ────────────────────────────────
