/**
 * Simulator fidelity — score a user SIMULATOR's realism against real-user
 * trace distributions.
 *
 * Synthetic-persona evals (`PersonaConfig`-driven canonical evals, fuzz
 * user-simulator objectives) stand in for real users in most of the numbers
 * we publish. The standing threat is the Sim2Real gap: a simulator that is
 * distributionally unlike production creates "easy mode" and silently
 * inflates every score built on it. This module measures that gap from the
 * SAME artifact both sides already produce — `RunRecord`s — so no new
 * capture pipeline is needed:
 *
 *   - `simFidelityReport` — per-feature Jensen-Shannon divergence between
 *     simulated and production record distributions, collapsed into a
 *     fidelity coefficient in [0,1].
 *   - `easyModeCheck` — the headline academic failure mode (sim inflates
 *     pass-rate over production) as its own named artifact.
 *
 * Every synthetic-persona eval result should publish its fidelity
 * coefficient alongside the score — a number from an unrepresentative
 * simulator is an unlabeled estimate. Wire-in points:
 *
 *   - canonical persona evals: pass the campaign's `RunRecord`s as
 *     `simulated` and intake-adapter output (`contract/intake`: OTel spans,
 *     feedback tables, coding-agent sessions) as `production`
 *   - the fuzz user-sim objective: use `1 - report.fidelity` as a realism
 *     penalty when searching over generated personas
 *   - the durable corpus (`./corpus`): both sides read straight from
 *     `readCorpus` — tag sim vs production by `experimentId`
 */



import type { RunRecord } from '../run-record'



/** Extracts a flat behavioral feature map from one record. `string` values
 *  are categorical, `number` values are quantile-bucketed over the union of
 *  both sides, `null` means the feature is absent on this record and is
 *  counted explicitly as its own category (never silently dropped). */
export type BehaviorFeatures = (record: RunRecord) => Record<string, string | number | null>

















// ── Divergence core ──────────────────────────────────────────────────





/** Stable half-open bucket label for a value against quantile edges:
 *  `[-inf,e0)`, `[e0,e1)`, …, `[eLast,+inf)`. */
export function bucketLabel(value: number, edges: number[]): string {
  let i = 0
  while (i < edges.length && value >= edges[i]!) i++
  const lo = i === 0 ? '-inf' : String(edges[i - 1]!)
  const hi = i === edges.length ? '+inf' : String(edges[i]!)
  return `[${lo},${hi})`
}

// ── Fidelity report ──────────────────────────────────────────────────

export interface FeatureShift {
  /** Category label (a string value, a numeric bucket, or `ABSENT_CATEGORY`). */
  value: string
  /** Probability of this category among ALL simulated records (nulls included
   *  via `ABSENT_CATEGORY`, so each side's shifts sum to 1). */
  pSim: number
  /** Probability among ALL production records. */
  pProd: number
}

export interface FeatureDivergence {
  feature: string
  /** Jensen-Shannon divergence in [0,1] for this feature. */
  divergence: number
  /** Largest |pSim − pProd| categories, descending — where the sim deviates. */
  topShifts: FeatureShift[]
  /** Non-null observations on the simulated side. */
  nSim: number
  /** Non-null observations on the production side. */
  nProd: number
}

export type FidelityVerdict = 'representative' | 'skewed' | 'insufficient-data'

export interface FidelityReport {
  perDimension: FeatureDivergence[]
  /** 1 − mean divergence over features with sufficient data. NaN when the
   *  verdict is 'insufficient-data' — a 0 would read as "maximally skewed"
   *  and silently poison downstream aggregation; check `verdict` first. */
  fidelity: number
  /** Features excluded because either side had fewer than `minNPerFeature`
   *  non-null observations. Named, never silently dropped. */
  insufficientData: string[]
  /** 'representative' when fidelity >= REPRESENTATIVE_MIN_FIDELITY (0.8),
   *  'skewed' below, 'insufficient-data' when no feature met minN. */
  verdict: FidelityVerdict
}

export interface SimFidelityOptions {
  /** Feature extractor. Defaults to `defaultBehaviorFeatures`. */
  features?: BehaviorFeatures
  /** Minimum non-null observations per side per feature. Default 20. */
  minNPerFeature?: number
}









// ── Easy-mode check ──────────────────────────────────────────────────

export interface EasyModeOptions {
  /** A run passes when its score (holdout, else search) >= this. Default 0.5
   *  — matches the pass-threshold convention across the rl/ primitives. */
  passThreshold?: number
  /** Pass-rate gap above which the sim is flagged inflated. Default 0.1 —
   *  a 10-point inflation is enough to flip most promotion gates. */
  inflationTolerance?: number
}

export interface EasyModeReport {
  simPassRate: number
  prodPassRate: number
  /** simPassRate − prodPassRate. Positive = the simulator is easier than reality. */
  gap: number
  /** True when gap > inflationTolerance: numbers measured against this
   *  simulator overstate production performance. */
  inflated: boolean
}


