/** Skill-manifold options, results and model descriptions. */

import type { SearchNodeStatus } from '../../campaign/search-ledger-types'

// ── Options and output ───────────────────────────────────────────────

export interface SkillManifoldOptions {
  /** The split scores come from. Default: the ranked split. */
  split?: 'selection' | 'train'
  /** Largest rank the cross-validation tries. Default 4. */
  maxRank?: number
  /** Cross-validation folds over observed cells. Default 5. */
  folds?: number
  /** Leaders the signal separates. Default 3, the claim's finalist cap. */
  leaders?: number
  /** Explicit leaders, for example an allocator's top of a rung. */
  candidates?: readonly string[]
  /** Read only cells settled at or before this ledger sequence, so a caller
   * can re-derive what the lens said at an earlier point of the ledger. */
  asOfSequence?: number
  /** Ridge penalty on standardized coordinates and loadings. Default 1: the
   * maximum a posteriori fit under standard-normal priors on both, since
   * standardized cells have unit variance. Weaker penalties overfit a search
   * of a few nodes (on a real 9-node ledger, 0.1 made the rank-1 held-out
   * error 3.5 times the rank-0 error). */
  ridge?: number
  /** Rows the factor fits and the cross-validation read, evenly spaced in
   * registration order; every row is then placed on the fitted loadings.
   * Default 1000. */
  sampleRows?: number
  /** Unit loadings from an earlier fit over the same units. When given, the
   * lens fits no loadings: it places this search's nodes on them. */
  calibration?: SkillCalibration
  /** `linear` factors standardized per-unit means; `logistic` fits the
   * two-parameter item-response model to pass counts and needs every cell to
   * score 0 or 1. Default `auto`: logistic when every cell scores 0 or 1. */
  model?: 'auto' | 'linear' | 'logistic'
  /** Also choose `count` units greedily from `among` (default: every
   * modelled unit), updating the leaders' posteriors after each pick, so a
   * batch does not repeat one direction. Returned as `data.batch`. */
  batch?: { count: number; among?: readonly string[] }
}

/** Unit loadings a later search can place its nodes on (`skillCalibration`). */
export interface SkillCalibration {
  /** Where the loadings were fitted, for example `searchId@sequence`. */
  source: string
  /** `identity`: the linear model on standardized means; `logit`: the
   * item-response model on pass counts. */
  link: SkillLink
  /** Standardization of the linear model: z = (score − center) / scale; 0
   * and 1 under the logit link. */
  center: number
  scale: number
  rank: number
  ridge: number
  /** Cross-validated squared error of one cell, on the standardized scale;
   * null under the logit link, whose noise is the binomial's. */
  noiseVariance: number | null
  /** Each unit's intercept on the model's scale and its loading. */
  units: Array<{ unitId: string; bias: number; loading: number[] }>
}

export type SkillLink = 'identity' | 'logit'

export interface SkillManifoldNode {
  nodeId: string
  ordinal: number
  status: SearchNodeStatus | null
  /** Units the node scored among the modelled ones. */
  observed: number
  /** Standardized coordinates along each axis; larger is better on axis
   * orientation (see `SkillManifoldData.axes`). */
  coordinates: number[]
  /** The model's mean over every modelled unit, in the metric's units. */
  predictedMean: number
  leader: boolean
}

export interface SkillManifoldUnit {
  unitId: string
  /** Nodes that scored the unit (0 for a calibrated unit this search has not run). */
  observedBy: number
  /** The unit's mean for a node at the origin, in the metric's units (a pass
   * rate under the logit link). */
  bias: number
  /** The same intercept on the model's own scale: standardized under the
   * identity link, log-odds under the logit link. */
  intercept: number
  /** The unit's direction in skill space (standardized, or log-odds per
   * unit of coordinate under the logit link). */
  loading: number[]
  /** Length of `loading`: how strongly the unit separates nodes. */
  strength: number
}

export interface SkillManifoldNextUnit {
  unitId: string
  /** Expected share of the leaders' contrast variance one more cell on this
   * unit, on every leader, removes; averaged over leader pairs. */
  share: number
  /** Leaders that already scored the unit. */
  measuredBy: number
}

export interface SkillManifoldData {
  split: 'selection' | 'train'
  direction: 'maximize' | 'minimize'
  /** `fitted`: loadings fitted on this search; `calibrated`: taken from `source`. */
  mode: 'fitted' | 'calibrated'
  source: string
  matrix: {
    rows: number
    units: number
    /** Observed cells of the modelled matrix (per-unit means). */
    observed: number
    density: number | null
    /** Nodes left out: fewer than 2 modelled units (1 with a calibration). */
    excludedNodes: number
    /** Units left out: scored by fewer than 2 nodes, or absent from the calibration. */
    excludedUnits: number
    fitRows: number
  }
  model: {
    method: string
    link: SkillLink
    rank: number
    ridge: number
    center: number | null
    scale: number | null
    iterations: number
    converged: boolean
  } | null
  /** In-sample R² over rank-0 (unit means only), by rank. */
  explained: {
    byRank: Array<{ rank: number; r2: number }>
    /** Share of the fitted structure each axis carries (its squared singular value). */
    axisShare: number[]
    method: string
  } | null
  intrinsicDimension: {
    value: number | null
    method: string
    /** Held-out cells per rank. */
    n: number
    folds: number
    curve: Array<{ rank: number; error: number; standardError: number }>
    insufficient: string | null
  }
  /** Axis orientation: a positive coordinate is better on the objective. */
  axes: string
  noiseVariance: number | null
  nodes: SkillManifoldNode[]
  units: SkillManifoldUnit[]
  leaders: Array<{ nodeId: string; predictedMean: number; observed: number }>
  nextUnits: SkillManifoldNextUnit[]
  /** The greedy batch `options.batch` asked for; null when not asked or
   * when no unit's information is known. */
  batch: string[] | null
  insufficient: string | null
}

export const METHODS: Record<
  SkillLink,
  { model: string; intrinsic: string; nextUnit: string; explained: string }
> = {
  identity: {
    model:
      'masked matrix factorization: each observed per-unit mean is b_u + P_i·Q_u on standardized scores, fitted by alternating ridge least squares over observed cells only; missing cells are masked, never filled',
    intrinsic:
      'k-fold cross-validation over observed cells (folds by a hash of node and unit), mean squared error of held-out cells by rank; the intrinsic dimension is the smallest rank within one standard error (across folds) of the best',
    nextUnit:
      'expected share of the variance of each leader pair’s contrast on the whole split that one more cell on the unit, run on both leaders, removes; each leader’s coordinates have the linear-Gaussian ridge posterior with loadings held fixed and noise equal to the cross-validated cell error; averaged over leader pairs',
    explained:
      'in-sample R² of each rank over the rank-0 model (unit means only), on the fitted rows; it always grows with rank, which is why the intrinsic dimension is cross-validated',
  },
  logit: {
    model:
      'multidimensional two-parameter item-response model: a node passes a unit with probability logistic(b_u + P_i·Q_u), its passes on the unit binomial over its cells; fitted by alternating Newton steps on the likelihood with standard-normal priors on P and Q (ridge) and a N(0, 10²) prior on b; missing cells are masked, never filled',
    intrinsic:
      'k-fold cross-validation over observed node-unit pass counts (folds by a hash of node and unit), binomial log loss per held-out cell by rank; the intrinsic dimension is the smallest rank within one standard error (across folds) of the best',
    nextUnit:
      'expected share of the variance of each leader pair’s contrast (predicted pass rate on the whole split) that one more cell on the unit, run on both leaders, removes; each leader’s coordinates have the Laplace posterior of the item-response model with loadings held fixed, and a cell’s information is its binomial variance at the leader’s predicted pass rate; averaged over leader pairs',
    explained:
      'in-sample McFadden pseudo-R² of each rank over the rank-0 model (unit easiness only), on the fitted rows; it always grows with rank, which is why the intrinsic dimension is cross-validated',
  },
}
