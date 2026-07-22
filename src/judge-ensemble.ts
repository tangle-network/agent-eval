/**
 * Judge-ensemble reducer — folds N independent judge verdicts on the same
 * artifact into one aggregate score.
 *
 * The pattern every multi-model judge re-implements: run K uncorrelated judges
 * (different model families remove within-family bias), then reduce their
 * per-dimension verdicts to a single composite + an inter-rater disagreement
 * signal. This is the pure reduction — no LLM, no I/O — so a lift it produces
 * is attributable to the scores, not to where they came from.
 *
 * Fail-loud: a judge that errored or returned malformed output is recorded in
 * `failedJudges` with `perDimension: null`, never folded into a zero. If EVERY
 * judge failed the reducer throws — a silent zero here would corrupt the result.
 */

import type { LlmUsage } from './llm-client'
import { clamp01 } from './run-score'
import { weightedComposite } from './statistics'

/** One judge's verdict. `perDimension: null` ⇒ that judge call failed (threw or
 *  returned malformed output) — recorded, never folded into a zero. */
export interface JudgeVerdict<D extends string = string> {
  /** Judge identity (typically the model id) — the `perJudge` / `failedJudges` key. */
  model: string
  /** Per-dimension scores, or `null` when the judge failed. */
  perDimension: Record<D, number> | null
  /** Optional one-line rationale; the first non-empty one becomes the aggregate's. */
  rationale?: string
  /** Optional reported cost, committed by the caller's CostLedger. */
  costUsd?: number
  /** Optional provider usage, committed by the caller's CostLedger. */
  usage?: LlmUsage
  /** Optional per-dimension reasoning/evidence. Carried through to
   *  `EnsembleAggregate.verdicts` verbatim — never folded into the math. */
  detail?: Partial<Record<D, { reasoning?: string; evidence?: string }>>
}

/** The aggregated ensemble result. */
export interface EnsembleAggregate<D extends string = string> {
  /** Mean over SURVIVING judges, per dimension (absent-everywhere ⇒ 0). */
  perDimension: Record<D, number>
  /** Weighted mean of `perDimension` (uniform unless `weights` given). */
  composite: number
  /** Each surviving judge's clamped per-dimension scores, for trace drill-down. */
  perJudge: Record<string, Record<D, number>>
  /** Max over dimensions of (max − min) across survivors — the inter-rater signal. */
  maxDisagreement: number
  /** Models whose verdict was null (failed). */
  failedJudges: string[]
  /** First non-empty survivor rationale, or `'llm-judge'`. */
  rationale: string
  /** The input verdicts, verbatim — drill-down to raw scores, `detail`
   *  reasoning/evidence, and per-verdict cost without re-running judges. */
  verdicts: JudgeVerdict<D>[]
}

/**
 * Reduce per-judge verdicts to one aggregate. Generic over the rubric: pass the
 * stable-ordered `dimensionKeys` the judges scored.
 *
 * - Per-dimension score = mean over surviving judges (out-of-range clamped to [0,1]).
 * - `composite` = `weightedComposite` of `perDimension`. No `weights` ⇒ uniform
 *   over every dimension. A partial `weights` map selects AND weights exactly the
 *   named dimensions (others excluded from the composite) — the substrate's
 *   sum-normalized weighting, not re-implemented here.
 * - Throws if `verdicts` or `dimensionKeys` is empty, or if every judge failed.
 */
export function aggregateJudgeVerdicts<D extends string>(
  verdicts: readonly JudgeVerdict<D>[],
  dimensionKeys: readonly D[],
  weights?: Partial<Record<D, number>>,
): EnsembleAggregate<D> {
  if (verdicts.length === 0) {
    throw new Error('aggregateJudgeVerdicts: no verdicts to aggregate')
  }
  if (dimensionKeys.length === 0) {
    throw new Error('aggregateJudgeVerdicts: dimensionKeys is empty')
  }

  const perJudge: Record<string, Record<D, number>> = {}
  const failedJudges: string[] = []
  const dimAcc = {} as Record<D, number[]>
  for (const d of dimensionKeys) dimAcc[d] = []
  let rationale = ''

  // Same model sampled k times (best-of-N judging) gets keys 'm', 'm#2',
  // 'm#3'… so repeat votes land as distinct perJudge/failedJudges entries
  // instead of overwriting each other.
  const seenCount = new Map<string, number>()
  const keyFor = (model: string): string => {
    const n = (seenCount.get(model) ?? 0) + 1
    seenCount.set(model, n)
    return n === 1 ? model : `${model}#${n}`
  }

  for (const v of verdicts) {
    const key = keyFor(v.model)
    if (!v.perDimension) {
      failedJudges.push(key)
      continue
    }
    const dims = {} as Record<D, number>
    for (const d of dimensionKeys) dims[d] = clamp01(Number(v.perDimension[d]))
    perJudge[key] = dims
    for (const d of dimensionKeys) dimAcc[d].push(dims[d])
    if (!rationale && typeof v.rationale === 'string' && v.rationale) rationale = v.rationale
  }

  if (failedJudges.length === verdicts.length) {
    throw new Error(`aggregateJudgeVerdicts: all ${verdicts.length} judges failed`)
  }

  const perDimension = {} as Record<D, number>
  for (const d of dimensionKeys) {
    const vals = dimAcc[d]
    perDimension[d] = vals.length === 0 ? 0 : vals.reduce((s, x) => s + x, 0) / vals.length
  }

  let maxDisagreement = 0
  for (const d of dimensionKeys) {
    const vals = dimAcc[d]
    if (vals.length < 2) continue
    const spread = Math.max(...vals) - Math.min(...vals)
    if (spread > maxDisagreement) maxDisagreement = spread
  }

  const w: Record<string, number> = {}
  if (weights) {
    for (const [d, weight] of Object.entries(weights)) {
      if (weight !== undefined) w[d] = weight as number
    }
  } else {
    for (const d of dimensionKeys) w[d] = 1 / dimensionKeys.length
  }
  const composite = weightedComposite({ dims: perDimension, weights: w }).composite

  return {
    perDimension,
    composite,
    perJudge,
    maxDisagreement,
    failedJudges,
    rationale: rationale || 'llm-judge',
    verdicts: [...verdicts],
  }
}
