/**
 * @experimental
 *
 * Agreement judge for teacher→student distillation. Scores a STUDENT artifact
 * (the cheap analyst's produced label) against the GoldScenario's gold label
 * (the teacher's verdict). The score IS the distillation objective: 1.0 means
 * the student reproduced the teacher exactly, 0.0 means total disagreement.
 *
 * The comparison function is INJECTED (`compareLabels`) so the judge is
 * domain-agnostic — distilling a skill-audit analyst, a triage analyst, or any
 * other student is a one-line comparator swap. A default `fieldAgreement`
 * comparator is provided for the common case: a flat verdict object with
 * categorical and array fields.
 *
 * Everything here is PURE + unit-testable — no LLM. (The student spends tokens
 * producing the artifact; scoring it against frozen gold does not.)
 */

import type { JudgeConfig, JudgeScore, Scenario } from '../types'
import type { GoldScenario } from './gold-scenarios'

/** What an injected comparator returns: a [0,1] composite plus the per-field
 *  (per-dimension) agreement breakdown the GEPA proposer reflects on to learn
 *  WHICH part of the verdict the student is getting wrong. */
export interface AgreementResult {
  /** Overall agreement in [0,1]. */
  score: number
  /** Per-dimension agreement in [0,1] — keyed by field/aspect name. The
   *  reflective proposer surfaces the weakest of these as the lever to fix. */
  dimensions: Record<string, number>
}

/** Compare a produced label against a gold label → agreement. Injected so the
 *  judge is domain-agnostic. */
export type CompareLabels<TProduced = unknown, TLabel = unknown> = (
  produced: TProduced,
  gold: TLabel,
) => AgreementResult

export interface BuildAgreementJudgeOptions<TProduced = unknown, TLabel = unknown> {
  /** Judge name surfaced in `CampaignResult.aggregates.byJudge` + the gate. */
  name?: string
  /** The agreement function — produced student label vs gold teacher label. */
  compareLabels: CompareLabels<TProduced, TLabel>
  /** Dimension keys the judge declares up-front (for `JudgeConfig.dimensions`).
   *  When omitted, the dimensions present on the first scored result are used
   *  for display only; the composite is unaffected. */
  dimensionKeys?: string[]
  /** Only score `gold`-kind scenarios. Default true — a mixed campaign won't
   *  mis-apply the agreement judge to non-gold scenarios. */
  goldOnly?: boolean
}

const AGREEMENT_DIM = 'agreement'

/** Build a `JudgeConfig` that scores a produced student artifact against the
 *  scenario's gold label. Conforms to the substrate `JudgeConfig` contract:
 *  `score({artifact, scenario, signal}) => JudgeScore`. The `composite` is the
 *  comparator's `score`; `dimensions` carries its per-field breakdown plus the
 *  scalar `agreement` so a single-dimension consumer still sees the number. */
export function buildAgreementJudge<TProduced, TInput, TLabel>(
  options: BuildAgreementJudgeOptions<TProduced, TLabel>,
): JudgeConfig<TProduced, GoldScenario<TInput, TLabel>> {
  const name = options.name ?? 'gold-agreement'
  const goldOnly = options.goldOnly ?? true
  const declaredDims = options.dimensionKeys ?? [AGREEMENT_DIM]
  return {
    name,
    dimensions: declaredDims.map((key) => ({
      key,
      description: `Per-field agreement between the produced label and the gold label on '${key}'`,
    })),
    appliesTo: goldOnly ? (scenario: Scenario) => scenario.kind === 'gold' : undefined,
    score({ artifact, scenario }): JudgeScore {
      const { score, dimensions } = options.compareLabels(artifact, scenario.label)
      if (!Number.isFinite(score) || score < 0 || score > 1) {
        throw new Error(
          `buildAgreementJudge: comparator returned out-of-range score ${score} for scenario '${scenario.id}' (must be in [0,1])`,
        )
      }
      // Surface the scalar under `agreement` too, so a consumer reading a
      // single dimension always finds the headline number even when the
      // comparator named its fields differently.
      const outDims: Record<string, number> = { [AGREEMENT_DIM]: score, ...dimensions }
      const weakest = Object.entries(dimensions).sort((a, b) => a[1] - b[1])[0]
      const notes = weakest
        ? `agreement ${score.toFixed(3)}; weakest field '${weakest[0]}' (${weakest[1].toFixed(3)})`
        : `agreement ${score.toFixed(3)}`
      return { composite: score, dimensions: outDims, notes }
    },
  }
}

export interface FieldAgreementSpec {
  /** Categorical fields — scored exact-match (1 if equal, else 0). Compared
   *  with `===` after `JSON`-normalizing so `true`/`'high'`/`3` all work. */
  categorical?: string[]
  /** Array fields — scored by Jaccard overlap (|A∩B| / |A∪B|). Two empty
   *  arrays agree perfectly (1.0). Order-insensitive; elements compared by
   *  their `JSON.stringify`. */
  array?: string[]
}

/** Default comparator: average per-field agreement over a flat verdict object.
 *  Categorical fields score exact-match; array fields score set-overlap
 *  (Jaccard). The composite is the unweighted mean across all declared fields,
 *  so missing a single boolean (e.g. `public_leak_risk`) costs `1/nFields` of
 *  the score — the leak-detection lever the audit cares about is a real,
 *  non-trivial fraction of the objective, not rounding noise.
 *
 *  Pure. A field absent from BOTH produced + gold is treated as agreeing
 *  (both undefined ⇒ 1.0); a field present in only one side disagrees. */
export function fieldAgreement<TProduced extends Record<string, unknown>, TLabel>(
  spec: FieldAgreementSpec,
): CompareLabels<TProduced, TLabel> {
  const categorical = spec.categorical ?? []
  const array = spec.array ?? []
  if (categorical.length === 0 && array.length === 0) {
    throw new Error('fieldAgreement: at least one categorical or array field is required')
  }
  return (produced, gold) => {
    const p = (produced ?? {}) as Record<string, unknown>
    const g = (gold ?? {}) as Record<string, unknown>
    const dimensions: Record<string, number> = {}
    for (const field of categorical) {
      dimensions[field] = categoricalAgreement(p[field], g[field])
    }
    for (const field of array) {
      dimensions[field] = jaccard(asArray(p[field]), asArray(g[field]))
    }
    const values = Object.values(dimensions)
    const score = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
    return { score, dimensions }
  }
}

function categoricalAgreement(produced: unknown, gold: unknown): number {
  if (produced === undefined && gold === undefined) return 1
  // Normalize so primitives compare by value regardless of source typing
  // (e.g. a produced boolean vs a gold boolean parsed from JSON).
  return normalizeScalar(produced) === normalizeScalar(gold) ? 1 : 0
}

function normalizeScalar(value: unknown): string {
  // Sentinels carry a leading '\0'-free marker JSON.stringify never produces
  // (its output of any value starts with a quote, brace, bracket, digit, or
  // -/t/f/n) so they can't collide with a real stringified value.
  if (value === undefined) return '__undefined__'
  if (value === null) return '__null__'
  return JSON.stringify(value)
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  return [value]
}

/** Jaccard similarity over two multisets compared by `JSON.stringify` of each
 *  element. Two empty sets ⇒ 1.0 (perfect agreement on "nothing"). */
function jaccard(a: unknown[], b: unknown[]): number {
  const sa = new Set(a.map((x) => JSON.stringify(x)))
  const sb = new Set(b.map((x) => JSON.stringify(x)))
  if (sa.size === 0 && sb.size === 0) return 1
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 1 : inter / union
}
