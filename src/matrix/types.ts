/**
 * @experimental
 *
 * N-axis cartesian matrix over substrate types — types module.
 *
 * The matrix is a runner + aggregator. It iterates the cartesian product of
 * caller-provided axes (any value type — `AgentProfile` from sandbox, `Driver`
 * / `Validator` from agent-runtime, rubric records, thinking levels, anything)
 * and aggregates per-axis pass/score/cost summaries. Substrate types are
 * imported at the boundary by JSDoc only; the matrix never wraps them.
 */

import type { DefaultVerdict } from '../verdict'

export type { DefaultVerdict } from '../verdict'

/** One axis = one dimension to iterate. `V` is the value type — pass any
 *  substrate type (AgentProfile, Driver, Validator, rubric record). */
export interface MatrixAxis<V> {
  /** Axis name. Becomes the key in `MatrixResult.byAxis`. */
  name: string
  /** Stable id per value. Used as the bucket key in aggregation. */
  values: Array<{ id: string; value: V }>
  /** Optional bucket label override. Receives the same `(value, id)` the
   *  runner stored on the cell; default label is `id`. */
  label?: (value: V, id: string) => string
}

/** A cell carries one picked value from each axis, keyed by axis name. */
export interface MatrixCell {
  axes: Record<string, { id: string; value: unknown }>
  /** 0-based replicate index within the same axis combination. */
  rep: number
  /** Stable sort key — preserves cartesian order across concurrent execution. */
  ordinal: number
}

export interface CellResult<Output> {
  output: Output
  verdict: DefaultVerdict
  costUsd: number
  durationMs: number
  runId?: string
  /** Populated when `runCell` threw. The cell contributes 0 to passRate AND
   *  meanScore regardless of `verdict`. */
  error?: { message: string; kind: string }
}

export interface AxisSummary {
  axisName: string
  axisValue: string
  cells: number
  passRate: number
  meanScore: number
  p50Score: number
  p90Score: number
  totalCostUsd: number
  meanDurationMs: number
}

export interface MatrixResult<Output> {
  cells: Array<{ cell: MatrixCell; runs: CellResult<Output>[] }>
  /** `byAxis[axisName][axisValueId] = summary`. Populated only for axes
   *  named in `aggregateBy` (default = every axis in `axes`). */
  byAxis: Record<string, Record<string, AxisSummary>>
  summary: {
    totalCells: number
    runsExecuted: number
    /** Cells removed by `filter` plus cells unscheduled after the cost
     *  ceiling or abort signal tripped. */
    cellsSkipped: number
    overallPassRate: number
    overallMeanScore: number
    totalCostUsd: number
    durationMs: number
  }
  /** Stable id-like string generated at the end of the run. */
  matrixId: string
}

export interface RunAgentMatrixOptions<Output> {
  axes: MatrixAxis<unknown>[]
  /** User-supplied cell executor. May throw; the matrix captures throws as
   *  `CellResult.error` and continues. */
  runCell: (cell: MatrixCell) => Promise<CellResult<Output>>
  /** Replicates per cell. Default 1. */
  reps?: number
  /** Prune cells from the cartesian BEFORE rep expansion. */
  filter?: (cell: Omit<MatrixCell, 'rep' | 'ordinal'>) => boolean
  /** Axes to aggregate into `byAxis`. Default: every axis in `axes`. */
  aggregateBy?: string[]
  /** Max concurrent in-flight `runCell` invocations. Default 4. */
  maxConcurrency?: number
  /** Cumulative-cost abort threshold (USD). When the running sum of
   *  `result.costUsd` crosses this value, no new cells are scheduled.
   *  In-flight cells finish. Default `Infinity`. */
  costCeiling?: number
  /** Fires once per executed cell, after its promise settles. */
  onCellComplete?: (cell: MatrixCell, result: CellResult<Output>) => void
  /** External cancellation. Aborts in-flight cells via a forwarded signal
   *  and suppresses scheduling of new ones. */
  signal?: AbortSignal
}
