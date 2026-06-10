/**
 * Input-space tiling + coverage projection.
 *
 * Cells are the cartesian product of the input axes — the stratification plan,
 * enumerable up front so the planned-vs-covered denominator is honest. Coverage
 * is projected from the evaluation log: per cell, mean headline robustness, the
 * mean of each scored dimension (so the map shows WHICH dimension is weak), and
 * the rate at which the active objective flagged a candidate.
 */

import type { BehaviorSpace, Cell, CoverageCell, Evaluation } from './types'

/** One recorded evaluation — the unit coverage and the capsule are built from. */
export interface EvalRecord {
  cell: Cell
  ev: Evaluation
  /** The objective's interest score for this evaluation. */
  interest: number
}

/** Enumerate every input cell (cartesian product of the axes), in stable order. */
export function enumerateCells(space: BehaviorSpace): Cell[] {
  if (space.axes.length === 0) return []
  let partials: Array<Record<string, string>> = [{}]
  for (const axis of space.axes) {
    const next: Array<Record<string, string>> = []
    for (const partial of partials) {
      for (const value of axis.values) next.push({ ...partial, [axis.name]: value })
    }
    partials = next
  }
  return partials.map((coords) => ({ id: cellId(space, coords), coords }))
}

/** Deterministic id for a coordinate map, e.g. `matterType=nda|difficulty=hard`. */
export function cellId(space: BehaviorSpace, coords: Record<string, string>): string {
  return space.axes.map((a) => `${a.name}=${coords[a.name]}`).join('|')
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * Project the evaluation log into the per-input-cell coverage map. A cell with
 * no evaluations reports `robustness: null` (honestly uncovered), never 0.
 */
export function buildCoverage(cells: Cell[], log: EvalRecord[], threshold: number): CoverageCell[] {
  const byCell = new Map<string, EvalRecord[]>()
  for (const r of log) {
    const arr = byCell.get(r.cell.id) ?? []
    arr.push(r)
    byCell.set(r.cell.id, arr)
  }
  return cells.map((cell) => {
    const recs = byCell.get(cell.id) ?? []
    const runs = recs.length
    if (runs === 0) return { cell, runs: 0, robustness: null, findingRate: 0, dimensions: {} }
    const robustness = mean(recs.map((r) => r.ev.score))
    const findingRate = recs.filter((r) => r.interest >= threshold).length / runs
    const dims: Record<string, number[]> = {}
    for (const r of recs) {
      for (const [k, v] of Object.entries(r.ev.scores ?? {})) {
        ;(dims[k] ??= []).push(v)
      }
    }
    const dimensions: Record<string, number> = {}
    for (const [k, xs] of Object.entries(dims)) dimensions[k] = mean(xs)
    return { cell, runs, robustness, findingRate, dimensions }
  })
}
