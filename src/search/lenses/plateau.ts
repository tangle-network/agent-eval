/**
 * The plateau score: how far a search's best improvement over the root rose
 * across its last few measured nodes, in units of noise.
 *
 * It reads only what a `SearchPolicyView` holds, so the `landscape` lens and
 * a policy (`draftOnPlateau`) compute the same number from the same ledger.
 */

import type { SearchPolicyView } from '../../campaign/search-policy'
import { DESCRIPTIVE_FROM_UNITS, round9 } from './geometry'

/** What the plateau reads: a policy view, or the lens's own reading of one. */
export type SearchPlateauView = Pick<
  SearchPolicyView,
  'direction' | 'rootNodeId' | 'screened' | 'complete' | 'unitScores'
>

export interface SearchPlateauOptions {
  /** Accepted nodes the rise is measured across. Default 6. */
  window?: number
}

export interface SearchPlateau {
  /** `rise / noise`; null when insufficient. Below 1 the best improvement rose
   * less than one standard error across the window: a plateau. */
  value: number | null
  window: number
  /** Screened non-root nodes that dodged no unit and share at least 6 units
   * with the root (the design's `descriptive` threshold), in registration
   * order. Only these can hold the best. */
  accepted: number
  /** The accepted nodes the window covers, oldest first. */
  windowNodes: string[]
  /** Best improvement over the root after the window minus before it; the
   * root itself is the best before any node, at exactly 0. */
  rise: number | null
  /** Standard error of the best node's improvement: sqrt(pooled variance / its
   * shared units). */
  noise: number | null
  best: { nodeId: string; gain: number; pairs: number } | null
  /** Between-unit variance of per-unit improvements over the root, pooled over
   * every screened complete node with 2 or more shared units. */
  pooledVariance: number | null
  degreesOfFreedom: number
  method: string
  insufficient: string | null
}

export const PLATEAU_METHOD = `rise of the best improvement over the root across the last \`window\` accepted nodes (screened, no dodged unit, ${DESCRIPTIVE_FROM_UNITS} or more units shared with the root), divided by the best node's standard error sqrt(pooled variance / its shared units); an improvement is the mean per-unit gain over the root on shared units in the objective's direction, and the variance is the between-unit variance of those gains pooled over screened nodes with 2 or more shared units`

/**
 * The plateau score of a search. Nodes are taken in the view's screened
 * order, which is registration order. Insufficient with fewer than `window`
 * accepted nodes, or without a pooled variance above zero.
 */
export function searchPlateau(
  view: SearchPlateauView,
  options: SearchPlateauOptions = {},
): SearchPlateau {
  const window = options.window ?? 6
  if (!Number.isSafeInteger(window) || window < 1) {
    throw new TypeError(`searchPlateau: window must be a positive integer, got ${String(window)}`)
  }
  const sign = view.direction === 'maximize' ? 1 : -1
  const root = new Map(view.unitScores(view.rootNodeId).map((unit) => [unit.unitId, unit.mean]))
  const accepted: Array<{ nodeId: string; gain: number; pairs: number }> = []
  let squares = 0
  let degreesOfFreedom = 0
  for (const nodeId of view.screened) {
    if (nodeId === view.rootNodeId || !view.complete(nodeId)) continue
    const deltas: number[] = []
    for (const unit of view.unitScores(nodeId)) {
      const base = root.get(unit.unitId)
      if (base !== undefined) deltas.push(sign * (unit.mean - base))
    }
    if (deltas.length < 2) continue
    let total = 0
    for (const delta of deltas) total += delta
    const mean = total / deltas.length
    for (const delta of deltas) squares += (delta - mean) ** 2
    degreesOfFreedom += deltas.length - 1
    if (deltas.length >= DESCRIPTIVE_FROM_UNITS) {
      accepted.push({ nodeId, gain: mean, pairs: deltas.length })
    }
  }
  const pooledVariance = degreesOfFreedom > 0 ? squares / degreesOfFreedom : null
  const start = Math.max(0, accepted.length - window)
  let before: { nodeId: string; gain: number; pairs: number } | null = null
  for (const entry of accepted.slice(0, start)) {
    if (before === null || entry.gain > before.gain) before = entry
  }
  let best = before
  for (const entry of accepted.slice(start)) {
    if (best === null || entry.gain > best.gain) best = entry
  }
  const base = {
    window,
    accepted: accepted.length,
    windowNodes: accepted.slice(start).map((entry) => entry.nodeId),
    best: best === null ? null : { ...best, gain: round9(best.gain) },
    pooledVariance: pooledVariance === null ? null : round9(pooledVariance),
    degreesOfFreedom,
    method: PLATEAU_METHOD,
  }
  const insufficient = (reason: string): SearchPlateau => ({
    ...base,
    value: null,
    rise: null,
    noise: null,
    insufficient: reason,
  })
  if (accepted.length < window) {
    return insufficient(
      `${accepted.length} of ${window} accepted nodes (screened, no dodged unit, ${DESCRIPTIVE_FROM_UNITS} or more units shared with the root)`,
    )
  }
  if (pooledVariance === null || pooledVariance === 0) {
    return insufficient(
      pooledVariance === null
        ? 'no pooled between-unit variance'
        : 'every per-unit gain equals its node’s mean, so the noise is unmeasured',
    )
  }
  const leader = best!
  const rise = Math.max(0, leader.gain) - Math.max(0, before?.gain ?? 0)
  const noise = Math.sqrt(pooledVariance / leader.pairs)
  return {
    ...base,
    value: round9(rise / noise),
    rise: round9(rise),
    noise: round9(noise),
    insufficient: null,
  }
}
