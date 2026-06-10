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

import { ValidationError } from '../errors'
import type { RunRecord } from '../run-record'
import type { FailureClass } from '../trace/schema'
import type { CorpusRecord } from './corpus'

/** Extracts a flat behavioral feature map from one record. `string` values
 *  are categorical, `number` values are quantile-bucketed over the union of
 *  both sides, `null` means the feature is absent on this record and is
 *  counted explicitly as its own category (never silently dropped). */
export type BehaviorFeatures = (record: RunRecord) => Record<string, string | number | null>

/** Reserved histogram category for `null` feature values. A capture-rate
 *  difference (one side instruments a signal, the other does not) registers
 *  as divergence by design: a simulator that produces no tool traces is not
 *  representative of production that does. */
export const ABSENT_CATEGORY = '(absent)'

/** Minimum non-null observations PER SIDE for a feature to enter the
 *  fidelity mean. Below this the JSD estimate is sampling noise. */
export const DEFAULT_MIN_N_PER_FEATURE = 20

/** Quantile buckets used to discretize numeric features. Quartiles balance
 *  resolution against per-bucket sample size at the default minN. */
export const DEFAULT_QUANTILE_BUCKETS = 4

/** Fidelity at or above this → 'representative'; below → 'skewed'.
 *  1 − 0.8 = mean JSD 0.2 ≈ distributions that mostly overlap with one
 *  clearly shifted mode — the point where per-feature shifts start changing
 *  which failure classes an eval can even observe. */
export const REPRESENTATIVE_MIN_FIDELITY = 0.8

const TOP_SHIFT_COUNT = 5

/**
 * Default feature set — ONLY fields verified present on both simulated and
 * production records:
 *
 *   - `score`, `wall_ms`, `output_tokens` — mandatory per the `RunRecord`
 *     validator (non-finite values read as absent rather than poisoning a
 *     bucket).
 *   - `failure_class` — optional taxonomy field; absent counted explicitly.
 *   - `turn_count`, `tool_errors`, `tool_error_recovery` — derived from the
 *     `outcome.raw` counters the intake adapters and eval harnesses write
 *     (`turns_completed`, `assistant_messages`, `tool_errors`,
 *     `turns_aborted`); absent on records whose producer did not capture
 *     them, counted explicitly.
 *   - `completion_length` — from the optional `CorpusRecord` trajectory
 *     text; the message-length proxy when records come from the corpus.
 *
 * `RunRecord` carries event COUNTS, not event ordering, so
 * `tool_error_recovery` is a counts-only derivation: errors occurred and the
 * run still completed cleanly ('recovered') vs aborted or classified as a
 * failure ('unrecovered') — not a literal error→retry sequence check.
 */
export const defaultBehaviorFeatures: BehaviorFeatures = (record) => {
  const raw: Record<string, number> = record.outcome?.raw ?? {}
  const toolErrors = finiteOrNull(raw.tool_errors)
  const turnsAborted = finiteOrNull(raw.turns_aborted)
  const completion = (record as CorpusRecord).completion
  return {
    score: finiteOrNull(record.outcome?.holdoutScore) ?? finiteOrNull(record.outcome?.searchScore),
    failure_class: record.failureClass ?? null,
    wall_ms: finiteOrNull(record.wallMs),
    output_tokens: finiteOrNull(record.tokenUsage?.output),
    turn_count: finiteOrNull(raw.turns_completed) ?? finiteOrNull(raw.assistant_messages),
    tool_errors: toolErrors,
    tool_error_recovery: toolErrorRecovery(toolErrors, turnsAborted, record.failureClass),
    completion_length: typeof completion === 'string' ? completion.length : null,
  }
}

function toolErrorRecovery(
  toolErrors: number | null,
  turnsAborted: number | null,
  failureClass: FailureClass | undefined,
): string | null {
  if (toolErrors === null) return null
  if (toolErrors === 0) return 'no-tool-errors'
  const failed =
    (turnsAborted ?? 0) > 0 || (failureClass !== undefined && failureClass !== 'success')
  return failed ? 'unrecovered' : 'recovered'
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// ── Divergence core ──────────────────────────────────────────────────

/**
 * Jensen-Shannon divergence between two categorical histograms (raw counts;
 * normalized internally). Log base 2 → bounded [0,1]: 0 = identical
 * distributions, 1 = disjoint support. Symmetric, defined even where the
 * supports differ — exactly the regime sim-vs-production comparison lives in.
 * Throws on zero-mass or negative/non-finite counts: an empty histogram has
 * no distribution and a silent 0 would read as "perfectly representative".
 */
export function jsDivergence(p: Record<string, number>, q: Record<string, number>): number {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)])
  if (keys.size === 0) {
    throw new ValidationError('jsDivergence: both histograms are empty')
  }
  let pSum = 0
  let qSum = 0
  for (const key of keys) {
    const pv = p[key] ?? 0
    const qv = q[key] ?? 0
    if (!Number.isFinite(pv) || !Number.isFinite(qv) || pv < 0 || qv < 0) {
      throw new ValidationError(`jsDivergence: negative or non-finite count for category "${key}"`)
    }
    pSum += pv
    qSum += qv
  }
  if (pSum === 0 || qSum === 0) {
    throw new ValidationError('jsDivergence: a histogram with zero total mass has no distribution')
  }
  let divergence = 0
  for (const key of keys) {
    const pp = (p[key] ?? 0) / pSum
    const qp = (q[key] ?? 0) / qSum
    const m = (pp + qp) / 2
    if (pp > 0) divergence += 0.5 * pp * Math.log2(pp / m)
    if (qp > 0) divergence += 0.5 * qp * Math.log2(qp / m)
  }
  // float error can land epsilon outside [0,1]
  return Math.min(1, Math.max(0, divergence))
}

/**
 * Deterministic quantile edges over a value set (the UNION of both sides, so
 * sim and production land in the same buckets). Linear interpolation between
 * order statistics; duplicate edges from heavy ties collapse into fewer,
 * wider buckets. Returns `bucketCount - 1` edges before deduplication.
 */
export function quantileEdges(values: number[], bucketCount = DEFAULT_QUANTILE_BUCKETS): number[] {
  if (values.length === 0) {
    throw new ValidationError('quantileEdges: requires at least one value')
  }
  if (!Number.isInteger(bucketCount) || bucketCount < 2) {
    throw new ValidationError(
      `quantileEdges: bucketCount must be an integer >= 2, got ${bucketCount}`,
    )
  }
  const sorted = [...values].sort((a, b) => a - b)
  const edges: number[] = []
  for (let k = 1; k < bucketCount; k++) {
    const pos = (k / bucketCount) * (sorted.length - 1)
    const lo = sorted[Math.floor(pos)]!
    const hi = sorted[Math.ceil(pos)]!
    edges.push(lo + (pos - Math.floor(pos)) * (hi - lo))
  }
  return [...new Set(edges)]
}

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

/**
 * Compare a simulator's RunRecords against production RunRecords, feature by
 * feature. Numeric features are bucketed by deterministic quantiles of the
 * union; nulls count as an explicit `ABSENT_CATEGORY`. Throws on empty
 * inputs — "no records" is a wiring error, not a distribution.
 */
export function simFidelityReport(
  simulated: RunRecord[],
  production: RunRecord[],
  opts: SimFidelityOptions = {},
): FidelityReport {
  if (simulated.length === 0) {
    throw new ValidationError('simFidelityReport: simulated records are empty')
  }
  if (production.length === 0) {
    throw new ValidationError('simFidelityReport: production records are empty')
  }
  const extract = opts.features ?? defaultBehaviorFeatures
  const minN = opts.minNPerFeature ?? DEFAULT_MIN_N_PER_FEATURE

  const simMaps = simulated.map(extract)
  const prodMaps = production.map(extract)

  // union of feature names in first-seen order — extractors may emit
  // different keys per record (e.g. domain-conditional features)
  const featureNames: string[] = []
  const seen = new Set<string>()
  for (const map of [...simMaps, ...prodMaps]) {
    for (const name of Object.keys(map)) {
      if (!seen.has(name)) {
        seen.add(name)
        featureNames.push(name)
      }
    }
  }

  const perDimension: FeatureDivergence[] = []
  const insufficientData: string[] = []

  for (const feature of featureNames) {
    const simVals = simMaps.map((m) => m[feature] ?? null)
    const prodVals = prodMaps.map((m) => m[feature] ?? null)
    const nSim = simVals.filter((v) => v !== null).length
    const nProd = prodVals.filter((v) => v !== null).length
    if (nSim < minN || nProd < minN) {
      insufficientData.push(feature)
      continue
    }
    const { sim, prod } = histograms(feature, simVals, prodVals)
    perDimension.push({
      feature,
      divergence: jsDivergence(sim, prod),
      topShifts: topShifts(sim, simVals.length, prod, prodVals.length),
      nSim,
      nProd,
    })
  }

  if (perDimension.length === 0) {
    return { perDimension, fidelity: Number.NaN, insufficientData, verdict: 'insufficient-data' }
  }
  const fidelity = 1 - perDimension.reduce((sum, d) => sum + d.divergence, 0) / perDimension.length
  return {
    perDimension,
    fidelity,
    insufficientData,
    verdict: fidelity >= REPRESENTATIVE_MIN_FIDELITY ? 'representative' : 'skewed',
  }
}

type FeatureValue = string | number | null

function histograms(
  feature: string,
  simVals: FeatureValue[],
  prodVals: FeatureValue[],
): { sim: Record<string, number>; prod: Record<string, number> } {
  const kinds = new Set<string>()
  for (const v of [...simVals, ...prodVals]) {
    if (v !== null) kinds.add(typeof v)
  }
  if (kinds.size > 1) {
    throw new ValidationError(
      `simFidelityReport: feature "${feature}" mixes string and number values — an extractor must return one kind per feature`,
    )
  }
  let toCategory: (v: string | number) => string
  if (kinds.has('number')) {
    const union: number[] = []
    for (const v of [...simVals, ...prodVals]) {
      if (v !== null) union.push(v as number)
    }
    const edges = quantileEdges(union)
    toCategory = (v) => bucketLabel(v as number, edges)
  } else {
    toCategory = (v) => v as string
  }
  const count = (vals: FeatureValue[]): Record<string, number> => {
    const hist: Record<string, number> = {}
    for (const v of vals) {
      const key = v === null ? ABSENT_CATEGORY : toCategory(v)
      hist[key] = (hist[key] ?? 0) + 1
    }
    return hist
  }
  return { sim: count(simVals), prod: count(prodVals) }
}

function topShifts(
  sim: Record<string, number>,
  simTotal: number,
  prod: Record<string, number>,
  prodTotal: number,
): FeatureShift[] {
  const keys = [...new Set([...Object.keys(sim), ...Object.keys(prod)])]
  const shifts = keys.map((value) => ({
    value,
    pSim: (sim[value] ?? 0) / simTotal,
    pProd: (prod[value] ?? 0) / prodTotal,
  }))
  shifts.sort((a, b) => {
    const delta = Math.abs(b.pSim - b.pProd) - Math.abs(a.pSim - a.pProd)
    return delta !== 0 ? delta : a.value.localeCompare(b.value)
  })
  return shifts.slice(0, TOP_SHIFT_COUNT)
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

/**
 * The headline simulator failure mode as its own named artifact: a simulator
 * that creates "easy mode" inflates pass-rate relative to production, and
 * every score measured against it overstates reality. Throws on empty inputs
 * and on records carrying neither score — a silently-skipped record would
 * bias the very rate this check exists to keep honest.
 */
export function easyModeCheck(
  simulated: RunRecord[],
  production: RunRecord[],
  opts: EasyModeOptions = {},
): EasyModeReport {
  if (simulated.length === 0) {
    throw new ValidationError('easyModeCheck: simulated records are empty')
  }
  if (production.length === 0) {
    throw new ValidationError('easyModeCheck: production records are empty')
  }
  const threshold = opts.passThreshold ?? 0.5
  const tolerance = opts.inflationTolerance ?? 0.1
  const passRate = (records: RunRecord[], side: string): number => {
    let passes = 0
    for (const r of records) {
      const score = finiteOrNull(r.outcome?.holdoutScore) ?? finiteOrNull(r.outcome?.searchScore)
      if (score === null) {
        throw new ValidationError(
          `easyModeCheck: ${side} run "${r.runId}" carries neither holdoutScore nor searchScore`,
        )
      }
      if (score >= threshold) passes++
    }
    return passes / records.length
  }
  const simPassRate = passRate(simulated, 'simulated')
  const prodPassRate = passRate(production, 'production')
  const gap = simPassRate - prodPassRate
  return { simPassRate, prodPassRate, gap, inflated: gap > tolerance }
}
