/**
 * Per-node statistics of a search.
 *
 * `estimateNode` is the one paired contrast of two nodes: it averages each
 * node's cells inside their units, pairs the units both nodes scored, and runs
 * `pairedDeltaTest` on the per-unit deltas. `estimateNodeFromCells` is the same
 * computation over cells a caller already holds, such as rows a server read
 * from its database. The bootstrap seed comes from `cellSetDigest`, the digest
 * of exactly the cells used, so a producer and a verifier that hold the same
 * cells report the same bits.
 *
 * `searchPosterior` gives every node a normal posterior on its improvement over
 * the root, which expansion policies sample parents from. Its numbers steer
 * spend and claim nothing.
 */

import { compareCodeUnits, hashCanonical } from '../ledger-core/canonical'
import { minimumPairsForPairedDeltaTest, pairedDeltaTest } from '../paired-delta-test'
import { BOOTSTRAP_GATE_MIN_N, DECISION_PAIRED_DELTA_STATISTIC } from '../statistics'
import { SearchLedgerError } from './search-ledger-errors'
import type {
  NodeEstimate,
  SearchEstimateMethod,
  SearchLedgerHash,
  SearchSourceRef,
  SearchSplit,
} from './search-ledger-types'
import {
  type SearchScoredCell,
  type SearchStateView,
  type SearchUnitScore,
  searchUnitScores,
} from './search-state'

const CONFIDENCE = 0.95
const RESAMPLES = 2000
/** 6 at 95 %: the smallest sample an exact one-sided sign test can resolve. */
const DESCRIPTIVE_FROM = minimumPairsForPairedDeltaTest(CONFIDENCE)

/**
 * Every choice the numbers depend on. Its digest is the estimator's revision:
 * a producer and a verifier that report the same revision and the same
 * `cellSetDigest` report the same estimate. Change a value here whenever the
 * computation changes, so the revision moves with it.
 */
const ESTIMATOR_DEFINITION = {
  name: 'tangle.estimate-node.2026-09',
  unit: 'mean of the unit’s scored cells, summed in cellId order',
  pairing: 'units both nodes scored, in unitId order',
  statistic: DECISION_PAIRED_DELTA_STATISTIC,
  interval: 'percentile paired bootstrap',
  confidence: CONFIDENCE,
  resamples: RESAMPLES,
  rng: 'mulberry32',
  seed: 'the first 32 bits of cellSetDigest',
  signTest: 'exact, one-sided toward improvement in the objective direction',
  methods: {
    none: 'below 2 pairs',
    insufficient: `below ${DESCRIPTIVE_FROM} pairs`,
    descriptive: `below ${BOOTSTRAP_GATE_MIN_N} pairs`,
    bootstrap: `from ${BOOTSTRAP_GATE_MIN_N} pairs`,
  },
  indeterminate: 'every paired delta equal: no interval and no sign p',
} as const

/** The estimator every `NodeEstimate` names. */
export const SEARCH_ESTIMATOR: SearchSourceRef = {
  uri: 'npm:@tangle-network/agent-eval#estimateNode',
  revision: hashCanonical(ESTIMATOR_DEFINITION),
}

/** The method a paired sample of `pairs` units supports. */
export function searchEstimateMethod(pairs: number): SearchEstimateMethod {
  if (pairs < 2) return 'none'
  if (pairs < DESCRIPTIVE_FROM) return 'insufficient'
  if (pairs < BOOTSTRAP_GATE_MIN_N) return 'descriptive'
  return 'bootstrap'
}

export interface EstimateNodeCellsInput {
  nodeId: string
  against: string
  split: SearchSplit
  direction: 'maximize' | 'minimize'
  /** Every scored cell of `nodeId` on `split`. */
  nodeCells: readonly SearchScoredCell[]
  /** Every scored cell of `against` on `split`. */
  againstCells: readonly SearchScoredCell[]
}

/**
 * Digest of the cells an estimate reads, with the contrast they serve. Cells
 * are listed in cellId order, so the digest names the set, not the order it
 * was read in.
 */
export function searchCellSetDigest(
  input: Omit<EstimateNodeCellsInput, 'direction'>,
): SearchLedgerHash {
  const list = (cells: readonly SearchScoredCell[]) =>
    [...cells]
      .sort((left, right) => compareCodeUnits(left.cellId, right.cellId))
      .map((cell) => [cell.cellId, cell.unitId, cell.attempt, cell.score])
  return hashCanonical({
    contrast: [input.nodeId, input.against],
    split: input.split,
    nodeCells: list(input.nodeCells),
    againstCells: list(input.againstCells),
  })
}

/**
 * The paired contrast of `nodeId` against `against` on the units both scored.
 *
 * `delta` is the mean per-unit difference, node minus `against`, in the
 * metric's own units; for a `minimize` objective an improvement is negative.
 * The exact sign test is one-sided toward improvement in the objective's
 * direction. Unscored cells (errored, cancelled or in flight) are absent from
 * the inputs, never zero.
 *
 * - `none` (0 or 1 pair): no delta.
 * - `insufficient` (2 to 5): the delta only.
 * - `descriptive` (6 to 19): the bootstrap interval as spread, and the sign-test p.
 * - `bootstrap` (20 or more): the decision-grade bootstrap interval.
 *
 * When every paired delta is equal the interval would have zero width, which
 * is an absence of evidence; the estimate is then `indeterminate` and carries
 * neither an interval nor a p-value.
 */
export function estimateNodeFromCells(input: EstimateNodeCellsInput): NodeEstimate {
  const { nodeId, against, split, direction } = input
  if (nodeId === against) {
    throw new SearchLedgerError(`node ${nodeId} cannot be estimated against itself`)
  }
  assertDistinctCells([...input.nodeCells, ...input.againstCells], nodeId, against)
  const cellSetDigest = searchCellSetDigest(input)
  const nodeUnits = searchUnitScores(input.nodeCells)
  const { node, other } = pairUnits(nodeUnits, searchUnitScores(input.againstCells))
  const pairs = node.length
  const method = searchEstimateMethod(pairs)
  const base = {
    against,
    split,
    units: nodeUnits.length,
    pairs,
    method,
    cellSetDigest,
    estimator: SEARCH_ESTIMATOR,
  }
  if (method === 'none') {
    return { ...base, delta: null, interval: null, exactSignP: null, indeterminate: false }
  }
  // The test's `after - before` is the improvement: node minus against when
  // larger is better, against minus node when smaller is.
  const maximize = direction === 'maximize'
  const test = pairedDeltaTest(maximize ? other : node, maximize ? node : other, {
    statistic: DECISION_PAIRED_DELTA_STATISTIC,
    confidence: CONFIDENCE,
    resamples: RESAMPLES,
    seed: seedFromDigest(cellSetDigest),
  })
  const { mean, low, high } = test.bootstrap
  const indeterminate = test.indeterminate
  const spread = (method === 'descriptive' || method === 'bootstrap') && !indeterminate
  return {
    ...base,
    delta: plain(maximize ? mean : -mean),
    interval: spread ? (maximize ? [plain(low), plain(high)] : [plain(-high), plain(-low)]) : null,
    exactSignP: method === 'descriptive' && !indeterminate ? test.pValue : null,
    indeterminate,
  }
}

/**
 * `estimateNodeFromCells` over the cells a search state holds: `nodeId`
 * against `against` on one split, in the direction the search's objective
 * declares.
 */
export function estimateNode(
  state: SearchStateView,
  nodeId: string,
  options: { against: string; split: SearchSplit },
): NodeEstimate {
  const header = state.header
  if (!header) throw new SearchLedgerError(`search ${state.searchId} has not been opened`)
  for (const id of [nodeId, options.against]) {
    if (!state.hasNode(id)) {
      throw new SearchLedgerError(`node ${id} is not in search ${state.searchId}`)
    }
  }
  return estimateNodeFromCells({
    nodeId,
    against: options.against,
    split: options.split,
    direction: header.objective.direction,
    nodeCells: state.scoredCells(nodeId, options.split),
    againstCells: state.scoredCells(options.against, options.split),
  })
}

/** A node's normal posterior on its improvement over the root. */
export interface NodePosterior {
  nodeId: string
  /** Units the node and the root both scored. */
  pairs: number
  /** Mean per-unit improvement over the root in the objective's direction,
   * so larger is better for either direction. Null without a shared unit. */
  mean: number | null
  /** The pooled variance divided by `pairs`. Null when either is unknown. */
  variance: number | null
}

export interface SearchPosterior {
  split: SearchSplit
  rootNodeId: string
  /**
   * Between-unit variance of the per-unit improvements over the root, pooled
   * across every non-root node with at least 2 shared units. Null until some
   * node has 2.
   */
  pooledVariance: number | null
  /** Sum over the pooled nodes of their shared units minus one. */
  degreesOfFreedom: number
  /** Every node in registration order; the root first, at exactly 0. */
  nodes: NodePosterior[]
}

/**
 * The posterior every node's parent-selection draw uses. Each node's mean is
 * its improvement over the root on shared units; its variance is the search's
 * pooled between-unit variance divided by its unit count, so a node measured
 * on one unit has a wide posterior rather than none. The root is the reference
 * and sits at exactly 0.
 */
export function searchPosterior(
  state: SearchStateView,
  options: { split?: SearchSplit } = {},
): SearchPosterior {
  const split = options.split ?? 'selection'
  const header = state.header
  if (!header) throw new SearchLedgerError(`search ${state.searchId} has not been opened`)
  const rootNodeId = state.rootNodeId
  if (rootNodeId === null) {
    throw new SearchLedgerError(`search ${state.searchId} has no root node yet`)
  }
  const sign = header.objective.direction === 'maximize' ? 1 : -1
  const root = searchUnitScores(state.scoredCells(rootNodeId, split))
  const nodes: NodePosterior[] = []
  let squares = 0
  let degreesOfFreedom = 0
  for (const nodeId of state.nodeIds()) {
    if (nodeId === rootNodeId) {
      const measured = root.length > 0
      nodes.push({
        nodeId,
        pairs: root.length,
        mean: measured ? 0 : null,
        variance: measured ? 0 : null,
      })
      continue
    }
    const { node, other } = pairUnits(searchUnitScores(state.scoredCells(nodeId, split)), root)
    const gains = node.map((value, index) => sign * (value - other[index]!))
    const mean = gains.length > 0 ? sum(gains) / gains.length : null
    if (mean !== null && gains.length >= 2) {
      squares += sum(gains.map((gain) => (gain - mean) ** 2))
      degreesOfFreedom += gains.length - 1
    }
    nodes.push({
      nodeId,
      pairs: gains.length,
      mean: mean === null ? null : plain(mean),
      variance: null,
    })
  }
  const pooledVariance = degreesOfFreedom > 0 ? squares / degreesOfFreedom : null
  if (pooledVariance !== null) {
    for (const posterior of nodes) {
      if (posterior.nodeId !== rootNodeId && posterior.pairs > 0) {
        posterior.variance = pooledVariance / posterior.pairs
      }
    }
  }
  return { split, rootNodeId, pooledVariance, degreesOfFreedom, nodes }
}

/** Unit means of two nodes on the units both scored, aligned in unitId order. */
function pairUnits(
  node: readonly SearchUnitScore[],
  other: readonly SearchUnitScore[],
): { node: number[]; other: number[] } {
  const otherMeans = new Map(other.map((unit) => [unit.unitId, unit.mean]))
  const paired = { node: [] as number[], other: [] as number[] }
  for (const unit of node) {
    const mean = otherMeans.get(unit.unitId)
    if (mean === undefined) continue
    paired.node.push(unit.mean)
    paired.other.push(mean)
  }
  return paired
}

function assertDistinctCells(
  cells: readonly SearchScoredCell[],
  nodeId: string,
  against: string,
): void {
  const seen = new Set<string>()
  for (const cell of cells) {
    if (seen.has(cell.cellId)) {
      throw new SearchLedgerError(
        `cell ${cell.cellId} appears twice in the estimate of ${nodeId} against ${against}`,
      )
    }
    if (!Number.isFinite(cell.score)) {
      throw new SearchLedgerError(`cell ${cell.cellId} has a non-finite score ${cell.score}`)
    }
    seen.add(cell.cellId)
  }
}

/** The first 32 bits of a `sha256:` digest, as the bootstrap's seed. */
function seedFromDigest(digest: SearchLedgerHash): number {
  return Number.parseInt(digest.slice('sha256:'.length, 'sha256:'.length + 8), 16) | 0
}

function sum(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total
}

/** Canonical JSON has one zero; never hand it a negative one. */
function plain(value: number): number {
  return value === 0 ? 0 : value
}
