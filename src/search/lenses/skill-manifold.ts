/**
 * The skill-manifold lens: the node × unit score matrix as candidates in a
 * low-dimensional skill space and units as directions in it.
 *
 * Each observed per-unit mean is modelled as `b_u + P_i · Q_u`: a unit's
 * difficulty `b_u`, the node's coordinates `P_i` and the unit's loading `Q_u`,
 * fitted by alternating ridge least squares over the observed cells only
 * (missing cells are masked, never filled). Scores are standardized first,
 * so coordinates and loadings are unitless. The rank that generalizes is
 * chosen by cross-validation over held-out cells with the one-standard-error
 * rule (Hastie, Tibshirani and Friedman, Elements of Statistical Learning,
 * §7.10): the intrinsic dimension. Rank 0 means the nodes do not differ
 * beyond noise; rank 1 is one ability axis; more axes mean specialists.
 *
 * The signal is `nextUnit`: the unit whose next cell, run on every leader,
 * removes the largest expected share of the variance of the leaders'
 * contrasts on the whole split (the linear-Gaussian posterior of each
 * leader's coordinates, with unit loadings held fixed). An allocator that
 * extends a rung by this unit needs fewer cells per decision when leaders
 * differ along a skill axis only some units test. Inside one search, a unit
 * only the root has run has no loading, so the lens can also take the
 * loadings of an earlier fit (`calibration`) over the same units: calibrate
 * once, then test adaptively.
 */

import type { SearchNodeStatus } from '../../campaign/search-ledger-types'
import {
  type SearchScoredCell,
  type SearchStateView,
  searchUnitScores,
} from '../../campaign/search-state'
import { compareCodeUnits } from '../../ledger-core/canonical'
import { cholesky, choleskyInverse, choleskySolve } from '../../math/cholesky'
import { symmetricEigen } from '../../math/symmetric-eigen'
import { mulberry32 } from '../../statistics/random'
import {
  DESCRIPTIVE_FROM_UNITS,
  evenSample,
  type GeometryLensResult,
  type GeometrySignal,
  headSequence,
  plural,
  positiveInteger,
  rankedSplit,
  round9,
} from './geometry'

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
}

/** Unit loadings a later search can place its nodes on (`skillCalibration`). */
export interface SkillCalibration {
  /** Where the loadings were fitted, for example `searchId@sequence`. */
  source: string
  /** Standardization: z = (score − center) / scale. */
  center: number
  scale: number
  rank: number
  ridge: number
  /** Cross-validated squared error of one cell, on the standardized scale. */
  noiseVariance: number
  units: Array<{ unitId: string; bias: number; loading: number[] }>
}

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
  /** The unit's mean for a node at the origin, in the metric's units. */
  bias: number
  /** The unit's direction in skill space (standardized). */
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
  insufficient: string | null
}

const MODEL_METHOD =
  'masked matrix factorization: each observed per-unit mean is b_u + P_i·Q_u on standardized scores, fitted by alternating ridge least squares over observed cells only; missing cells are masked, never filled'
const INTRINSIC_METHOD =
  'k-fold cross-validation over observed cells (folds by a hash of node and unit), mean squared error of held-out cells by rank; the intrinsic dimension is the smallest rank within one standard error (across folds) of the best'
const NEXT_UNIT_METHOD =
  'expected share of the variance of each leader pair’s contrast on the whole split that one more cell on the unit, run on both leaders, removes; each leader’s coordinates have the linear-Gaussian ridge posterior with loadings held fixed and noise equal to the cross-validated cell error; averaged over leader pairs'
const EXPLAINED_METHOD =
  'in-sample R² of each rank over the rank-0 model (unit means only), on the fitted rows; it always grows with rank, which is why the intrinsic dimension is cross-validated'

const MAX_ITERATIONS = 300
const TOLERANCE = 1e-9

// ── The lens ─────────────────────────────────────────────────────────

/**
 * The skill manifold of a search at rank `k` (`auto`: the intrinsic
 * dimension, at least 1). Pure: it reads the state, and `calibration` when
 * given.
 */
export function skillManifold(
  state: SearchStateView,
  k: number | 'auto' = 'auto',
  options: SkillManifoldOptions = {},
): GeometryLensResult<SkillManifoldData> {
  const maxRank = positiveInteger('skillManifold', 'maxRank', options.maxRank ?? 4)
  const folds = positiveInteger('skillManifold', 'folds', options.folds ?? 5)
  if (folds < 2) throw new TypeError(`skillManifold: folds must be at least 2, got ${folds}`)
  const leaderCount = positiveInteger('skillManifold', 'leaders', options.leaders ?? 3)
  const ridge = options.ridge ?? 1
  if (!(ridge > 0) || !Number.isFinite(ridge)) {
    throw new TypeError(`skillManifold: ridge must be a positive number, got ${String(ridge)}`)
  }
  const sampleRows = positiveInteger('skillManifold', 'sampleRows', options.sampleRows ?? 1000)
  if (k !== 'auto') positiveInteger('skillManifold', 'k', k)

  const header = state.header
  const split = options.split ?? rankedSplit(state)
  const direction = header?.objective.direction ?? 'maximize'
  const sign = direction === 'maximize' ? 1 : -1
  const calibration = options.calibration ?? null
  const source = calibration?.source ?? `${state.searchId}@${headSequence(state)}`
  const empty = (reason: string, matrix?: SkillManifoldData['matrix']) =>
    result(state, {
      split,
      direction,
      mode: calibration ? 'calibrated' : 'fitted',
      source,
      matrix: matrix ?? {
        rows: 0,
        units: 0,
        observed: 0,
        density: null,
        excludedNodes: 0,
        excludedUnits: 0,
        fitRows: 0,
      },
      model: null,
      explained: null,
      intrinsicDimension: {
        value: null,
        method: INTRINSIC_METHOD,
        n: 0,
        folds,
        curve: [],
        insufficient: reason,
      },
      axes: axesNote(direction),
      noiseVariance: null,
      nodes: [],
      units: [],
      leaders: [],
      nextUnits: [],
      insufficient: reason,
    })
  if (!header || state.rootNodeId === null) {
    return empty(header ? 'the search has no root node yet' : 'the search has not been opened')
  }

  const matrix = scoreMatrix(state, split, options.asOfSequence, calibration)
  const shape: SkillManifoldData['matrix'] = {
    rows: matrix.rows.length,
    units: matrix.unitIds.length,
    observed: matrix.observed,
    density:
      matrix.rows.length * matrix.unitIds.length > 0
        ? round9(matrix.observed / (matrix.rows.length * matrix.unitIds.length))
        : null,
    excludedNodes: matrix.excludedNodes,
    excludedUnits: matrix.excludedUnits,
    fitRows: 0,
  }

  let center: number
  let scale: number
  let fit: Fit
  let rank: number
  let noiseVariance: number | null
  let intrinsic: SkillManifoldData['intrinsicDimension']
  let explained: SkillManifoldData['explained'] = null
  let iterations = 0
  let converged = true

  if (calibration) {
    if (matrix.rows.length === 0 || matrix.unitIds.length === 0) {
      return empty('no node scored a calibrated unit', shape)
    }
    center = calibration.center
    scale = calibration.scale
    rank = calibration.rank
    const byUnit = new Map(calibration.units.map((unit) => [unit.unitId, unit]))
    fit = {
      rank,
      bias: matrix.unitIds.map((unitId) => byUnit.get(unitId)!.bias),
      loadings: matrix.unitIds.map((unitId) => [...byUnit.get(unitId)!.loading]),
      byRow: new Map(),
      coordinates: [],
      iterations: 0,
      converged: true,
    }
    placeRows(matrix, fit, center, scale, calibration.ridge)
    noiseVariance = calibration.noiseVariance
    intrinsic = {
      value: null,
      method: INTRINSIC_METHOD,
      n: 0,
      folds,
      curve: [],
      insufficient: `loadings come from ${calibration.source}; its fit decided the rank (${rank})`,
    }
  } else {
    if (matrix.rows.length < 3 || matrix.unitIds.length < DESCRIPTIVE_FROM_UNITS) {
      return empty(
        `${plural(matrix.rows.length, 'node')} and ${plural(matrix.unitIds.length, 'unit')} qualify (a unit counts when 2 or more nodes scored it, a node when it scored 2 or more such units); a manifold needs 3 nodes and ${DESCRIPTIVE_FROM_UNITS} units`,
        shape,
      )
    }
    const standard = standardization(matrix)
    if (standard === null) {
      return empty(
        'every node scores the same on every unit, so there is no variation to factor',
        shape,
      )
    }
    ;({ center, scale } = standard)
    const fitRows = evenSample(
      matrix.rows.map((_, index) => index),
      sampleRows,
    )
    shape.fitRows = fitRows.length
    const cells = observedCells(matrix, fitRows, center, scale)
    const rankCap = Math.min(maxRank, matrix.unitIds.length - 1, fitRows.length - 1)
    intrinsic = crossValidate(matrix, cells, rankCap, folds, ridge)
    rank =
      k === 'auto'
        ? Math.max(1, intrinsic.value ?? Math.min(2, rankCap))
        : Math.min(k, Math.max(1, rankCap))
    const fits: Fit[] = []
    for (let r = 0; r <= Math.max(rank, rankCap); r++) {
      fits.push(factor(matrix.unitIds.length, cells, r, ridge))
    }
    const base = sse(fits[0]!, cells)
    explained = {
      byRank: fits.slice(1).map((entry) => ({
        rank: entry.rank,
        r2: round9(base > 0 ? 1 - sse(entry, cells) / base : 0),
      })),
      axisShare: [],
      method: EXPLAINED_METHOD,
    }
    fit = fits[rank]!
    iterations = fit.iterations
    converged = fit.converged
    const cv = intrinsic.curve.find((point) => point.rank === rank)
    noiseVariance = cv && Number.isFinite(cv.error) ? cv.error : null
    const shares = principalAxes(fit, fitRows)
    explained.axisShare = shares.map(round9)
    fit.coordinates = []
    placeRows(matrix, fit, center, scale, ridge)
  }
  orientAxes(fit, sign)

  const unitCount = matrix.unitIds.length
  const meanLoading = new Array<number>(rank).fill(0)
  for (const loading of fit.loadings) {
    for (let d = 0; d < rank; d++) meanLoading[d]! += loading[d]! / unitCount
  }
  const meanBias = fit.bias.reduce((sum, value) => sum + value, 0) / unitCount
  const predicted = (coordinates: readonly number[]) =>
    center + scale * (meanBias + dot(coordinates, meanLoading))

  const leaderFloor = Math.min(DESCRIPTIVE_FROM_UNITS, unitCount)
  let leaderRows: number[]
  if (options.candidates) {
    const wanted = new Set(options.candidates)
    leaderRows = matrix.rows.flatMap((row, index) => (wanted.has(row.nodeId) ? [index] : []))
  } else {
    const eligible = matrix.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.observed.size >= leaderFloor)
    leaderRows = eligible
      .sort(
        (left, right) =>
          sign *
            (predicted(fit.coordinates[right.index]!) - predicted(fit.coordinates[left.index]!)) ||
          left.row.ordinal - right.row.ordinal,
      )
      .slice(0, leaderCount)
      .map(({ index }) => index)
  }
  const leaderSet = new Set(leaderRows)

  const next =
    intrinsic.value === 0
      ? {
          ranked: [],
          insufficient:
            'held-out cells fit no better with any skill axis than with unit means alone (intrinsic dimension 0): the nodes do not differ beyond noise, so no unit separates them',
        }
      : nextUnits(matrix, fit, leaderRows, noiseVariance, calibration?.ridge ?? ridge)
  const nodes: SkillManifoldNode[] = matrix.rows.map((row, index) => ({
    nodeId: row.nodeId,
    ordinal: row.ordinal,
    status: row.status,
    observed: row.observed.size,
    coordinates: fit.coordinates[index]!.map(round9),
    predictedMean: round9(predicted(fit.coordinates[index]!)),
    leader: leaderSet.has(index),
  }))
  const units: SkillManifoldUnit[] = matrix.unitIds.map((unitId, u) => ({
    unitId,
    observedBy: matrix.observedBy[u]!,
    bias: round9(center + scale * fit.bias[u]!),
    loading: fit.loadings[u]!.map(round9),
    strength: round9(Math.hypot(...fit.loadings[u]!)),
  }))

  return result(state, {
    split,
    direction,
    mode: calibration ? 'calibrated' : 'fitted',
    source,
    matrix: shape,
    model: {
      method: MODEL_METHOD,
      rank,
      ridge: calibration?.ridge ?? ridge,
      center: round9(center),
      scale: round9(scale),
      iterations,
      converged,
    },
    explained,
    intrinsicDimension: intrinsic,
    axes: axesNote(direction),
    noiseVariance: noiseVariance === null ? null : round9(noiseVariance),
    nodes,
    units,
    leaders: leaderRows.map((index) => ({
      nodeId: matrix.rows[index]!.nodeId,
      predictedMean: round9(predicted(fit.coordinates[index]!)),
      observed: matrix.rows[index]!.observed.size,
    })),
    nextUnits: next.ranked,
    insufficient: next.insufficient,
  })
}

/** The loadings of a fitted manifold, for a later search over the same units
 * to place its nodes on. Null when the lens fitted nothing. */
export function skillCalibration(
  lens: GeometryLensResult<SkillManifoldData>,
): SkillCalibration | null {
  const { data } = lens
  const { model } = data
  if (
    data.mode !== 'fitted' ||
    model === null ||
    model.center === null ||
    model.scale === null ||
    data.noiseVariance === null
  ) {
    return null
  }
  const { center, scale } = model
  return {
    source: data.source,
    center,
    scale,
    rank: model.rank,
    ridge: model.ridge,
    noiseVariance: data.noiseVariance,
    units: data.units.map((unit) => ({
      unitId: unit.unitId,
      bias: (unit.bias - center) / scale,
      loading: [...unit.loading],
    })),
  }
}

function result(
  state: SearchStateView,
  data: SkillManifoldData,
): GeometryLensResult<SkillManifoldData> {
  const pending = data.nextUnits.filter((unit) => unit.measuredBy < data.leaders.length)
  const best = pending[0] ?? data.nextUnits[0] ?? null
  const signal: GeometrySignal = {
    name: 'nextUnit',
    value: best === null ? null : best.share,
    subject: best?.unitId ?? null,
    method: NEXT_UNIT_METHOD,
    n: data.leaders.reduce((sum, leader) => sum + leader.observed, 0),
    insufficient: best === null ? (data.insufficient ?? 'no unit to rank') : null,
  }
  return {
    lens: 'skillManifold',
    searchId: state.searchId,
    sequence: headSequence(state),
    data,
    signal,
  }
}

function axesNote(direction: 'maximize' | 'minimize'): string {
  return direction === 'maximize'
    ? 'axes are principal (largest share first) and oriented so the mean unit loads positively: a larger coordinate predicts a higher score'
    : 'axes are principal (largest share first) and oriented so the mean unit loads negatively: a larger coordinate predicts a lower (better) score'
}

// ── The matrix ───────────────────────────────────────────────────────

interface Row {
  nodeId: string
  ordinal: number
  status: SearchNodeStatus | null
  /** Modelled unit index → per-unit mean. */
  observed: Map<number, number>
}

interface ScoreMatrix {
  rows: Row[]
  unitIds: string[]
  observedBy: number[]
  observed: number
  excludedNodes: number
  excludedUnits: number
}

/**
 * Per-unit means of every node on `split`. Without a calibration, a unit is
 * modelled when 2 or more nodes scored it and a node when it scored 2 or more
 * modelled units, repeated until both hold. With one, the modelled units are
 * the calibration's, and a node needs one of them.
 */
function scoreMatrix(
  state: SearchStateView,
  split: 'selection' | 'train',
  asOf: number | undefined,
  calibration: SkillCalibration | null,
): ScoreMatrix {
  const raw: Array<{
    nodeId: string
    ordinal: number
    status: SearchNodeStatus | null
    units: Map<string, number>
  }> = []
  const allUnits = new Set<string>()
  for (const node of state.nodes()) {
    const scores =
      asOf === undefined
        ? state.unitScores(node.nodeId, split)
        : searchUnitScores(scoredAsOf(state, node.nodeId, split, asOf))
    const units = new Map(scores.map((unit) => [unit.unitId, unit.mean]))
    for (const unitId of units.keys()) allUnits.add(unitId)
    raw.push({ nodeId: node.nodeId, ordinal: node.ordinal, status: node.status, units })
  }
  let unitIds: string[]
  let keep: typeof raw
  if (calibration) {
    const calibrated = new Set(calibration.units.map((unit) => unit.unitId))
    unitIds = calibration.units.map((unit) => unit.unitId)
    keep = raw.filter((row) => [...row.units.keys()].some((unitId) => calibrated.has(unitId)))
  } else {
    let units = new Set(allUnits)
    keep = raw
    for (;;) {
      const counts = new Map<string, number>()
      for (const row of keep) {
        for (const unitId of row.units.keys()) {
          if (units.has(unitId)) counts.set(unitId, (counts.get(unitId) ?? 0) + 1)
        }
      }
      const nextUnits = new Set([...units].filter((unitId) => (counts.get(unitId) ?? 0) >= 2))
      const nextKeep = keep.filter(
        (row) => [...row.units.keys()].filter((unitId) => nextUnits.has(unitId)).length >= 2,
      )
      const stable = nextUnits.size === units.size && nextKeep.length === keep.length
      units = nextUnits
      keep = nextKeep
      if (stable) break
    }
    unitIds = [...units].sort(compareCodeUnits)
  }
  const unitIndex = new Map(unitIds.map((unitId, index) => [unitId, index]))
  const observedBy = new Array<number>(unitIds.length).fill(0)
  let observed = 0
  const rows = keep.map((row) => {
    const map = new Map<number, number>()
    for (const [unitId, mean] of row.units) {
      const index = unitIndex.get(unitId)
      if (index === undefined) continue
      map.set(index, mean)
      observedBy[index]! += 1
      observed += 1
    }
    return { nodeId: row.nodeId, ordinal: row.ordinal, status: row.status, observed: map }
  })
  return {
    rows,
    unitIds,
    observedBy,
    observed,
    excludedNodes: raw.length - rows.length,
    excludedUnits: calibration
      ? [...allUnits].filter((unitId) => !unitIndex.has(unitId)).length
      : allUnits.size - unitIds.length,
  }
}

/** A node's scored cells on `split` whose score the ledger held at `asOf`:
 * a cell's last update is its scoring settle, so a later retry is excluded. */
function scoredAsOf(
  state: SearchStateView,
  nodeId: string,
  split: 'selection' | 'train',
  asOf: number,
): SearchScoredCell[] {
  const cells: SearchScoredCell[] = []
  for (const cell of state.cells({ nodeId })) {
    if (cell.split !== split || cell.score === null || cell.updatedSequence > asOf) continue
    cells.push({
      cellId: cell.cellId,
      unitId: cell.unitId,
      attempt: cell.attempts,
      score: cell.score,
    })
  }
  return cells
}

function standardization(matrix: ScoreMatrix): { center: number; scale: number } | null {
  let total = 0
  const columnSum = new Array<number>(matrix.unitIds.length).fill(0)
  for (const row of matrix.rows) {
    for (const [u, value] of row.observed) {
      total += value
      columnSum[u]! += value
    }
  }
  const center = total / matrix.observed
  let squares = 0
  for (const row of matrix.rows) {
    for (const [u, value] of row.observed) {
      squares += (value - columnSum[u]! / matrix.observedBy[u]!) ** 2
    }
  }
  const scale = Math.sqrt(squares / matrix.observed)
  return scale > 1e-12 ? { center, scale } : null
}

interface Cell {
  row: number
  unit: number
  z: number
  fold: number
}

function observedCells(
  matrix: ScoreMatrix,
  rows: readonly number[],
  center: number,
  scale: number,
): Cell[] {
  const cells: Cell[] = []
  for (const row of rows) {
    const { nodeId, observed } = matrix.rows[row]!
    for (const [unit, value] of [...observed].sort(([left], [right]) => left - right)) {
      cells.push({
        row,
        unit,
        z: (value - center) / scale,
        fold: fnv1a(`${nodeId}\u0000${matrix.unitIds[unit]!}`),
      })
    }
  }
  return cells
}

/** 32-bit FNV-1a: a deterministic fold assignment that depends on the cell's
 * coordinates alone, not on the order cells were read. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ── The factorization ────────────────────────────────────────────────

interface Fit {
  rank: number
  /** Per modelled unit, standardized. */
  bias: number[]
  loadings: number[][]
  /** Coordinates of the rows the fit read, by matrix row index. */
  byRow: Map<number, number[]>
  /** Coordinates of every matrix row, once `placeRows` ran. */
  coordinates: number[][]
  iterations: number
  converged: boolean
}

/**
 * Alternating ridge least squares over `cells`: rows' coordinates given the
 * loadings, then each unit's loading and (unpenalized) bias given the
 * coordinates, until the objective moves by less than 1e-9 of itself.
 * Loadings start from a fixed seeded draw, so a fit is deterministic.
 */
function factor(units: number, cells: readonly Cell[], rank: number, ridge: number): Fit {
  const byUnit: Cell[][] = Array.from({ length: units }, () => [])
  const rowIds = new Map<number, Cell[]>()
  for (const cell of cells) {
    byUnit[cell.unit]!.push(cell)
    const list = rowIds.get(cell.row)
    if (list) list.push(cell)
    else rowIds.set(cell.row, [cell])
  }
  const bias = byUnit.map((list) =>
    list.length === 0 ? 0 : list.reduce((sum, cell) => sum + cell.z, 0) / list.length,
  )
  const random = mulberry32(0x5eed + rank)
  const loadings = Array.from({ length: units }, () =>
    Array.from({ length: rank }, () => (random() - 0.5) * 0.2),
  )
  const coordinates = new Map<number, number[]>()
  for (const row of rowIds.keys()) coordinates.set(row, new Array<number>(rank).fill(0))
  if (rank === 0) {
    return {
      rank,
      bias,
      loadings,
      byRow: coordinates,
      coordinates: [],
      iterations: 0,
      converged: true,
    }
  }
  let previous = Number.POSITIVE_INFINITY
  let iterations = 0
  let converged = false
  for (; iterations < MAX_ITERATIONS; iterations++) {
    for (const [row, list] of rowIds) {
      coordinates.set(row, solveRow(list, loadings, bias, rank, ridge))
    }
    for (let u = 0; u < units; u++) {
      const list = byUnit[u]!
      if (list.length === 0) continue
      const size = rank + 1
      const system = Array.from({ length: size }, (_, i) =>
        Array.from({ length: size }, (_, j) => (i === j && i < rank ? ridge : 0)),
      )
      const rhs = new Array<number>(size).fill(0)
      for (const cell of list) {
        const x = [...coordinates.get(cell.row)!, 1]
        for (let i = 0; i < size; i++) {
          rhs[i]! += x[i]! * cell.z
          for (let j = 0; j < size; j++) system[i]![j]! += x[i]! * x[j]!
        }
      }
      const lower = cholesky(system)
      if (lower === null) continue
      const solution = choleskySolve(lower, rhs)
      loadings[u] = solution.slice(0, rank)
      bias[u] = solution[rank]!
    }
    let objective = 0
    for (const cell of cells) {
      objective +=
        (cell.z - bias[cell.unit]! - dot(coordinates.get(cell.row)!, loadings[cell.unit]!)) ** 2
    }
    for (const point of coordinates.values()) objective += ridge * dot(point, point)
    for (const loading of loadings) objective += ridge * dot(loading, loading)
    if (Math.abs(previous - objective) <= TOLERANCE * Math.max(objective, 1e-12)) {
      converged = true
      iterations += 1
      break
    }
    previous = objective
  }
  return { rank, bias, loadings, byRow: coordinates, coordinates: [], iterations, converged }
}

function solveRow(
  list: readonly Pick<Cell, 'unit' | 'z'>[],
  loadings: readonly (readonly number[])[],
  bias: readonly number[],
  rank: number,
  ridge: number,
): number[] {
  const system = Array.from({ length: rank }, (_, i) =>
    Array.from({ length: rank }, (_, j) => (i === j ? ridge : 0)),
  )
  const rhs = new Array<number>(rank).fill(0)
  for (const cell of list) {
    const q = loadings[cell.unit]!
    const residual = cell.z - bias[cell.unit]!
    for (let i = 0; i < rank; i++) {
      rhs[i]! += q[i]! * residual
      for (let j = 0; j < rank; j++) system[i]![j]! += q[i]! * q[j]!
    }
  }
  return choleskySolve(cholesky(system)!, rhs)
}

function predict(fit: Fit, point: readonly number[] | undefined, unit: number): number {
  return fit.bias[unit]! + (point ? dot(point, fit.loadings[unit]!) : 0)
}

function sse(fit: Fit, cells: readonly Cell[]): number {
  let total = 0
  for (const cell of cells)
    total += (cell.z - predict(fit, fit.byRow.get(cell.row), cell.unit)) ** 2
  return total
}

/** Every matrix row placed on the fitted loadings by one ridge solve. */
function placeRows(
  matrix: ScoreMatrix,
  fit: Fit,
  center: number,
  scale: number,
  ridge: number,
): void {
  fit.coordinates = matrix.rows.map((row) => {
    if (fit.rank === 0) return []
    const list = [...row.observed].map(([unit, value]) => ({ unit, z: (value - center) / scale }))
    return solveRow(list, fit.loadings, fit.bias, fit.rank, ridge)
  })
}

/**
 * Rotates the fitted rows and loadings to principal axes: the singular
 * vectors of the fitted low-rank matrix, largest first, with the scale split
 * evenly between rows and loadings. The product the model predicts is
 * unchanged. Returns each axis's share of the squared singular values.
 */
function principalAxes(fit: Fit, fitRows: readonly number[]): number[] {
  const rank = fit.rank
  const byRow = fit.byRow
  const rows = fitRows.map((row) => byRow.get(row) ?? new Array<number>(rank).fill(0))
  const gram = (vectors: readonly (readonly number[])[]) =>
    Array.from({ length: rank }, (_, i) =>
      Array.from({ length: rank }, (_, j) => vectors.reduce((sum, v) => sum + v[i]! * v[j]!, 0)),
    )
  const lowerP = cholesky(gram(rows))
  const lowerQ = cholesky(gram(fit.loadings))
  if (lowerP === null || lowerQ === null) return []
  // C = Lpᵀ Lq; its SVD A Σ Bᵀ comes from the eigenvectors B of CᵀC.
  const c = Array.from({ length: rank }, (_, i) =>
    Array.from({ length: rank }, (_, j) => {
      let sum = 0
      for (let m = 0; m < rank; m++) sum += lowerP[m]![i]! * lowerQ[m]![j]!
      return sum
    }),
  )
  const ctc = Array.from({ length: rank }, (_, i) =>
    Array.from({ length: rank }, (_, j) => {
      let sum = 0
      for (let m = 0; m < rank; m++) sum += c[m]![i]! * c[m]![j]!
      return sum
    }),
  )
  const { values, vectors } = symmetricEigen(ctc)
  const sigma = values.map((value) => Math.sqrt(Math.max(value, 0)))
  if (sigma.some((value) => value <= 1e-12)) return []
  // B has eigenvectors as columns; A = C B Σ⁻¹.
  const b = Array.from({ length: rank }, (_, i) => vectors.map((vector) => vector[i]!))
  const a = Array.from({ length: rank }, (_, i) =>
    Array.from({ length: rank }, (_, j) => {
      let sum = 0
      for (let m = 0; m < rank; m++) sum += c[i]![m]! * b[m]![j]!
      return sum / sigma[j]!
    }),
  )
  const upperInverse = (lower: number[][]) => transpose(lowerInverse(lower))
  const transformP = multiply(multiply(upperInverse(lowerP), a), diagonal(sigma.map(Math.sqrt)))
  const transformQ = multiply(multiply(upperInverse(lowerQ), b), diagonal(sigma.map(Math.sqrt)))
  for (const [row, point] of byRow) byRow.set(row, applyRow(point, transformP))
  fit.loadings = fit.loadings.map((loading) => applyRow(loading, transformQ))
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0)
  return values.map((value) => Math.max(value, 0) / total)
}

/** Flips each axis so the mean loading points toward a better score. */
function orientAxes(fit: Fit, sign: number): void {
  for (let d = 0; d < fit.rank; d++) {
    let mean = 0
    for (const loading of fit.loadings) mean += loading[d]!
    if (sign * mean >= 0) continue
    for (const loading of fit.loadings) loading[d] = -loading[d]! || 0
    for (const point of fit.coordinates) point[d] = -point[d]! || 0
    for (const point of fit.byRow.values()) point[d] = -point[d]! || 0
  }
}

// ── Cross-validation ─────────────────────────────────────────────────

function crossValidate(
  matrix: ScoreMatrix,
  cells: readonly Cell[],
  rankCap: number,
  folds: number,
  ridge: number,
): SkillManifoldData['intrinsicDimension'] {
  const rows = new Set(cells.map((cell) => cell.row)).size
  if (rows < DESCRIPTIVE_FROM_UNITS || matrix.unitIds.length < DESCRIPTIVE_FROM_UNITS) {
    return {
      value: null,
      method: INTRINSIC_METHOD,
      n: 0,
      folds,
      curve: [],
      insufficient: `cross-validation needs ${DESCRIPTIVE_FROM_UNITS} nodes and ${DESCRIPTIVE_FROM_UNITS} units; ${plural(rows, 'node')} and ${plural(matrix.unitIds.length, 'unit')} qualify`,
    }
  }
  const curve: Array<{ rank: number; error: number; standardError: number }> = []
  let held = 0
  for (let rank = 0; rank <= rankCap; rank++) {
    const foldErrors: number[] = []
    let squares = 0
    let count = 0
    for (let fold = 0; fold < folds; fold++) {
      const train = cells.filter((cell) => cell.fold % folds !== fold)
      const test = cells.filter((cell) => cell.fold % folds === fold)
      const fit = factor(matrix.unitIds.length, train, rank, ridge)
      const trained = new Set(train.map((cell) => cell.unit))
      let foldSquares = 0
      let foldCount = 0
      for (const cell of test) {
        if (!trained.has(cell.unit)) continue
        const error = (cell.z - predict(fit, fit.byRow.get(cell.row), cell.unit)) ** 2
        foldSquares += error
        foldCount += 1
      }
      if (foldCount > 0) foldErrors.push(foldSquares / foldCount)
      squares += foldSquares
      count += foldCount
    }
    held = count
    const error = count > 0 ? squares / count : Number.NaN
    const spread =
      foldErrors.length > 1
        ? Math.sqrt(
            foldErrors.reduce((sum, value) => sum + (value - mean(foldErrors)) ** 2, 0) /
              (foldErrors.length - 1) /
              foldErrors.length,
          )
        : Number.NaN
    curve.push({ rank, error: round9(error), standardError: round9(spread) })
  }
  const finite = curve.filter((point) => Number.isFinite(point.error))
  if (finite.length === 0) {
    return {
      value: null,
      method: INTRINSIC_METHOD,
      n: held,
      folds,
      curve,
      insufficient: 'no held-out cell had a unit the rest of the data measured',
    }
  }
  const best = finite.reduce((left, right) => (right.error < left.error ? right : left))
  const bar = best.error + (Number.isFinite(best.standardError) ? best.standardError : 0)
  const chosen = finite.find((point) => point.error <= bar)!
  return {
    value: chosen.rank,
    method: INTRINSIC_METHOD,
    n: held,
    folds,
    curve,
    insufficient: null,
  }
}

// ── The next unit ────────────────────────────────────────────────────

function nextUnits(
  matrix: ScoreMatrix,
  fit: Fit,
  leaderRows: readonly number[],
  noiseVariance: number | null,
  ridge: number,
): { ranked: SkillManifoldNextUnit[]; insufficient: string | null } {
  if (leaderRows.length < 2) {
    return {
      ranked: [],
      insufficient: `${plural(leaderRows.length, 'leader')} qualify (${DESCRIPTIVE_FROM_UNITS} or more modelled units); separating leaders needs 2`,
    }
  }
  if (noiseVariance === null || !(noiseVariance > 0)) {
    return {
      ranked: [],
      insufficient: 'the cell noise is unmeasured, so no unit’s information is known',
    }
  }
  if (fit.rank === 0) {
    return { ranked: [], insufficient: 'rank 0: the nodes do not differ beyond noise' }
  }
  const rank = fit.rank
  const units = matrix.unitIds.length
  const meanLoading = new Array<number>(rank).fill(0)
  for (const loading of fit.loadings) {
    for (let d = 0; d < rank; d++) meanLoading[d]! += loading[d]! / units
  }
  // Posterior covariance of each leader's coordinates: σ² (λI + Σ Q_u Q_uᵀ)⁻¹.
  const covariance = leaderRows.map((row) => {
    const system = Array.from({ length: rank }, (_, i) =>
      Array.from({ length: rank }, (_, j) => (i === j ? ridge : 0)),
    )
    for (const unit of matrix.rows[row]!.observed.keys()) {
      const q = fit.loadings[unit]!
      for (let i = 0; i < rank; i++) {
        for (let j = 0; j < rank; j++) system[i]![j]! += q[i]! * q[j]!
      }
    }
    return choleskyInverse(cholesky(system)!).map((line) =>
      line.map((value) => value * noiseVariance),
    )
  })
  const toward = covariance.map((sigma) => sigma.map((line) => dot(line, meanLoading)))
  const contrastVariance = covariance.map((_, index) => dot(meanLoading, toward[index]!))
  const ranked: SkillManifoldNextUnit[] = []
  for (let u = 0; u < units; u++) {
    const q = fit.loadings[u]!
    const reduction = covariance.map((sigma, index) => {
      const spread = dot(
        q,
        sigma.map((line) => dot(line, q)),
      )
      return dot(toward[index]!, q) ** 2 / (noiseVariance + spread)
    })
    let share = 0
    let pairs = 0
    for (let i = 0; i < leaderRows.length; i++) {
      for (let j = i + 1; j < leaderRows.length; j++) {
        const variance = contrastVariance[i]! + contrastVariance[j]!
        if (variance > 0) share += (reduction[i]! + reduction[j]!) / variance
        pairs += 1
      }
    }
    ranked.push({
      unitId: matrix.unitIds[u]!,
      share: round9(share / pairs),
      measuredBy: leaderRows.filter((row) => matrix.rows[row]!.observed.has(u)).length,
    })
  }
  ranked.sort((left, right) => right.share - left.share || (left.unitId < right.unitId ? -1 : 1))
  return { ranked, insufficient: null }
}

// ── Small linear algebra ─────────────────────────────────────────────

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0
  for (let index = 0; index < left.length; index++) sum += left[index]! * right[index]!
  return sum
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function transpose(matrix: readonly (readonly number[])[]): number[][] {
  return matrix[0] ? matrix[0].map((_, j) => matrix.map((row) => row[j]!)) : []
}

function multiply(
  left: readonly (readonly number[])[],
  right: readonly (readonly number[])[],
): number[][] {
  return left.map((row) =>
    right[0]!.map((_, j) => row.reduce((sum, value, m) => sum + value * right[m]![j]!, 0)),
  )
}

function diagonal(values: readonly number[]): number[][] {
  return values.map((value, i) => values.map((_, j) => (i === j ? value : 0)))
}

function applyRow(vector: readonly number[], transform: readonly (readonly number[])[]): number[] {
  return transform[0]!.map((_, j) =>
    vector.reduce((sum, value, m) => sum + value * transform[m]![j]!, 0),
  )
}

/** Inverse of a lower-triangular matrix by forward substitution. */
function lowerInverse(lower: readonly (readonly number[])[]): number[][] {
  const n = lower.length
  const inverse = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let j = 0; j < n; j++) {
    inverse[j]![j] = 1 / lower[j]![j]!
    for (let i = j + 1; i < n; i++) {
      let sum = 0
      for (let m = j; m < i; m++) sum += lower[i]![m]! * inverse[m]![j]!
      inverse[i]![j] = -sum / lower[i]![i]!
    }
  }
  return inverse
}

// ── Text ─────────────────────────────────────────────────────────────

/** The manifold as text for a terminal or a proposer's context. */
export function formatSkillManifold(lens: GeometryLensResult<SkillManifoldData>): string {
  const { data, signal } = lens
  const lines: string[] = []
  const { matrix } = data
  lines.push(
    `Skill manifold (${data.split} split, ${data.mode === 'calibrated' ? `loadings from ${data.source}` : 'loadings fitted here'})`,
  )
  lines.push(
    `  matrix: ${plural(matrix.rows, 'node')} × ${plural(matrix.units, 'unit')}, ${matrix.observed} observed cells (density ${matrix.density === null ? 'unknown' : `${Math.round(matrix.density * 1000) / 10}%`}); left out ${plural(matrix.excludedNodes, 'node')} and ${plural(matrix.excludedUnits, 'unit')}${matrix.fitRows > 0 && matrix.fitRows < matrix.rows ? `; factors fitted on ${matrix.fitRows} evenly spaced rows` : ''}`,
  )
  const { intrinsicDimension: intrinsic } = data
  if (intrinsic.value === null) {
    lines.push(`  intrinsic dimension: insufficient (${intrinsic.insufficient})`)
  } else {
    const curve = intrinsic.curve
      .map(
        (point) => `k=${point.rank} ${point.error.toFixed(3)}±${fixedOrDash(point.standardError)}`,
      )
      .join(', ')
    lines.push(
      `  intrinsic dimension: ${intrinsic.value} (${intrinsic.folds}-fold held-out squared error on the standardized scale, one-SE rule, ${intrinsic.n} held-out cells per rank: ${curve})`,
    )
  }
  if (data.model === null) {
    lines.push(`  model: insufficient (${data.insufficient})`)
    return lines.join('\n')
  }
  const { model } = data
  const explained = data.explained
  const r2 = explained?.byRank.find((entry) => entry.rank === model.rank)?.r2
  lines.push(
    `  model: rank ${model.rank}, ridge ${model.ridge}, ${model.iterations} ALS sweeps${model.converged ? '' : ' (not converged)'}${r2 === undefined ? '' : `, in-sample R² ${r2.toFixed(3)} over unit means`}${explained && explained.axisShare.length > 0 ? `; axis shares ${explained.axisShare.map((share) => `${Math.round(share * 1000) / 10}%`).join(', ')}` : ''}; cell noise ${data.noiseVariance === null ? 'unknown' : data.noiseVariance.toFixed(3)} (standardized)`,
  )
  const strongest = [...data.units]
    .sort((left, right) => right.strength - left.strength)
    .slice(0, 5)
  lines.push(
    `  units that separate nodes most: ${strongest.map((unit) => `${unit.unitId} (${unit.strength.toFixed(2)}, axis ${dominantAxis(unit.loading) + 1})`).join(', ')}`,
  )
  if (data.leaders.length > 0) {
    lines.push(
      `  leaders by predicted split mean: ${data.leaders.map((leader) => `${leader.nodeId} ${leader.predictedMean.toFixed(3)} on ${leader.observed} units`).join('; ')}`,
    )
  }
  if (signal.value === null) {
    lines.push(`  next unit: insufficient (${signal.insufficient})`)
  } else {
    const top = data.nextUnits
      .slice(0, 5)
      .map(
        (unit) =>
          `${unit.unitId} ${(unit.share * 100).toFixed(1)}% (${unit.measuredBy}/${data.leaders.length} measured)`,
      )
      .join(', ')
    lines.push(
      `  next unit: ${signal.subject}, removing an expected ${(signal.value * 100).toFixed(1)}% of the leaders' contrast variance per cell; ranked: ${top}`,
    )
  }
  return lines.join('\n')
}

function dominantAxis(loading: readonly number[]): number {
  let best = 0
  for (let index = 1; index < loading.length; index++) {
    if (Math.abs(loading[index]!) > Math.abs(loading[best]!)) best = index
  }
  return best
}

function fixedOrDash(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '–'
}
