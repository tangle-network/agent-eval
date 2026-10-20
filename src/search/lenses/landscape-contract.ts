/** Landscape embedding ports, observations, and numerical method policies. */
import type { SearchEstimateMethod, SearchNodeStatus } from '../../campaign/search-ledger-types'
import type { SearchNode } from '../../campaign/search-state'
import type { SearchPlateau } from './plateau'
import { INSUFFICIENT_FROM } from './shared'

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
    /** Log marginal likelihood of the same scores with no spatial
     * correlation; the surface is drawn only when `logLikelihood` beats it
     * by 1 or more. */
    independentLogLikelihood: number
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
  /** The persistence this peak needed: `z` standard errors of the difference
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
    /** Nodes with no higher neighbour: the peaks that could each survive. */
    localMaxima: number
    /** Standard errors a peak must clear its saddle by: the Bonferroni
     * normal quantile over `localMaxima − 1` tests at 5%. */
    z: number | null
    /** Nodes the graph holds (at most 2000 plus the 100 best). */
    graphNodes: number
    /** MDS axes the graph's distances use, and their share of the positive
     * eigenvalue mass: the neighbours are near in this space. */
    graphAxes: number
    graphExplained: number | null
    method: string
    insufficient: string | null
    peaks: LandscapeBasin[]
  }
  plateau: SearchPlateau
}

export const GRID_METHOD =
  "Gaussian-process regression (ordinary kriging) of node scores: a constant mean (generalized least squares), a squared-exponential covariance whose prior variance is the between-node variance of the scores minus their mean noise and whose length scale maximizes the marginal likelihood over 0.5, 1, 2 and 4 times the median nearest-neighbour distance, and each node's own noise variance (the pooled between-unit variance over its units shared with the root; the root is the reference at exactly 0); nodes with fewer than 2 shared units, and nodes decided invalid, are left out; a cell is null where the posterior variance exceeds half the prior variance, so the surface never extends past the nodes that support it; no surface is drawn unless the length scale raises the log-likelihood by 1 or more over independent node scores"
/** Scored nodes a surface or a basin count needs: the library's minimum
 * sample for anything descriptive, as for units. */
export const SURFACE_MIN_NODES = INSUFFICIENT_FROM
export const BASIN_METHOD =
  '0-dimensional persistence of node scores on the symmetric k-nearest-neighbour graph of placed nodes (not decided invalid, 2 or more units shared with the root), read on the leading MDS axes that hold 80% of the positive eigenvalue mass (2 to 8), joined into one component by the shortest edge between components (ToMATo, Chazal et al. 2013): nodes enter from the highest score down, and where two components meet, the lower peak merges into the higher unless it stands above that saddle node by z standard errors of their difference, sqrt(pooled variance / shared units) per node, where z is the standard-normal quantile at 1 − 0.05 / (local maxima − 1), a Bonferroni bound over every peak that could survive, so a flat landscape of noisy nodes counts one basin at least 95% of the time; at most 2000 nodes, evenly spaced by registration plus the 100 best'
/** Nodes the basin graph holds: evenly spaced by registration, plus the best. */
export const BASIN_NODES = 2000
export const BASIN_TOP = 100

export const BASIN_NEIGHBOURS = 6
/** The basin graph's space: leading MDS axes up to this share of the positive
 * eigenvalue mass, and at most this many. */
export const FULL_AXES_MASS = 0.8
export const FULL_AXES_MAX = 8
/** Family-wise rate of a spurious basin on a flat landscape. */
export const BASIN_ALPHA = 0.05
