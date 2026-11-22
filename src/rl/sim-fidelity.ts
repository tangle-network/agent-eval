/**
 * Simulator fidelity report shapes: per-feature divergence between simulated
 * and production `RunRecord` distributions, and the easy-mode pass-rate gap,
 * with `bucketLabel` for numeric features. The functions that computed them
 * were removed with their last consumer; these types remain for records that
 * carry such reports.
 *
 * To measure how real a simulated user is, use `measureSimulatorRealism` from
 * `/multishot`: it writes the simulator's next message at recorded real user
 * turns and asks a calibrated judge which of the two the real user wrote.
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
