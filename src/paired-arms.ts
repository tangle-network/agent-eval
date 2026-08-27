/**
 * Matched-pair arm comparison — "did the treatment arm beat the baseline arm
 * on the SAME work items?"
 *
 * An arm A/B over run records is only trustworthy when it is PAIRED: the same
 * task/scenario/seed evaluated under both arms, compared item-by-item, so
 * inter-item difficulty variance cancels instead of masquerading as an arm
 * effect. This module owns the two error-prone steps every consumer otherwise
 * hand-rolls:
 *
 *   1. Pairing — matching rows across arms by `pairKey` (and by `repKey`
 *      within multi-rep items), with leftovers REPORTED rather than silently
 *      dropped (a silently unbalanced pairing biases every paired statistic
 *      downstream). Pairing never keys on outcome content: matching reps by
 *      their outcomes deflates discordant-pair counts and makes McNemar
 *      anti-conservative, so reps pair only by (`pairKey`, `repKey`) identity.
 *   2. Composition — feeding the matched pairs to the correct paired
 *      estimators that already live in `statistics`: `mcnemar` +
 *      `pairedRiskDifference` for pass/fail, `pairedBootstrap` +
 *      `wilcoxonSignedRank` for continuous metrics. No statistic is
 *      re-implemented here.
 *
 * The row shape is deliberately structural — callers project a `RunRecord`
 * (or any record) into `{ pairKey, arm, pass?, metrics? }`. Arm names are
 * caller-supplied parameters; the module ships no domain literal.
 */

import { ValidationError } from './errors'
import type { McNemarResult, PairedBootstrapOptions, PairedBootstrapResult } from './statistics'
import {
  mcnemar,
  pairedBootstrap,
  pairedRiskDifference,
  type RiskDifferenceResult,
  wilcoxonSignedRank,
} from './statistics'

/** One arm observation of one work item. Structural on purpose: callers
 *  project their own record type (e.g. a `RunRecord`) into this shape. */
export interface PairedArmRow {
  /** Matching key — rows sharing a `pairKey` across both arms form pairs
   *  (typically the task/scenario/seed identity). */
  pairKey: string
  /** Rep identity within a `pairKey` (e.g. a seed or rep number). Required on
   *  every row of a `pairKey` that has more than one rep in either arm; reps
   *  then pair only on exact (`pairKey`, `repKey`) match, never on outcome
   *  content. Optional when each arm has at most one rep of the item. */
  repKey?: string
  /** Arm label this row was produced under. */
  arm: string
  /** Binary outcome; omit when the comparison has no pass/fail notion. */
  pass?: boolean
  /** Named numeric measurements (score, cost, latency, …). */
  metrics?: Record<string, number>
}

export interface PairArmsOptions {
  /** Arm treated as the control side of every pair. */
  baselineArm: string
  /** Arm treated as the treatment side of every pair. */
  treatmentArm: string
}

/** One matched (baseline, treatment) observation of the same work item. */
export interface MatchedPair {
  pairKey: string
  /** 0-based position of this pair within its `pairKey`, ordered by sorted
   *  `repKey` (always 0 for a single-rep item). The rep identity itself is on
   *  the rows (`baseline.repKey` / `treatment.repKey`). */
  repIndex: number
  baseline: PairedArmRow
  treatment: PairedArmRow
}

export interface PairArmsResult {
  /** Matched pairs, ordered by (`pairKey`, `repIndex`). */
  pairs: MatchedPair[]
  /** Baseline rows left without a treatment counterpart — reported, never
   *  silently dropped. */
  unpairedBaseline: PairedArmRow[]
  /** Treatment rows left without a baseline counterpart. */
  unpairedTreatment: PairedArmRow[]
}

/**
 * Match rows across two arms into (baseline, treatment) pairs by `pairKey`.
 *
 * A `pairKey` with at most one row per arm pairs directly, no `repKey`
 * needed. A `pairKey` with multiple reps in either arm requires `repKey` on
 * every one of its rows, and reps pair only on exact (`pairKey`, `repKey`)
 * match — pairing is keyed purely on row identity, never on outcome content
 * (outcome-keyed matching deflates discordant counts and biases McNemar), and
 * is therefore independent of input order. Reps whose `repKey` has no
 * counterpart in the other arm, and items present in only one arm, land in
 * the unpaired lists — reported, never truncated.
 *
 * Fail-loud: throws when either named arm has zero rows (an unknown arm
 * name would otherwise read as "everything unpaired"), when the two arm
 * names are equal, when a multi-rep `pairKey` has a row without `repKey`, or
 * when a (`pairKey`, arm) group repeats a `repKey` (the match would be
 * ambiguous).
 */
export function pairArms(rows: readonly PairedArmRow[], opts: PairArmsOptions): PairArmsResult {
  const { baselineArm, treatmentArm } = opts
  if (baselineArm === treatmentArm) {
    throw new ValidationError(
      `pairArms: baselineArm and treatmentArm are both '${baselineArm}' — an arm cannot be compared to itself`,
    )
  }

  // arm → pairKey → rows
  const byArm = new Map<string, Map<string, PairedArmRow[]>>()
  const armsSeen = new Set<string>()
  for (const row of rows) {
    armsSeen.add(row.arm)
    if (row.arm !== baselineArm && row.arm !== treatmentArm) continue
    const byKey = byArm.get(row.arm) ?? new Map<string, PairedArmRow[]>()
    const group = byKey.get(row.pairKey) ?? []
    group.push(row)
    byKey.set(row.pairKey, group)
    byArm.set(row.arm, byKey)
  }

  for (const arm of [baselineArm, treatmentArm]) {
    if (!byArm.has(arm)) {
      const seen = [...armsSeen].sort().join(', ') || '<none>'
      throw new ValidationError(`pairArms: no rows for arm '${arm}' (arms present: ${seen})`)
    }
  }

  const baselineByKey = byArm.get(baselineArm)!
  const treatmentByKey = byArm.get(treatmentArm)!

  const allKeys = [...new Set([...baselineByKey.keys(), ...treatmentByKey.keys()])].sort()
  const pairs: MatchedPair[] = []
  const unpairedBaseline: PairedArmRow[] = []
  const unpairedTreatment: PairedArmRow[] = []
  for (const pairKey of allKeys) {
    const b = baselineByKey.get(pairKey) ?? []
    const t = treatmentByKey.get(pairKey) ?? []

    if (b.length <= 1 && t.length <= 1) {
      if (b.length === 1 && t.length === 1) {
        pairs.push({ pairKey, repIndex: 0, baseline: b[0]!, treatment: t[0]! })
      } else {
        unpairedBaseline.push(...b)
        unpairedTreatment.push(...t)
      }
      continue
    }

    const bByRep = indexByRepKey(b, pairKey, baselineArm)
    const tByRep = indexByRepKey(t, pairKey, treatmentArm)
    const repKeys = [...new Set([...bByRep.keys(), ...tByRep.keys()])].sort()
    let repIndex = 0
    for (const repKey of repKeys) {
      const baseline = bByRep.get(repKey)
      const treatment = tByRep.get(repKey)
      if (baseline !== undefined && treatment !== undefined) {
        pairs.push({ pairKey, repIndex: repIndex++, baseline, treatment })
      } else if (baseline !== undefined) {
        unpairedBaseline.push(baseline)
      } else if (treatment !== undefined) {
        unpairedTreatment.push(treatment)
      }
    }
  }

  return { pairs, unpairedBaseline, unpairedTreatment }
}

/** Index a multi-rep (pairKey, arm) group by `repKey`, enforcing that every
 *  row carries one and that no repKey repeats within the group. */
function indexByRepKey(
  group: readonly PairedArmRow[],
  pairKey: string,
  arm: string,
): Map<string, PairedArmRow> {
  const byRep = new Map<string, PairedArmRow>()
  for (const row of group) {
    if (row.repKey === undefined) {
      throw new ValidationError(
        `pairArms: pairKey '${pairKey}' has multiple reps in an arm, but a row in arm '${arm}' ` +
          `is missing repKey — multi-rep items require an explicit repKey on every row so reps ` +
          `pair by identity (pairing reps by outcome or by index would bias the paired statistics)`,
      )
    }
    if (byRep.has(row.repKey)) {
      throw new ValidationError(
        `pairArms: duplicate repKey '${row.repKey}' for pairKey '${pairKey}' in arm '${arm}' — ` +
          `(pairKey, repKey) must uniquely identify a rep within an arm`,
      )
    }
    byRep.set(row.repKey, row)
  }
  return byRep
}

/** Paired pass/fail comparison over the pairs where BOTH sides carry `pass`. */
export interface PairedCorrectness {
  /** Discordant pairs where the treatment passed and the baseline failed. */
  b10: number
  /** Discordant pairs where the baseline passed and the treatment failed. */
  b01: number
  /** Exact McNemar significance over the paired outcomes (`b === b10`, `c === b01`). */
  mcnemar: McNemarResult
  /** Paired effect size: p(treatment) − p(baseline) with a paired-variance CI. */
  riskDifference: RiskDifferenceResult
}

/** Paired delta summary for one named metric (delta = treatment − baseline). */
export interface PairedMetricDelta {
  name: string
  /** Pairs where BOTH sides carry a finite value for this metric. */
  n: number
  /** Pairs where at least one side does not carry the metric. */
  nMissing: number
  /** Median paired delta; NaN when `n === 0` (no data ≠ measured zero). */
  medianDelta: number
  /** Mean paired delta; NaN when `n === 0`. */
  meanDelta: number
  /** Bootstrap CI on the paired delta (`pairedBootstrap`); null when
   *  `n === 0` — a zero-width [0, 0] interval on no data would read as a
   *  measured tight null. */
  bootstrapCi: PairedBootstrapResult | null
  /** Wilcoxon signed-rank test on the paired deltas; null when `n === 0`. */
  wilcoxon: { w: number; p: number } | null
}

export interface ComparePairedArmsOptions extends PairArmsOptions {
  /** Metrics to compare. Default: every metric name observed on any matched
   *  pair, sorted. A name that appears on no pair is still reported (with
   *  `n = 0`) so a misspelled metric is visible instead of vanishing. */
  metricNames?: string[]
  /** Passed through to `pairedBootstrap` — set `seed` for reproducible CIs. */
  bootstrap?: PairedBootstrapOptions
}

export interface PairedArmsComparison {
  nPairs: number
  nUnpairedBaseline: number
  nUnpairedTreatment: number
  /** null when no matched pair carries `pass` on both sides — a pass/fail
   *  verdict over rows that never measured pass/fail would be fabricated. */
  correctness: PairedCorrectness | null
  metricDeltas: PairedMetricDelta[]
}

/**
 * Full matched-pair arm comparison: pair via {@link pairArms}, then compose
 * the paired estimators from `statistics` over the matched pairs.
 *
 * Correctness uses only the pairs where both sides carry `pass` (`mcnemar.n`
 * is that subset's size); each metric uses only the pairs where both sides
 * carry a finite value for it, with the remainder counted in `nMissing`.
 * Deltas are treatment − baseline throughout.
 *
 * Fail-loud: inherits {@link pairArms}'s unknown-arm throw, and throws on a
 * non-finite metric value — silently treating corrupt telemetry as "metric
 * absent" would misreport it as missing coverage.
 */
export function comparePairedArms(
  rows: readonly PairedArmRow[],
  opts: ComparePairedArmsOptions,
): PairedArmsComparison {
  const { pairs, unpairedBaseline, unpairedTreatment } = pairArms(rows, opts)

  let correctness: PairedCorrectness | null = null
  const baselinePass: number[] = []
  const treatmentPass: number[] = []
  for (const pair of pairs) {
    if (pair.baseline.pass === undefined || pair.treatment.pass === undefined) continue
    baselinePass.push(pair.baseline.pass ? 1 : 0)
    treatmentPass.push(pair.treatment.pass ? 1 : 0)
  }
  if (baselinePass.length > 0) {
    const mc = mcnemar(baselinePass, treatmentPass)
    correctness = {
      b10: mc.b,
      b01: mc.c,
      mcnemar: mc,
      riskDifference: pairedRiskDifference(baselinePass, treatmentPass),
    }
  }

  const metricNames =
    opts.metricNames ??
    [
      ...new Set(
        pairs.flatMap((p) => [
          ...Object.keys(p.baseline.metrics ?? {}),
          ...Object.keys(p.treatment.metrics ?? {}),
        ]),
      ),
    ].sort()

  const metricDeltas: PairedMetricDelta[] = metricNames.map((name) => {
    const before: number[] = []
    const after: number[] = []
    let nMissing = 0
    for (const pair of pairs) {
      const b = metricValue(pair.baseline, name)
      const t = metricValue(pair.treatment, name)
      if (b === undefined || t === undefined) {
        nMissing++
        continue
      }
      before.push(b)
      after.push(t)
    }
    const bootstrapCi = before.length === 0 ? null : pairedBootstrap(before, after, opts.bootstrap)
    return {
      name,
      n: before.length,
      nMissing,
      medianDelta: bootstrapCi === null ? Number.NaN : bootstrapCi.median,
      meanDelta: bootstrapCi === null ? Number.NaN : bootstrapCi.mean,
      bootstrapCi,
      wilcoxon: before.length === 0 ? null : wilcoxonSignedRank(before, after),
    }
  })

  return {
    nPairs: pairs.length,
    nUnpairedBaseline: unpairedBaseline.length,
    nUnpairedTreatment: unpairedTreatment.length,
    correctness,
    metricDeltas,
  }
}

function metricValue(row: PairedArmRow, name: string): number | undefined {
  const v = row.metrics?.[name]
  if (v === undefined) return undefined
  if (!Number.isFinite(v)) {
    throw new ValidationError(
      `comparePairedArms: non-finite value for metric '${name}' on pairKey '${row.pairKey}' (arm '${row.arm}'): ${v}`,
    )
  }
  return v
}
