/**
 * The behavior hypercube — tiling + coverage projection.
 *
 * Cells are the cartesian product of the descriptor axes. The fuzzer keeps one
 * elite per cell (MAP-Elites) and steers its budget toward cells whose
 * robustness is least certain, so the archive ends up tiling the space rather
 * than collapsing onto a single hardest scenario.
 */

import type { CellObservation } from '../rl/active-curriculum'
import type { CoverageCell, FuzzCell, HypercubeSpec } from './types'

/** Enumerate every cell (cartesian product of the axes), in stable order. */
export function enumerateCells(cube: HypercubeSpec): FuzzCell[] {
  if (cube.axes.length === 0) return []
  let cells: FuzzCell[] = [{ id: '', coords: {} }]
  for (const axis of cube.axes) {
    const next: FuzzCell[] = []
    for (const partial of cells) {
      for (const value of axis.values) {
        next.push({ id: '', coords: { ...partial.coords, [axis.name]: value } })
      }
    }
    cells = next
  }
  // Assign stable ids from the coordinate map (axis order preserved).
  return cells.map((c) => ({ ...c, id: cellId(cube, c.coords) }))
}

/** Deterministic id for a coordinate map, e.g. `matterType=nda|difficulty=hard`. */
export function cellId(cube: HypercubeSpec, coords: Record<string, string>): string {
  return cube.axes.map((a) => `${a.name}=${coords[a.name]}`).join('|')
}

/**
 * Project the per-run observations into a per-cell coverage map. A cell with no
 * runs reports `robustness: null` (honestly uncovered) rather than a misleading 0.
 */
export function buildCoverage(cells: FuzzCell[], observations: CellObservation[]): CoverageCell[] {
  const byCell = new Map<string, number[]>()
  const failByCell = new Map<string, number>()
  for (const o of observations) {
    const arr = byCell.get(o.variantId) ?? []
    arr.push(o.score)
    byCell.set(o.variantId, arr)
    const failed = o.pass === false || o.score < 0.5
    if (failed) failByCell.set(o.variantId, (failByCell.get(o.variantId) ?? 0) + 1)
  }
  return cells.map((cell) => {
    const scores = byCell.get(cell.id) ?? []
    const runs = scores.length
    if (runs === 0) {
      return { cell, runs: 0, meanScore: 0, failureRate: 0, robustness: null }
    }
    const meanScore = scores.reduce((a, b) => a + b, 0) / runs
    const failureRate = (failByCell.get(cell.id) ?? 0) / runs
    return { cell, runs, meanScore, failureRate, robustness: meanScore }
  })
}
