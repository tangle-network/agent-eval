/** Rank and batch units by posterior information about the leaders. */

import { compareCodeUnits } from '../../ledger-core/canonical'
import { cholesky, choleskyInverse } from '../../math/cholesky'
import { plural, round9 } from './geometry'
import { INSUFFICIENT_FROM } from './shared'
import type { SkillLink, SkillManifoldNextUnit } from './skill-manifold-contract'
import type { ScoreMatrix } from './skill-manifold-matrix'
import { dot, type Fit, logistic } from './skill-manifold-model'

// ── The next unit ────────────────────────────────────────────────────

export function nextUnits(
  matrix: ScoreMatrix,
  fit: Fit,
  leaderRows: readonly number[],
  noiseVariance: number | null,
  ridge: number,
  batch: { count: number; among?: readonly string[] } | null,
  link: SkillLink,
): { ranked: SkillManifoldNextUnit[]; batch: string[] | null; insufficient: string | null } {
  if (leaderRows.length < 2) {
    return {
      ranked: [],
      batch: null,
      insufficient: `${plural(leaderRows.length, 'leader')} qualify (${INSUFFICIENT_FROM} or more modelled units); separating leaders needs 2`,
    }
  }
  if (link === 'identity' && (noiseVariance === null || !(noiseVariance > 0))) {
    return {
      ranked: [],
      batch: null,
      insufficient: 'the cell noise is unmeasured, so no unit’s information is known',
    }
  }
  if (fit.rank === 0) {
    return { ranked: [], batch: null, insufficient: 'rank 0: the nodes do not differ beyond noise' }
  }
  const rank = fit.rank
  const units = matrix.unitIds.length
  // Per leader: the noise of one more cell on each unit, the posterior
  // covariance of its coordinates, and the gradient of its predicted split
  // mean. Identity link: noise σ² on every cell, covariance σ²(λI + Σ Q_uQ_uᵀ)⁻¹
  // over its observed units, gradient the mean loading. Logit link (Laplace):
  // a cell at pass rate p carries information p(1−p), covariance
  // (λI + Σ n_u p_u(1−p_u) Q_uQ_uᵀ)⁻¹, gradient the mean of p_u(1−p_u) Q_u.
  const meanLoading = new Array<number>(rank).fill(0)
  for (const loading of fit.loadings) {
    for (let d = 0; d < rank; d++) meanLoading[d]! += loading[d]! / units
  }
  const leaders = leaderRows.map((row) => {
    const point = fit.coordinates[row]!
    const information = fit.loadings.map((q, u) => {
      if (link === 'identity') return 1 / noiseVariance!
      const p = logistic(fit.bias[u]! + dot(point, q))
      return p * (1 - p)
    })
    const gradient =
      link === 'identity'
        ? meanLoading
        : Array.from({ length: rank }, (_, d) => {
            let total = 0
            for (let u = 0; u < units; u++)
              total += (information[u]! * fit.loadings[u]![d]!) / units
            return total
          })
    const prior = link === 'identity' ? ridge / noiseVariance! : ridge
    const system = Array.from({ length: rank }, (_, i) =>
      Array.from({ length: rank }, (_, j) => (i === j ? prior : 0)),
    )
    const counts = matrix.rows[row]!.counts
    for (const unit of matrix.rows[row]!.observed.keys()) {
      const q = fit.loadings[unit]!
      const weight = information[unit]! * (link === 'identity' ? 1 : counts.get(unit)!.count)
      for (let i = 0; i < rank; i++) {
        for (let j = 0; j < rank; j++) system[i]![j]! += weight * q[i]! * q[j]!
      }
    }
    return { information, gradient, covariance: choleskyInverse(cholesky(system)!) }
  })
  const shares = (sigmas: readonly (readonly (readonly number[])[])[]): number[] => {
    const toward = sigmas.map((sigma, index) =>
      sigma.map((line) => dot(line, leaders[index]!.gradient)),
    )
    const contrast = toward.map((vector, index) => dot(leaders[index]!.gradient, vector))
    return fit.loadings.map((q, u) => {
      const reduction = sigmas.map((sigma, index) => {
        const information = leaders[index]!.information[u]!
        if (!(information > 0)) return 0
        const spread = dot(
          q,
          sigma.map((line) => dot(line, q)),
        )
        return dot(toward[index]!, q) ** 2 / (1 / information + spread)
      })
      let share = 0
      let pairs = 0
      for (let i = 0; i < sigmas.length; i++) {
        for (let j = i + 1; j < sigmas.length; j++) {
          const variance = contrast[i]! + contrast[j]!
          if (variance > 0) share += (reduction[i]! + reduction[j]!) / variance
          pairs += 1
        }
      }
      return share / pairs
    })
  }
  const byShare = (values: readonly number[]) => (left: number, right: number) =>
    values[right]! - values[left]! ||
    compareCodeUnits(matrix.unitIds[left]!, matrix.unitIds[right]!)
  const covariance = leaders.map((leader) => leader.covariance)
  const first = shares(covariance)
  const ranked = matrix.unitIds
    .map((_, u) => u)
    .sort(byShare(first))
    .map((u) => ({
      unitId: matrix.unitIds[u]!,
      share: round9(first[u]!),
      measuredBy: leaderRows.filter((row) => matrix.rows[row]!.observed.has(u)).length,
    }))
  if (batch === null) return { ranked, batch: null, insufficient: null }
  // Greedy batch: pick the best unit, condition every leader on one more cell
  // of it, and pick again, so a batch spreads over the directions it needs.
  const among = new Set(batch.among ?? matrix.unitIds)
  const open = new Set(matrix.unitIds.flatMap((unitId, u) => (among.has(unitId) ? [u] : [])))
  const picked: string[] = []
  let sigmas: number[][][] = covariance
  while (picked.length < batch.count && open.size > 0) {
    const values = shares(sigmas)
    const best = [...open].sort(byShare(values))[0]!
    open.delete(best)
    picked.push(matrix.unitIds[best]!)
    const q = fit.loadings[best]!
    sigmas = sigmas.map((sigma, index) => {
      const information = leaders[index]!.information[best]!
      if (!(information > 0)) return sigma
      const toward = sigma.map((line) => dot(line, q))
      const denominator = 1 / information + dot(q, toward)
      return sigma.map((line, i) =>
        line.map((value, j) => value - (toward[i]! * toward[j]!) / denominator),
      )
    })
  }
  return { ranked, batch: picked, insufficient: null }
}
