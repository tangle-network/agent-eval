/** Build the observed node × unit matrix without filling missing cells. */

import type { SearchNodeStatus } from '../../campaign/search-ledger-types'
import {
  type SearchScoredCell,
  type SearchStateView,
  searchUnitScores,
} from '../../campaign/search-state'
import { compareCodeUnits } from '../../ledger-core/canonical'
import type { SkillCalibration } from './skill-manifold-contract'

// ── The matrix ───────────────────────────────────────────────────────

interface Row {
  nodeId: string
  ordinal: number
  status: SearchNodeStatus | null
  /** Modelled unit index → per-unit mean. */
  observed: Map<number, number>
  /** Modelled unit index → the unit's summed score and scored cells: passes
   * and trials when every cell scores 0 or 1. */
  counts: Map<number, { sum: number; count: number }>
}

export interface ScoreMatrix {
  rows: Row[]
  unitIds: string[]
  observedBy: number[]
  observed: number
  excludedNodes: number
  excludedUnits: number
  /** Every scored cell of the modelled rows scores exactly 0 or 1. */
  binary: boolean
}

/**
 * Per-unit means of every node on `split`. Without a calibration, a unit is
 * modelled when 2 or more nodes scored it and a node when it scored 2 or more
 * modelled units, repeated until both hold. With one, the modelled units are
 * the calibration's, and a node needs one of them.
 */
export function scoreMatrix(
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
    counts: Map<string, { sum: number; count: number }>
    binary: boolean
  }> = []
  const allUnits = new Set<string>()
  for (const node of state.nodes()) {
    const cells =
      asOf === undefined
        ? state.scoredCells(node.nodeId, split)
        : scoredAsOf(state, node.nodeId, split, asOf)
    const scores = searchUnitScores(cells)
    const units = new Map(scores.map((unit) => [unit.unitId, unit.mean]))
    const counts = new Map(
      scores.map((unit) => [unit.unitId, { sum: unit.sum, count: unit.count }]),
    )
    for (const unitId of units.keys()) allUnits.add(unitId)
    raw.push({
      nodeId: node.nodeId,
      ordinal: node.ordinal,
      status: node.status,
      units,
      counts,
      binary: cells.every((cell) => cell.score === 0 || cell.score === 1),
    })
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
    const counts = new Map<number, { sum: number; count: number }>()
    for (const [unitId, mean] of row.units) {
      const index = unitIndex.get(unitId)
      if (index === undefined) continue
      map.set(index, mean)
      counts.set(index, row.counts.get(unitId)!)
      observedBy[index]! += 1
      observed += 1
    }
    return { nodeId: row.nodeId, ordinal: row.ordinal, status: row.status, observed: map, counts }
  })
  return {
    rows,
    unitIds,
    observedBy,
    observed,
    binary: keep.length > 0 && keep.every((row) => row.binary),
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

export function standardization(matrix: ScoreMatrix): { center: number; scale: number } | null {
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

export interface ManifoldCell {
  row: number
  unit: number
  /** The standardized per-unit mean (identity link). */
  z: number
  /** Passes and trials (logit link): the unit's summed score and its cells. */
  k: number
  n: number
  fold: number
}

export function observedCells(
  matrix: ScoreMatrix,
  rows: readonly number[],
  center: number,
  scale: number,
): ManifoldCell[] {
  const cells: ManifoldCell[] = []
  for (const row of rows) {
    const { nodeId, observed, counts } = matrix.rows[row]!
    for (const [unit, value] of [...observed].sort(([left], [right]) => left - right)) {
      const { sum, count } = counts.get(unit)!
      cells.push({
        row,
        unit,
        z: (value - center) / scale,
        k: sum,
        n: count,
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
