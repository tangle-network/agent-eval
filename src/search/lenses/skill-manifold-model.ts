/** Fit latent skills and place nodes on deterministic principal axes. */

import { cholesky, choleskySolve } from '../../math/cholesky'
import { symmetricEigen } from '../../math/symmetric-eigen'
import { mulberry32 } from '../../statistics/random'
import type { SkillLink } from './skill-manifold-contract'
import type { Cell, ScoreMatrix } from './skill-manifold-matrix'

/** The prior precision on a unit's log-odds intercept: N(0, 10²), weak
 * enough to leave any observed pass rate alone and strong enough to keep a
 * unit every node passed (or failed) finite. */
const LOGIT_BIAS_PRECISION = 0.01

/** The largest move one Newton step makes in any coordinate, in log-odds. */
const NEWTON_STEP_CAP = 4

const MAX_ITERATIONS = 300

/** Relative change of the objective that ends a fit. */
const TOLERANCE = 1e-7

// ── The factorization ────────────────────────────────────────────────

export interface Fit {
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

/** The fit of `rank` axes under `link`. */
export function factor(
  units: number,
  cells: readonly Cell[],
  rank: number,
  ridge: number,
  link: SkillLink,
): Fit {
  return link === 'identity'
    ? factorLinear(units, cells, rank, ridge)
    : factorLogistic(units, cells, rank, ridge)
}

function groupCells(
  units: number,
  cells: readonly Cell[],
): { byUnit: Cell[][]; byRow: Map<number, Cell[]> } {
  const byUnit: Cell[][] = Array.from({ length: units }, () => [])
  const byRow = new Map<number, Cell[]>()
  for (const cell of cells) {
    byUnit[cell.unit]!.push(cell)
    const list = byRow.get(cell.row)
    if (list) list.push(cell)
    else byRow.set(cell.row, [cell])
  }
  return { byUnit, byRow }
}

/** Loadings start from a fixed seeded draw, so a fit is deterministic. */
function seededLoadings(units: number, rank: number): number[][] {
  const random = mulberry32(0x5eed + rank)
  return Array.from({ length: units }, () =>
    Array.from({ length: rank }, () => (random() - 0.5) * 0.2),
  )
}

/**
 * Alternating ridge least squares over `cells`: rows' coordinates given the
 * loadings, then each unit's loading and (unpenalized) bias given the
 * coordinates, until the objective moves by less than 1e-7 of itself.
 */
function factorLinear(units: number, cells: readonly Cell[], rank: number, ridge: number): Fit {
  const { byUnit, byRow: rowIds } = groupCells(units, cells)
  const bias = byUnit.map((list) =>
    list.length === 0 ? 0 : list.reduce((sum, cell) => sum + cell.z, 0) / list.length,
  )
  const loadings = seededLoadings(units, rank)
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
      coordinates.set(row, solveRow(list, loadings, bias, rank, ridge, 'identity'))
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
        const point = coordinates.get(cell.row)!
        for (let i = 0; i < size; i++) {
          const xi = i < rank ? point[i]! : 1
          rhs[i]! += xi * cell.z
          const line = system[i]!
          for (let j = 0; j < size; j++) line[j]! += xi * (j < rank ? point[j]! : 1)
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

/**
 * The item-response fit: alternating Newton steps on the penalized binomial
 * likelihood, each row's coordinates given the loadings, then each unit's
 * loading and intercept given the coordinates, until the objective moves by
 * less than 1e-7 of itself. Priors: standard normal on coordinates and
 * loadings (scaled by `ridge`), N(0, 10²) on each intercept, which keeps a
 * unit every node passed finite. A step moves no parameter by more than 4.
 */
function factorLogistic(units: number, cells: readonly Cell[], rank: number, ridge: number): Fit {
  const { byUnit, byRow: rowIds } = groupCells(units, cells)
  const bias = byUnit.map((list) => {
    let k = 0
    let n = 0
    for (const cell of list) {
      k += cell.k
      n += cell.n
    }
    return Math.log((k + 0.5) / (n - k + 0.5))
  })
  const loadings = seededLoadings(units, rank)
  const coordinates = new Map<number, number[]>()
  for (const row of rowIds.keys()) coordinates.set(row, new Array<number>(rank).fill(0))
  const objectiveOf = (): number => {
    let total = 0
    for (const cell of cells) {
      total += binomialLoss(
        cell,
        bias[cell.unit]! + dot(coordinates.get(cell.row)!, loadings[cell.unit]!),
      )
    }
    for (const point of coordinates.values()) total += (ridge / 2) * dot(point, point)
    for (const loading of loadings) total += (ridge / 2) * dot(loading, loading)
    for (const value of bias) total += (LOGIT_BIAS_PRECISION / 2) * value * value
    return total
  }
  let previous = Number.POSITIVE_INFINITY
  let iterations = 0
  let converged = false
  for (; iterations < MAX_ITERATIONS; iterations++) {
    if (rank > 0) {
      for (const [row, list] of rowIds) {
        const point = coordinates.get(row)!
        coordinates.set(row, newtonStep(point, list, loadings, bias, ridge))
      }
    }
    for (let u = 0; u < units; u++) {
      const list = byUnit[u]!
      if (list.length === 0) continue
      const size = rank + 1
      const theta = [...loadings[u]!, bias[u]!]
      const precision = (i: number): number => (i < rank ? ridge : LOGIT_BIAS_PRECISION)
      const hessian = Array.from({ length: size }, (_, i) =>
        Array.from({ length: size }, (_, j) => (i === j ? precision(i) : 0)),
      )
      const gradient = theta.map((value, i) => -precision(i) * value)
      for (const cell of list) {
        const point = coordinates.get(cell.row)!
        const p = logistic(theta[rank]! + dot(point, theta))
        const weight = cell.n * p * (1 - p)
        for (let i = 0; i < size; i++) {
          const xi = i < rank ? point[i]! : 1
          gradient[i]! += (cell.k - cell.n * p) * xi
          const line = hessian[i]!
          for (let j = 0; j < size; j++) line[j]! += weight * xi * (j < rank ? point[j]! : 1)
        }
      }
      const lower = cholesky(hessian)
      if (lower === null) continue
      const step = capped(choleskySolve(lower, gradient))
      loadings[u] = theta.slice(0, rank).map((value, i) => value + step[i]!)
      bias[u] = theta[rank]! + step[rank]!
    }
    const objective = objectiveOf()
    if (Math.abs(previous - objective) <= TOLERANCE * Math.max(objective, 1e-12)) {
      converged = true
      iterations += 1
      break
    }
    previous = objective
  }
  return { rank, bias, loadings, byRow: coordinates, coordinates: [], iterations, converged }
}

/** One Newton step on a row's coordinates under the item-response model. */
function newtonStep(
  point: readonly number[],
  list: readonly Pick<Cell, 'unit' | 'k' | 'n'>[],
  loadings: readonly (readonly number[])[],
  bias: readonly number[],
  ridge: number,
): number[] {
  const rank = point.length
  const hessian = Array.from({ length: rank }, (_, i) =>
    Array.from({ length: rank }, (_, j) => (i === j ? ridge : 0)),
  )
  const gradient = point.map((value) => -ridge * value)
  for (const cell of list) {
    const q = loadings[cell.unit]!
    const p = logistic(bias[cell.unit]! + dot(point, q))
    const weight = cell.n * p * (1 - p)
    for (let i = 0; i < rank; i++) {
      gradient[i]! += (cell.k - cell.n * p) * q[i]!
      for (let j = 0; j < rank; j++) hessian[i]![j]! += weight * q[i]! * q[j]!
    }
  }
  const step = capped(choleskySolve(cholesky(hessian)!, gradient))
  return point.map((value, i) => value + step[i]!)
}

function capped(step: readonly number[]): number[] {
  const largest = Math.max(0, ...step.map(Math.abs))
  return largest > NEWTON_STEP_CAP
    ? step.map((value) => (value * NEWTON_STEP_CAP) / largest)
    : [...step]
}

/** −log of the binomial likelihood of `k` passes in `n` at log-odds `eta`,
 * without the binomial coefficient: n·log(1 + e^η) − k·η, computed stably. */
function binomialLoss(cell: Pick<Cell, 'k' | 'n'>, eta: number): number {
  const softplus = Math.max(eta, 0) + Math.log1p(Math.exp(-Math.abs(eta)))
  return cell.n * softplus - cell.k * eta
}

export function logistic(eta: number): number {
  if (eta >= 0) return 1 / (1 + Math.exp(-eta))
  const e = Math.exp(eta)
  return e / (1 + e)
}

/** A row's coordinates given the loadings: one ridge solve (identity), or
 * Newton steps to convergence (logit). */
function solveRow(
  list: readonly Pick<Cell, 'unit' | 'z' | 'k' | 'n'>[],
  loadings: readonly (readonly number[])[],
  bias: readonly number[],
  rank: number,
  ridge: number,
  link: SkillLink,
): number[] {
  if (link === 'logit') {
    let point = new Array<number>(rank).fill(0)
    for (let iteration = 0; iteration < 50; iteration++) {
      const next = newtonStep(point, list, loadings, bias, ridge)
      const moved = Math.max(0, ...next.map((value, i) => Math.abs(value - point[i]!)))
      point = next
      if (moved < 1e-10) break
    }
    return point
  }
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

/** The model's linear predictor: standardized mean (identity) or log-odds (logit). */
export function predict(fit: Fit, point: readonly number[] | undefined, unit: number): number {
  return fit.bias[unit]! + (point ? dot(point, fit.loadings[unit]!) : 0)
}

/** Squared error (identity) or binomial log loss (logit) of the fit on `cells`. */
export function loss(fit: Fit, cells: readonly Cell[], link: SkillLink): number {
  let total = 0
  for (const cell of cells)
    total += cellLoss(cell, predict(fit, fit.byRow.get(cell.row), cell.unit), link)
  return total
}

export function cellLoss(cell: Cell, eta: number, link: SkillLink): number {
  return link === 'identity' ? (cell.z - eta) ** 2 : binomialLoss(cell, eta)
}

/** Every matrix row placed on the fitted loadings. */
export function placeRows(
  matrix: ScoreMatrix,
  fit: Fit,
  center: number,
  scale: number,
  ridge: number,
  link: SkillLink,
): void {
  fit.coordinates = matrix.rows.map((row) => {
    if (fit.rank === 0) return []
    const list = [...row.observed].map(([unit, value]) => ({
      unit,
      z: (value - center) / scale,
      k: row.counts.get(unit)!.sum,
      n: row.counts.get(unit)!.count,
    }))
    return solveRow(list, fit.loadings, fit.bias, fit.rank, ridge, link)
  })
}

/**
 * Rotates the fitted rows and loadings to principal axes: the singular
 * vectors of the fitted low-rank matrix, largest first, with the scale split
 * evenly between rows and loadings. The product the model predicts is
 * unchanged. Returns each axis's share of the squared singular values.
 */
export function principalAxes(fit: Fit, fitRows: readonly number[]): number[] {
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
export function orientAxes(fit: Fit, sign: number): void {
  for (let d = 0; d < fit.rank; d++) {
    let mean = 0
    for (const loading of fit.loadings) mean += loading[d]!
    if (sign * mean >= 0) continue
    for (const loading of fit.loadings) loading[d] = -loading[d]! || 0
    for (const point of fit.coordinates) point[d] = -point[d]! || 0
    for (const point of fit.byRow.values()) point[d] = -point[d]! || 0
  }
}

// ── Small linear algebra ─────────────────────────────────────────────

export function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0
  for (let index = 0; index < left.length; index++) sum += left[index]! * right[index]!
  return sum
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
