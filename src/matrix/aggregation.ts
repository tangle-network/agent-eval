/**
 * Per-axis aggregation of cell runs into `AxisSummary` rows.
 *
 * Pure: consumes the final `cells: [{cell, runs}]` array and returns the
 * `byAxis` table. Error runs contribute 0 to passRate and meanScore. Cost
 * and duration always count — the budget was spent regardless.
 */

import type { AxisSummary, CellResult, MatrixAxis, MatrixCell, MatrixResult } from './types'

interface Row<Output> {
  cell: MatrixCell
  result: CellResult<Output>
}

function flattenRuns<Output>(cells: MatrixResult<Output>['cells']): Row<Output>[] {
  const rows: Row<Output>[] = []
  for (const { cell, runs } of cells) {
    for (const result of runs) rows.push({ cell, result })
  }
  return rows
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0] as number
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo] as number
  const frac = pos - lo
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac
}

export function summariseRows<Output>(
  rows: Row<Output>[],
  axisName: string,
  axisValue: string,
): AxisSummary {
  if (rows.length === 0) {
    return {
      axisName,
      axisValue,
      cells: 0,
      passRate: 0,
      meanScore: 0,
      p50Score: 0,
      p90Score: 0,
      totalCostUsd: 0,
      meanDurationMs: 0,
    }
  }
  let pass = 0
  let scoreSum = 0
  let costSum = 0
  let durSum = 0
  const scores: number[] = []
  for (const { result } of rows) {
    const errored = result.error !== undefined
    const score = errored ? 0 : result.verdict.score
    const valid = !errored && result.verdict.valid
    if (valid) pass++
    scoreSum += score
    scores.push(score)
    costSum += result.costUsd
    durSum += result.durationMs
  }
  scores.sort((a, b) => a - b)
  return {
    axisName,
    axisValue,
    cells: rows.length,
    passRate: pass / rows.length,
    meanScore: scoreSum / rows.length,
    p50Score: quantile(scores, 0.5),
    p90Score: quantile(scores, 0.9),
    totalCostUsd: costSum,
    meanDurationMs: durSum / rows.length,
  }
}

function bucketBy<Output>(
  rows: Row<Output>[],
  axisName: string,
  labelFor: (id: string) => string,
): Record<string, AxisSummary> {
  const buckets = new Map<string, Row<Output>[]>()
  for (const row of rows) {
    const slot = row.cell.axes[axisName]
    if (!slot) continue
    const id = slot.id
    let arr = buckets.get(id)
    if (!arr) {
      arr = []
      buckets.set(id, arr)
    }
    arr.push(row)
  }
  const out: Record<string, AxisSummary> = {}
  // Sorted keys for deterministic JSON serialisation.
  for (const id of [...buckets.keys()].sort()) {
    out[id] = summariseRows(buckets.get(id) as Row<Output>[], axisName, labelFor(id))
  }
  return out
}

export function buildByAxis<Output>(
  cells: MatrixResult<Output>['cells'],
  axes: MatrixAxis<unknown>[],
  aggregateBy: string[],
): Record<string, Record<string, AxisSummary>> {
  const rows = flattenRuns(cells)
  const byName = new Map(axes.map((a) => [a.name, a]))
  const byAxis: Record<string, Record<string, AxisSummary>> = {}
  for (const name of aggregateBy) {
    const axis = byName.get(name)
    const labelFor = (id: string): string => {
      if (!axis?.label) return id
      const found = axis.values.find((v) => v.id === id)
      if (!found) return id
      return axis.label(found.value, id)
    }
    byAxis[name] = bucketBy(rows, name, labelFor)
  }
  return byAxis
}
