/**
 * Input-space tiling + coverage projection.
 *
 * Cells are the cartesian product of the input axes — the stratification plan,
 * enumerable up front so the planned-vs-covered denominator is honest. Coverage
 * is projected from the evaluation log: per cell, the full DISTRIBUTION of the
 * headline score, of each scored dimension, and of evaluation latency — a bare
 * mean hides outliers, so every aggregate carries its spread. Per-cell cost is
 * split known-dollars vs unknown-runs, never folded into a fabricated $0.
 */

import type { BehaviorSpace, Cell, CoverageCell, Distribution, Evaluation } from './types'

/** One recorded evaluation — the unit coverage and the capsule are built from. */
export interface EvalRecord {
  cell: Cell
  ev: Evaluation
  /** The objective's interest score for this evaluation. */
  interest: number
  /** Evaluation wall-clock — engine-measured unless `ev.latencyMs` overrode it. */
  latencyMs: number
  /** Known dollars for this run. `null` = cost tracking was wired but this
   *  run's cost was unknowable (counted apart). Absent = not tracked at all. */
  costUsd?: number | null
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

/** Nearest-rank percentile on a pre-sorted ascending sample. */
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx] as number
}

/** Summarize a sample. Throws on an empty sample — callers represent "no data"
 *  as `null`, never as a zeroed distribution. */
export function distribution(values: number[]): Distribution {
  if (values.length === 0)
    throw new Error('distribution: empty sample — represent missing data as null, not zeros')
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  return {
    mean,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    n: sorted.length,
  }
}

/**
 * Project the evaluation log into the per-input-cell coverage map. A cell with
 * no evaluations reports `score: null` (honestly uncovered), never zeros.
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
    if (runs === 0)
      return { cell, runs: 0, score: null, findingRate: 0, dimensions: {}, latencyMs: null }

    const score = distribution(recs.map((r) => r.ev.score))
    const latencyMs = distribution(recs.map((r) => r.latencyMs))
    const findingRate = recs.filter((r) => r.interest >= threshold).length / runs

    const dimSamples: Record<string, number[]> = {}
    for (const r of recs) {
      for (const [k, v] of Object.entries(r.ev.scores ?? {})) {
        const samples = dimSamples[k] ?? []
        samples.push(v)
        dimSamples[k] = samples
      }
    }
    const dimensions: Record<string, Distribution> = {}
    for (const [k, xs] of Object.entries(dimSamples)) dimensions[k] = distribution(xs)

    // Cost fields appear only when tracking was wired: known dollars sum, and
    // tracked-but-unknown runs counted apart — never folded in as $0.
    const tracked = recs.filter((r) => r.costUsd !== undefined)
    const known = tracked.filter((r) => r.costUsd !== null)
    const cost =
      tracked.length > 0
        ? {
            costUsd: known.reduce((a, r) => a + (r.costUsd as number), 0),
            ...(tracked.length > known.length
              ? { costUnknownRuns: tracked.length - known.length }
              : {}),
          }
        : {}

    return { cell, runs, score, findingRate, dimensions, latencyMs, ...cost }
  })
}
