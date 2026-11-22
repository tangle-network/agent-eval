/**
 * The subset of admitted measures to climb, the guards kept unoptimized beside
 * it, and the check that a climbed measure has not drifted away from them.
 *
 * Selection reads only changes before the cut: each candidate is standardized
 * by its before-cut median and robust scale and aligned to its direction, and
 * greedy forward selection adds the measure that most raises the equal-weight
 * composite's statistic, skipping a candidate redundant with one already
 * climbed. Equal weights are deliberate: fitted weights on a few hundred
 * changes overfit, and unit weights lose little when measures share a cause.
 */

import { ValidationError } from '../errors'
import type {
  MeasureValidityOutcome,
  MeasureValidityPlan,
} from '../experiment/measure-validity-plan'
import {
  associationEstimate,
  type ClusteredAssociation,
  clusteredAssociation,
} from '../statistics/clustered-association'
import { spearmanR } from '../statistics/descriptive'
import { sampleMedian } from '../statistics/samples'
import { clusterBootstrapMean } from './cluster-bootstrap'
import {
  eligibleObservations,
  joinOutcomes,
  type MeasuredChange,
  type PreparedChange,
  statisticOf,
  validateChanges,
} from './measure-records'
import type { MeasureOutcomeValidity, MeasureValidityReport } from './measure-validity'
import { groupOutcomesByRun } from './outcome-observations'
import type { OutcomeStore } from './outcome-store'

export interface MeasureReference {
  /** Before-cut median and robust scale; `z = direction * (x - center) / scale`. */
  center: number
  scale: number
  /** Mean of the aligned `z` before the cut. */
  meanZ: number
}

export interface ClimbedMeasure {
  measure: string
  direction: 'higher' | 'lower'
  /** Gain the measure added to the before-cut composite statistic; the first is its gain over the null. */
  preCutGain: number
  postCutEstimate: number
  leadTimeMs: { median: number; min: number; max: number } | null
  cost: number | null
  reference: MeasureReference
}

export interface GuardMeasure {
  measure: string
  direction: 'higher' | 'lower'
  reason: 'redundant' | 'no-gain' | 'size-limit'
  redundantWith: string | null
  /** Largest absolute before-cut rank correlation with a climbed measure. */
  correlation: number | null
  reference: MeasureReference
}

export interface MeasureSelection {
  outcome: string
  climb: ClimbedMeasure[]
  /** Admitted measures to keep unoptimized; a climbed measure drifting away from them is visible. */
  guards: GuardMeasure[]
  /**
   * Measures admitted on the pooled test that cannot be climbed: the outcome's
   * exposure itself, measures that predict only by tracking it, only across
   * units, that do not move under change or move against the outcome, or
   * whose after-cut estimate (inside exposure bins when the outcome has an
   * exposure) is closer to the null than `selection.minEffect`.
   */
  excluded: Array<{
    measure: string
    reason:
      | 'exposure'
      | 'through-exposure'
      | 'pooled-only'
      | 'insensitive'
      | 'moves-against-outcome'
      | 'below-minimum-effect'
  }>
  /**
   * Equal-weight mean of the climbed measures' aligned z. The post-cut score
   * reads the changes admission read, so it describes the subset; the next
   * batch is its independent check.
   */
  composite: {
    preCut: { n: number; estimate: number } | null
    postCut: ClusteredAssociation | null
  }
  /** Before-cut outcome reference for drift checks on later batches. */
  outcomeReference:
    | { kind: 'binary'; betterRate: number }
    | { kind: 'continuous'; center: number; scale: number; meanZ: number }
    | null
}

// ── Guard drift ──────────────────────────────────────────────────────

export interface GuardDriftInput {
  report: MeasureValidityReport
  outcome: string
  /** Changes made after the study, read against the study's before-cut references. */
  batch: readonly MeasuredChange[]
  /** Largest rise of a climbed measure over its guards, in before-cut scale units, that is not drift. */
  tolerance: number
  /** Outcomes for the batch, when known; drift itself needs none. */
  outcomes?: OutcomeStore
}

export interface GuardDriftInterval {
  n: number
  units: number
  estimate: number
  low: number
  high: number
}

export interface GuardDriftMeasure {
  measure: string
  status: 'drift' | 'within-tolerance' | 'insufficient'
  /** The climbed measure's aligned z, minus its before-cut mean. */
  shift: GuardDriftInterval | null
  /** The mean of its guards' aligned z, each minus its before-cut mean. */
  guardShift: GuardDriftInterval | null
  /** Per change, shift minus guard shift: drift when its lower bound exceeds the tolerance. */
  divergence: GuardDriftInterval | null
}

export interface GuardDriftReport {
  outcome: string
  guards: string[]
  status: 'drift' | 'no-drift' | 'no-guards' | 'insufficient'
  measures: GuardDriftMeasure[]
  /** Better-outcome rate minus the before-cut rate (binary), or the aligned z shift (continuous). */
  outcomeShift: GuardDriftInterval | null
}

/**
 * Whether a climbed measure rose while its guards did not, in a batch of
 * later changes. Guards are measured at change time, so this reads before the
 * outcome arrives; the outcome shift is reported when the batch has outcomes.
 */
export async function guardDrift(input: GuardDriftInput): Promise<GuardDriftReport> {
  const { report, tolerance } = input
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new ValidationError('guardDrift: tolerance must be finite and nonnegative')
  }
  const selection = report.selections.find((row) => row.outcome === input.outcome)
  if (!selection) {
    throw new ValidationError(
      `guardDrift: the report has no selection for outcome ${input.outcome}`,
    )
  }
  const plan = report.plan
  validateChanges(input.batch, plan, false)
  const guards = selection.guards
  const interval = (rows: Array<{ unit: string; value: number }>): GuardDriftInterval | null => {
    const units = new Set(rows.map((row) => row.unit)).size
    if (rows.length === 0 || units < plan.minUnits) return null
    const result = clusterBootstrapMean(
      rows.map((row) => ({ cluster: row.unit, value: row.value })),
      {
        confidence: plan.confidence,
        resamples: plan.resamples,
        ...(plan.seed === undefined ? {} : { seed: plan.seed }),
      },
    )
    return { n: rows.length, units, estimate: result.mean, low: result.low, high: result.high }
  }
  const centered = (
    change: MeasuredChange,
    measure: string,
    direction: 'higher' | 'lower',
    reference: MeasureReference,
  ) => {
    const value = change.measures[measure]
    return value === undefined ? null : alignedZ(value, direction, reference) - reference.meanZ
  }

  const measures: GuardDriftMeasure[] = selection.climb.map((climbed) => {
    const shiftRows: Array<{ unit: string; value: number }> = []
    const guardRows: Array<{ unit: string; value: number }> = []
    const divergenceRows: Array<{ unit: string; value: number }> = []
    for (const change of input.batch) {
      const own = centered(change, climbed.measure, climbed.direction, climbed.reference)
      const guardValues = guards
        .map((guard) => centered(change, guard.measure, guard.direction, guard.reference))
        .filter((value): value is number => value !== null)
      if (own !== null) shiftRows.push({ unit: change.unit, value: own })
      if (guardValues.length === 0) continue
      const guardMean = guardValues.reduce((sum, value) => sum + value, 0) / guardValues.length
      guardRows.push({ unit: change.unit, value: guardMean })
      if (own !== null) divergenceRows.push({ unit: change.unit, value: own - guardMean })
    }
    const divergence = guards.length === 0 ? null : interval(divergenceRows)
    return {
      measure: climbed.measure,
      status:
        divergence === null
          ? 'insufficient'
          : divergence.low > tolerance
            ? 'drift'
            : 'within-tolerance',
      shift: interval(shiftRows),
      guardShift: guards.length === 0 ? null : interval(guardRows),
      divergence,
    }
  })

  let outcomeShift: GuardDriftInterval | null = null
  const outcomeSpec = plan.outcomes.find((row) => row.id === input.outcome)!
  const reference = selection.outcomeReference
  if (input.outcomes && reference) {
    const byRun = groupOutcomesByRun(await input.outcomes.list())
    const rows: Array<{ unit: string; value: number }> = []
    for (const change of input.batch) {
      const { eligible } = eligibleObservations(byRun.get(change.id) ?? [], change, plan, false)
      const joined = joinOutcomes(eligible, change, [outcomeSpec], plan.reduction).get(
        outcomeSpec.id,
      )
      if (!joined) continue
      rows.push({
        unit: change.unit,
        value:
          reference.kind === 'binary'
            ? joined.better - reference.betterRate
            : (joined.better - reference.center) / reference.scale - reference.meanZ,
      })
    }
    outcomeShift = interval(rows)
  }

  return {
    outcome: input.outcome,
    guards: guards.map((guard) => guard.measure),
    status:
      selection.climb.length === 0 || guards.length === 0
        ? 'no-guards'
        : measures.some((row) => row.status === 'drift')
          ? 'drift'
          : measures.every((row) => row.status === 'insufficient')
            ? 'insufficient'
            : 'no-drift',
    measures,
    outcomeShift,
  }
}

export function outcomeReference(
  outcome: MeasureValidityOutcome,
  pre: readonly PreparedChange[],
): MeasureSelection['outcomeReference'] {
  const values = pre.flatMap((row) => {
    const joined = row.outcomes.get(outcome.id)
    return joined === undefined ? [] : [joined.better]
  })
  if (values.length === 0) return null
  if (outcome.kind === 'binary') {
    return {
      kind: 'binary',
      betterRate: values.reduce((sum, value) => sum + value, 0) / values.length,
    }
  }
  const scaled = robustScale(values)
  if (scaled === null) return null
  const meanZ =
    values.reduce((sum, value) => sum + (value - scaled.center) / scaled.scale, 0) / values.length
  return { kind: 'continuous', ...scaled, meanZ }
}

// ── Selection ────────────────────────────────────────────────────────

export function robustScale(values: readonly number[]): { center: number; scale: number } | null {
  const center = sampleMedian(values)
  if (center === null) return null
  const mad = sampleMedian(values.map((value) => Math.abs(value - center)))! * 1.4826
  if (mad > 0) return { center, scale: mad }
  if (values.length < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const sd = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1),
  )
  return sd > 0 ? { center, scale: sd } : null
}

export function alignedZ(
  value: number,
  direction: 'higher' | 'lower',
  reference: { center: number; scale: number },
): number {
  return ((direction === 'higher' ? 1 : -1) * (value - reference.center)) / reference.scale
}

export function selectMeasures(
  outcome: MeasureValidityOutcome,
  pairs: readonly MeasureOutcomeValidity[],
  pre: readonly PreparedChange[],
  post: readonly PreparedChange[],
  plan: MeasureValidityPlan,
  outcomeRef: MeasureSelection['outcomeReference'],
): MeasureSelection {
  const statistic = statisticOf(outcome)
  const nullValue = statistic === 'auc' ? 0.5 : 0
  const admitted = pairs.filter(
    (pair) =>
      pair.outcome === outcome.id &&
      (pair.label === 'predicts' ||
        pair.label === 'predicts-through-exposure' ||
        pair.label === 'predicts-pooled-only'),
  )
  const excluded: MeasureSelection['excluded'] = []
  const references = new Map<string, MeasureReference>()
  const candidates: MeasureOutcomeValidity[] = []
  for (const pair of admitted) {
    if (pair.measure === pair.exposure) {
      excluded.push({ measure: pair.measure, reason: 'exposure' })
      continue
    }
    if (pair.label === 'predicts-through-exposure') {
      excluded.push({ measure: pair.measure, reason: 'through-exposure' })
      continue
    }
    if (pair.label === 'predicts-pooled-only') {
      excluded.push({ measure: pair.measure, reason: 'pooled-only' })
      continue
    }
    const movement = pair.movement?.label
    if (movement === 'insensitive' || movement === 'moves-against-outcome') {
      excluded.push({ measure: pair.measure, reason: movement })
      continue
    }
    // The label is statistical; climbing also needs an effect worth the effort,
    // read inside exposure bins when the outcome has an exposure, since the
    // pooled estimate then carries the exposure's own effect.
    const floor = plan.selection.minEffect?.[statistic]
    const effect = pair.exposure === null ? pair.postCut.association : pair.postCut.withinExposure
    if (floor !== undefined && (effect === null || effect.estimate - effect.null < floor)) {
      excluded.push({ measure: pair.measure, reason: 'below-minimum-effect' })
      continue
    }
    const values = pre.flatMap((row) => {
      const value = row.change.measures[pair.measure]
      return value === undefined ? [] : [value]
    })
    const scaled = robustScale(values)
    if (scaled === null) continue
    const z = values.map((value) => alignedZ(value, pair.direction!, scaled))
    references.set(pair.measure, {
      ...scaled,
      meanZ: z.reduce((sum, value) => sum + value, 0) / z.length,
    })
    candidates.push(pair)
  }
  const pairOf = new Map(candidates.map((pair) => [pair.measure, pair]))
  const compositeRows = (rows: readonly PreparedChange[], set: readonly string[]) =>
    rows.flatMap((row) => {
      const joined = row.outcomes.get(outcome.id)
      if (joined === undefined) return []
      let sum = 0
      for (const measure of set) {
        const value = row.change.measures[measure]
        if (value === undefined) return []
        sum += alignedZ(value, pairOf.get(measure)!.direction!, references.get(measure)!)
      }
      return [{ x: sum / set.length, y: joined.better, unit: row.change.unit }]
    })
  const objective = (set: readonly string[]) => {
    const rows = compositeRows(pre, set)
    return rows.length < 3 ? Number.NaN : associationEstimate(statistic, rows)
  }
  const redundancy = (measure: string, climbed: readonly string[]) => {
    let best: { with: string; correlation: number } | null = null
    for (const other of climbed) {
      const xs: number[] = []
      const ys: number[] = []
      for (const row of pre) {
        const x = row.change.measures[measure]
        const y = row.change.measures[other]
        if (x === undefined || y === undefined) continue
        xs.push(x)
        ys.push(y)
      }
      if (xs.length < 3) continue
      const correlation = Math.abs(spearmanR(xs, ys))
      if (Number.isFinite(correlation) && (best === null || correlation > best.correlation)) {
        best = { with: other, correlation }
      }
    }
    return best
  }

  const climb: Array<{ measure: string; gain: number }> = []
  const guards: GuardMeasure[] = []
  let remaining = candidates.map((pair) => pair.measure)
  let current = nullValue
  const guard = (measure: string, reason: GuardMeasure['reason']): GuardMeasure => {
    const nearest = redundancy(
      measure,
      climb.map((row) => row.measure),
    )
    return {
      measure,
      direction: pairOf.get(measure)!.direction!,
      reason,
      redundantWith: reason === 'redundant' ? (nearest?.with ?? null) : null,
      correlation: nearest?.correlation ?? null,
      reference: references.get(measure)!,
    }
  }
  while (remaining.length > 0) {
    const climbed = climb.map((row) => row.measure)
    remaining = remaining.filter((measure) => {
      const nearest = redundancy(measure, climbed)
      if (nearest === null || nearest.correlation < plan.selection.maxRedundancy) return true
      guards.push(guard(measure, 'redundant'))
      return false
    })
    if (remaining.length === 0 || climb.length >= plan.selection.maxMeasures) break
    let best: { measure: string; value: number } | null = null
    for (const measure of remaining) {
      const value = objective([...climbed, measure])
      if (Number.isFinite(value) && (best === null || value > best.value)) best = { measure, value }
    }
    if (best === null) break
    const gain = best.value - current
    // The first measure must beat the null; each later one must add the plan's minimum gain.
    if (climb.length === 0 ? !(gain > 0) : !(gain >= plan.selection.minGain)) break
    climb.push({ measure: best.measure, gain })
    current = best.value
    remaining = remaining.filter((measure) => measure !== best.measure)
  }
  const sizeLimited = climb.length >= plan.selection.maxMeasures
  for (const measure of remaining)
    guards.push(guard(measure, sizeLimited ? 'size-limit' : 'no-gain'))

  const climbedIds = climb.map((row) => row.measure)
  const postRows = climbedIds.length === 0 ? [] : compositeRows(post, climbedIds)
  const postUnits = new Set(postRows.map((row) => row.unit)).size
  const composite: MeasureSelection['composite'] = {
    preCut:
      climbedIds.length === 0
        ? null
        : { n: compositeRows(pre, climbedIds).length, estimate: current },
    postCut:
      postRows.length >= plan.minJoined &&
      postUnits >= plan.minUnits &&
      Number.isFinite(associationEstimate(statistic, postRows))
        ? clusteredAssociation(postRows, {
            statistic,
            alternative: 'greater',
            resamples: plan.resamples,
            confidence: plan.confidence,
            ...(plan.seed === undefined ? {} : { seed: plan.seed }),
          })
        : null,
  }
  return {
    outcome: outcome.id,
    climb: climb.map(({ measure, gain }) => {
      const pair = pairOf.get(measure)!
      return {
        measure,
        direction: pair.direction!,
        preCutGain: gain,
        postCutEstimate: pair.postCut.association!.estimate,
        leadTimeMs: pair.leadTimeMs,
        cost: plan.measures.find((row) => row.id === measure)!.cost ?? null,
        reference: references.get(measure)!,
      }
    }),
    guards,
    excluded,
    composite,
    outcomeReference: outcomeRef,
  }
}
