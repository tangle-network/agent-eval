/** Choose the supported skill rank from held-out observed cells. */

import { mean } from '../../statistics/mean'
import { plural, round9 } from './geometry'
import { INSUFFICIENT_FROM } from './shared'
import { METHODS, type SkillLink, type SkillManifoldData } from './skill-manifold-contract'
import type { Cell, ScoreMatrix } from './skill-manifold-matrix'
import { cellLoss, factor, predict } from './skill-manifold-model'

// ── Cross-validation ─────────────────────────────────────────────────

export function crossValidate(
  matrix: ScoreMatrix,
  cells: readonly Cell[],
  rankCap: number,
  folds: number,
  ridge: number,
  link: SkillLink,
): SkillManifoldData['intrinsicDimension'] {
  const rows = new Set(cells.map((cell) => cell.row)).size
  if (rows < INSUFFICIENT_FROM || matrix.unitIds.length < INSUFFICIENT_FROM) {
    return {
      value: null,
      method: METHODS[link].intrinsic,
      n: 0,
      folds,
      curve: [],
      insufficient: `cross-validation needs ${INSUFFICIENT_FROM} nodes and ${INSUFFICIENT_FROM} units; ${plural(rows, 'node')} and ${plural(matrix.unitIds.length, 'unit')} qualify`,
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
      const fit = factor(matrix.unitIds.length, train, rank, ridge, link)
      const trained = new Set(train.map((cell) => cell.unit))
      let foldSquares = 0
      let foldCount = 0
      for (const cell of test) {
        if (!trained.has(cell.unit)) continue
        foldSquares += cellLoss(cell, predict(fit, fit.byRow.get(cell.row), cell.unit), link)
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
      method: METHODS[link].intrinsic,
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
    method: METHODS[link].intrinsic,
    n: held,
    folds,
    curve,
    insufficient: null,
  }
}
