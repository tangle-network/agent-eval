/**
 * Which recorded numbers predict a result decided later, on changes they were
 * not chosen on, and which few of them to climb.
 *
 * A change has an id, a time, an independent unit and numbers known when it
 * was made. Outcomes join to it through `DeploymentOutcome.runId` and carry
 * their own capture time. The sealed plan's cut splits the changes: changes
 * before it, with outcomes known by it, fix each measure's direction, the
 * standardization and the selected subset; every reported statistic comes from
 * changes at or after it with those choices fixed. Intervals resample whole
 * units. Benjamini-Hochberg at the plan's level runs across every pair tested.
 *
 * Prediction is not causation. An admitted measure forecasts the outcome of
 * changes like these; it does not show that raising the measure raises the
 * outcome. Records that show cause assign changes at random or interleave
 * them, so the measure moves for reasons unrelated to the outcome.
 */

import { ValidationError } from '../errors'
import {
  type MeasureValidityOutcome,
  type MeasureValidityPlan,
  type SealedMeasureValidityPlan,
  verifyMeasureValidityPlan,
} from '../experiment/measure-validity-plan'
import {
  associationEstimate,
  type ClusteredAssociation,
  clusteredAssociation,
} from '../statistics/clustered-association'
import { spearmanR } from '../statistics/descriptive'
import { benjaminiHochberg } from '../statistics/multiplicity'
import { sampleMedian } from '../statistics/samples'
import { clusterBootstrapMean } from './cluster-bootstrap'
import { groupOutcomesByRun, reduceOutcomeObservation } from './outcome-observations'
import type { DeploymentOutcome, OutcomeStore } from './outcome-store'

/** A change and the numbers known when it was made. */
export interface MeasuredChange {
  /** Joins `DeploymentOutcome.runId`. */
  id: string
  /** Epoch milliseconds when the change was made. */
  at: number
  /** Independent unit, such as a repository, session or customer. Intervals resample whole units. */
  unit: string
  /** Finite values; an absent key is unmeasured, never zero. */
  measures: Record<string, number>
  /** The measure before and after the change, when both were recorded. */
  movements?: Record<string, { before: number; after: number }>
}

export interface MeasureValidityInput {
  plan: SealedMeasureValidityPlan
  changes: readonly MeasuredChange[]
  outcomes: OutcomeStore
}

export type MeasureValidityReason =
  | 'below-minimum-count'
  | 'too-few-units'
  | 'no-pre-cut-direction'
  | 'constant-after-cut'
  | 'not-significant'
  | 'direction-reversed'

export interface MeasureCoverage {
  measure: string
  changes: number
  measured: number
  share: number
  preCut: { changes: number; measured: number }
  postCut: { changes: number; measured: number }
  /** Changes recording a before and after value. */
  movements: number
}

export interface MeasureMovementValidity {
  label:
    | 'moves-with-outcome'
    | 'agreement-not-shown'
    | 'moves-against-outcome'
    | 'insensitive'
    | 'insufficient'
  /** Changes after the cut that record a movement. */
  changes: number
  units: number
  /** Changes whose `|after - before|` exceeds the declared noise. */
  moved: number
  /** Share of changes that moved beyond noise, with a whole-unit interval. */
  sensitivity: { estimate: number; low: number; high: number } | null
  /**
   * Among moved changes with an outcome, the AUC of the movement's direction
   * (aligned to the measure's predictive direction) for the better outcome.
   * This is balanced agreement: 0.5 under no relation whatever the base rates.
   */
  agreement: ClusteredAssociation | null
  qValue: number | null
}

export interface MeasureOutcomeValidity {
  measure: string
  outcome: string
  statistic: 'auc' | 'spearman'
  label: 'predicts' | 'not-shown' | 'insufficient'
  reason: MeasureValidityReason | null
  /** Which end of the measure predicts the better outcome, fixed before the cut. */
  direction: 'higher' | 'lower' | null
  /** Before the cut, outcome known by the cut: the measure as recorded against the better outcome. */
  preCut: { n: number; units: number; estimate: number | null }
  /** After the cut, measure aligned to its fixed direction: above the null favors the better outcome. */
  postCut: {
    n: number
    units: number
    association: ClusteredAssociation | null
    qValue: number | null
  }
  /** Outcome capture time minus change time over the joined changes after the cut. */
  leadTimeMs: { median: number; min: number; max: number } | null
  movement: MeasureMovementValidity | null
}

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
  /** Admitted measures that cannot be climbed: they do not move under change, or move against the outcome. */
  excluded: Array<{ measure: string; reason: 'insensitive' | 'moves-against-outcome' }>
  /**
   * Equal-weight mean of the climbed measures' aligned z. The post-cut score
   * reads the changes admission read, so it describes the subset; the next
   * batch is its independent check.
   */
  composite: { preCut: { n: number; estimate: number } | null; postCut: ClusteredAssociation | null }
  /** Before-cut outcome reference for drift checks on later batches. */
  outcomeReference:
    | { kind: 'binary'; betterRate: number }
    | { kind: 'continuous'; center: number; scale: number; meanZ: number }
    | null
}

export interface MeasureValidityReport {
  planDigest: string
  plan: MeasureValidityPlan
  claim: { causal: false; scope: string; causeRequires: string }
  changes: { total: number; preCut: number; postCut: number }
  units: { preCut: number; postCut: number; both: number }
  /** Outcome observations not joined, by reason. */
  excludedObservations: {
    capturedBeforeChange: number
    capturedAfterCutForPreCutChange: number
    beyondMaxCaptureLag: number
  }
  coverage: MeasureCoverage[]
  pairs: MeasureOutcomeValidity[]
  /** Pairs given a p-value: the false-discovery family. */
  tested: number
  admitted: number
  /** Pairs whose movement agreement was tested: a second family at the same level. */
  movementTested: number
  selections: MeasureSelection[]
}

const CLAIM = {
  causal: false as const,
  scope: 'held-out prediction: the measure forecasts the outcome of changes after the cut',
  causeRequires:
    'randomized or interleaved assignment of changes, so the measure moves for reasons unrelated to the outcome',
}

interface JoinedOutcome {
  /** 0 or 1 for binary (1 is better); the direction-aligned value for continuous. */
  better: number
  capturedAt: number
}

interface PreparedChange {
  change: MeasuredChange
  preCut: boolean
  outcomes: Map<string, JoinedOutcome>
}

/** Rank every planned measure against every planned outcome on changes after the cut. */
export async function measureValidityStudy(
  input: MeasureValidityInput,
): Promise<MeasureValidityReport> {
  const sealed = structuredClone(input.plan)
  if (!verifyMeasureValidityPlan(sealed)) {
    throw new ValidationError(
      'measureValidityStudy: the plan seal does not verify; seal it with sealMeasureValidityPlan before reading changes after the cut',
    )
  }
  const plan = sealed.plan
  validateChanges(input.changes, plan, true)
  const byRun = groupOutcomesByRun(await input.outcomes.list())
  const excluded = { capturedBeforeChange: 0, capturedAfterCutForPreCutChange: 0, beyondMaxCaptureLag: 0 }
  const prepared = input.changes.map((change) => {
    const preCut = change.at < plan.cut
    const { eligible, ...counts } = eligibleObservations(byRun.get(change.id) ?? [], change, plan, preCut)
    excluded.capturedBeforeChange += counts.capturedBeforeChange
    excluded.capturedAfterCutForPreCutChange += counts.capturedAfterCutForPreCutChange
    excluded.beyondMaxCaptureLag += counts.beyondMaxCaptureLag
    return { change, preCut, outcomes: joinOutcomes(eligible, change, plan.outcomes, plan.reduction) }
  })
  const pre = prepared.filter((row) => row.preCut)
  const post = prepared.filter((row) => !row.preCut)
  const preUnits = new Set(pre.map((row) => row.change.unit))
  const postUnits = new Set(post.map((row) => row.change.unit))

  const pairs: MeasureOutcomeValidity[] = []
  for (const measure of plan.measures) {
    for (const outcome of plan.outcomes) {
      pairs.push(assessPair(measure.id, outcome, pre, post, plan))
    }
  }
  const tested = pairs.filter((pair) => pair.postCut.association !== null)
  const { qValues } = benjaminiHochberg(
    tested.map((pair) => pair.postCut.association!.pValue),
    plan.level,
  )
  tested.forEach((pair, index) => {
    const q = qValues[index]!
    const association = pair.postCut.association!
    pair.postCut.qValue = q
    if (q <= plan.level && association.estimate > association.null) {
      pair.label = 'predicts'
      pair.reason = null
    } else {
      pair.label = 'not-shown'
      pair.reason =
        q <= plan.level && association.estimate < association.null
          ? 'direction-reversed'
          : 'not-significant'
    }
  })

  const outcomeReferences = new Map(
    plan.outcomes.map((outcome) => [outcome.id, outcomeReference(outcome, pre)]),
  )
  for (const pair of pairs) {
    const outcome = plan.outcomes.find((row) => row.id === pair.outcome)!
    pair.movement = assessMovement(pair, outcome, post, plan, outcomeReferences.get(outcome.id)!)
  }
  const movementTested = pairs.filter((pair) => pair.movement?.agreement)
  const movementQ = benjaminiHochberg(
    movementTested.map((pair) => pair.movement!.agreement!.pValue),
    plan.level,
  ).qValues
  movementTested.forEach((pair, index) => {
    const movement = pair.movement!
    const agreement = movement.agreement!
    const q = movementQ[index]!
    movement.qValue = q
    movement.label =
      q <= plan.level && agreement.estimate > agreement.null
        ? 'moves-with-outcome'
        : q <= plan.level && agreement.estimate < agreement.null
          ? 'moves-against-outcome'
          : 'agreement-not-shown'
  })

  const selections = plan.outcomes.map((outcome) =>
    selectMeasures(outcome, pairs, pre, post, plan, outcomeReferences.get(outcome.id)!),
  )

  return {
    planDigest: sealed.digest,
    plan,
    claim: { ...CLAIM },
    changes: { total: prepared.length, preCut: pre.length, postCut: post.length },
    units: {
      preCut: preUnits.size,
      postCut: postUnits.size,
      both: [...postUnits].filter((unit) => preUnits.has(unit)).length,
    },
    excludedObservations: excluded,
    coverage: plan.measures.map((measure) => coverageOf(measure.id, pre, post)),
    pairs,
    tested: tested.length,
    admitted: pairs.filter((pair) => pair.label === 'predicts').length,
    movementTested: movementTested.length,
    selections,
  }
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
    throw new ValidationError(`guardDrift: the report has no selection for outcome ${input.outcome}`)
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
  const centered = (change: MeasuredChange, measure: string, direction: 'higher' | 'lower', reference: MeasureReference) => {
    const value = change.measures[measure]
    return value === undefined
      ? null
      : alignedZ(value, direction, reference) - reference.meanZ
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
        divergence === null ? 'insufficient' : divergence.low > tolerance ? 'drift' : 'within-tolerance',
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
      const joined = joinOutcomes(eligible, change, [outcomeSpec], plan.reduction).get(outcomeSpec.id)
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

// ── Records and joins ────────────────────────────────────────────────

function validateChanges(
  changes: readonly MeasuredChange[],
  plan: MeasureValidityPlan,
  requireUniqueIds: boolean,
): void {
  const ids = new Set<string>()
  for (const [index, change] of changes.entries()) {
    const where = `change ${index}${typeof change?.id === 'string' ? ` (${change.id})` : ''}`
    if (typeof change?.id !== 'string' || change.id.trim().length === 0) {
      throw new ValidationError(`${where}: id must be a nonempty string`)
    }
    if (requireUniqueIds && ids.has(change.id)) {
      throw new ValidationError(`${where}: duplicate change id`)
    }
    ids.add(change.id)
    if (!Number.isFinite(change.at)) throw new ValidationError(`${where}: at must be finite`)
    if (typeof change.unit !== 'string' || change.unit.length === 0) {
      throw new ValidationError(`${where}: unit must be a nonempty string`)
    }
    for (const measure of plan.measures) {
      const value = change.measures?.[measure.id]
      if (value !== undefined && !Number.isFinite(value)) {
        throw new ValidationError(
          `${where}: measure ${measure.id} must be finite; omit it when unmeasured`,
        )
      }
      const movement = change.movements?.[measure.id]
      if (movement === undefined) continue
      if (!Number.isFinite(movement.before) || !Number.isFinite(movement.after)) {
        throw new ValidationError(`${where}: movement of ${measure.id} must be finite`)
      }
      if (measure.noise === undefined) {
        throw new ValidationError(
          `${where}: records a movement of ${measure.id} but the plan declares no noise for it`,
        )
      }
    }
  }
}

function eligibleObservations(
  observations: readonly DeploymentOutcome[],
  change: MeasuredChange,
  plan: MeasureValidityPlan,
  preCut: boolean,
) {
  const counts = { capturedBeforeChange: 0, capturedAfterCutForPreCutChange: 0, beyondMaxCaptureLag: 0 }
  const eligible: DeploymentOutcome[] = []
  for (const observation of observations) {
    if (observation.capturedAt < change.at) counts.capturedBeforeChange++
    else if (
      plan.maxCaptureLagMs !== undefined &&
      observation.capturedAt - change.at > plan.maxCaptureLagMs
    )
      counts.beyondMaxCaptureLag++
    // A direction fitted before the cut may read only outcomes known by the cut.
    else if (preCut && observation.capturedAt > plan.cut) counts.capturedAfterCutForPreCutChange++
    else eligible.push(observation)
  }
  return { eligible, ...counts }
}

function joinOutcomes(
  eligible: readonly DeploymentOutcome[],
  change: MeasuredChange,
  outcomes: readonly MeasureValidityOutcome[],
  reduction: MeasureValidityPlan['reduction'],
): Map<string, JoinedOutcome> {
  const joined = new Map<string, JoinedOutcome>()
  for (const outcome of outcomes) {
    const reduced = reduceOutcomeObservation(eligible, outcome.id, reduction)
    if (reduced === null) continue
    if (outcome.kind === 'binary' && reduced.value !== 0 && reduced.value !== 1) {
      throw new ValidationError(
        `change ${change.id}: binary outcome ${outcome.id} reduced to ${reduced.value}; record 0 or 1`,
      )
    }
    const higher = outcome.direction === 'higher-is-better'
    joined.set(outcome.id, {
      better:
        outcome.kind === 'binary'
          ? higher
            ? reduced.value
            : 1 - reduced.value
          : higher
            ? reduced.value
            : -reduced.value,
      capturedAt: reduced.capturedAt,
    })
  }
  return joined
}

function coverageOf(
  measure: string,
  pre: readonly PreparedChange[],
  post: readonly PreparedChange[],
): MeasureCoverage {
  const measured = (rows: readonly PreparedChange[]) =>
    rows.filter((row) => row.change.measures[measure] !== undefined).length
  const changes = pre.length + post.length
  const total = measured(pre) + measured(post)
  return {
    measure,
    changes,
    measured: total,
    share: changes === 0 ? 0 : total / changes,
    preCut: { changes: pre.length, measured: measured(pre) },
    postCut: { changes: post.length, measured: measured(post) },
    movements: [...pre, ...post].filter((row) => row.change.movements?.[measure] !== undefined)
      .length,
  }
}

// ── Prediction ───────────────────────────────────────────────────────

function statisticOf(outcome: MeasureValidityOutcome): 'auc' | 'spearman' {
  return outcome.kind === 'binary' ? 'auc' : 'spearman'
}

function joinedRows(rows: readonly PreparedChange[], measure: string, outcome: string) {
  return rows.flatMap((row) => {
    const x = row.change.measures[measure]
    const joined = row.outcomes.get(outcome)
    return x === undefined || joined === undefined
      ? []
      : [{ x, y: joined.better, unit: row.change.unit, lag: joined.capturedAt - row.change.at }]
  })
}

function assessPair(
  measure: string,
  outcome: MeasureValidityOutcome,
  pre: readonly PreparedChange[],
  post: readonly PreparedChange[],
  plan: MeasureValidityPlan,
): MeasureOutcomeValidity {
  const statistic = statisticOf(outcome)
  const nullValue = statistic === 'auc' ? 0.5 : 0
  const preRows = joinedRows(pre, measure, outcome.id)
  const postRows = joinedRows(post, measure, outcome.id)
  const preEstimate = preRows.length >= 3 ? associationEstimate(statistic, preRows) : Number.NaN
  const direction = !Number.isFinite(preEstimate)
    ? null
    : preEstimate > nullValue
      ? 'higher'
      : preEstimate < nullValue
        ? 'lower'
        : null
  const postUnits = new Set(postRows.map((row) => row.unit)).size
  const lags = postRows.map((row) => row.lag)
  const result: MeasureOutcomeValidity = {
    measure,
    outcome: outcome.id,
    statistic,
    label: 'insufficient',
    reason: null,
    direction,
    preCut: {
      n: preRows.length,
      units: new Set(preRows.map((row) => row.unit)).size,
      estimate: Number.isFinite(preEstimate) ? preEstimate : null,
    },
    postCut: { n: postRows.length, units: postUnits, association: null, qValue: null },
    leadTimeMs:
      lags.length === 0
        ? null
        : { median: sampleMedian(lags)!, min: Math.min(...lags), max: Math.max(...lags) },
    movement: null,
  }
  const aligned = postRows.map((row) => ({
    x: direction === 'lower' ? -row.x : row.x,
    y: row.y,
    unit: row.unit,
  }))
  if (postRows.length < plan.minJoined) result.reason = 'below-minimum-count'
  else if (postUnits < plan.minUnits) result.reason = 'too-few-units'
  else if (direction === null) result.reason = 'no-pre-cut-direction'
  else if (!Number.isFinite(associationEstimate(statistic, aligned))) result.reason = 'constant-after-cut'
  if (result.reason !== null) return result
  result.postCut.association = clusteredAssociation(aligned, {
    statistic,
    resamples: plan.resamples,
    confidence: plan.confidence,
    ...(plan.seed === undefined ? {} : { seed: plan.seed }),
  })
  return result
}

// ── Movement under change ────────────────────────────────────────────

function outcomeReference(
  outcome: MeasureValidityOutcome,
  pre: readonly PreparedChange[],
): MeasureSelection['outcomeReference'] {
  const values = pre.flatMap((row) => {
    const joined = row.outcomes.get(outcome.id)
    return joined === undefined ? [] : [joined.better]
  })
  if (values.length === 0) return null
  if (outcome.kind === 'binary') {
    return { kind: 'binary', betterRate: values.reduce((sum, value) => sum + value, 0) / values.length }
  }
  const scaled = robustScale(values)
  if (scaled === null) return null
  const meanZ = values.reduce((sum, value) => sum + (value - scaled.center) / scaled.scale, 0) / values.length
  return { kind: 'continuous', ...scaled, meanZ }
}

function assessMovement(
  pair: MeasureOutcomeValidity,
  outcome: MeasureValidityOutcome,
  post: readonly PreparedChange[],
  plan: MeasureValidityPlan,
  reference: MeasureSelection['outcomeReference'],
): MeasureMovementValidity | null {
  const noise = plan.measures.find((row) => row.id === pair.measure)!.noise
  const rows = post.flatMap((row) => {
    const movement = row.change.movements?.[pair.measure]
    return movement === undefined ? [] : [{ row, delta: movement.after - movement.before }]
  })
  if (noise === undefined || rows.length === 0) return null
  const units = new Set(rows.map(({ row }) => row.change.unit)).size
  const moved = rows.filter(({ delta }) => Math.abs(delta) > noise)
  const result: MeasureMovementValidity = {
    label: 'insufficient',
    changes: rows.length,
    units,
    moved: moved.length,
    sensitivity: null,
    agreement: null,
    qValue: null,
  }
  if (rows.length < plan.minJoined || units < plan.minUnits) return result
  const sensitivity = clusterBootstrapMean(
    rows.map(({ row, delta }) => ({
      cluster: row.change.unit,
      value: Math.abs(delta) > noise ? 1 : 0,
    })),
    {
      confidence: plan.confidence,
      resamples: plan.resamples,
      ...(plan.seed === undefined ? {} : { seed: plan.seed }),
    },
  )
  result.sensitivity = { estimate: sensitivity.mean, low: sensitivity.low, high: sensitivity.high }
  if (sensitivity.high < plan.minSensitivity) {
    result.label = 'insensitive'
    return result
  }
  if (pair.direction === null || reference === null) return result
  const sign = pair.direction === 'higher' ? 1 : -1
  const agreementRows = moved.flatMap(({ row, delta }) => {
    const joined = row.outcomes.get(outcome.id)
    if (joined === undefined) return []
    const better =
      reference.kind === 'binary'
        ? joined.better
        : joined.better > reference.center
          ? 1
          : joined.better < reference.center
            ? 0
            : null
    return better === null ? [] : [{ x: Math.sign(sign * delta), y: better, unit: row.change.unit }]
  })
  const agreementUnits = new Set(agreementRows.map((row) => row.unit)).size
  if (
    agreementRows.length < plan.minJoined ||
    agreementUnits < plan.minUnits ||
    !Number.isFinite(associationEstimate('auc', agreementRows))
  ) {
    return result
  }
  result.agreement = clusteredAssociation(agreementRows, {
    statistic: 'auc',
    resamples: plan.resamples,
    confidence: plan.confidence,
    ...(plan.seed === undefined ? {} : { seed: plan.seed }),
  })
  return result
}

// ── Selection ────────────────────────────────────────────────────────

function robustScale(values: readonly number[]): { center: number; scale: number } | null {
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

function alignedZ(value: number, direction: 'higher' | 'lower', reference: { center: number; scale: number }): number {
  return ((direction === 'higher' ? 1 : -1) * (value - reference.center)) / reference.scale
}

function selectMeasures(
  outcome: MeasureValidityOutcome,
  pairs: readonly MeasureOutcomeValidity[],
  pre: readonly PreparedChange[],
  post: readonly PreparedChange[],
  plan: MeasureValidityPlan,
  outcomeRef: MeasureSelection['outcomeReference'],
): MeasureSelection {
  const statistic = statisticOf(outcome)
  const nullValue = statistic === 'auc' ? 0.5 : 0
  const admitted = pairs.filter((pair) => pair.outcome === outcome.id && pair.label === 'predicts')
  const excluded: MeasureSelection['excluded'] = []
  const references = new Map<string, MeasureReference>()
  const candidates: MeasureOutcomeValidity[] = []
  for (const pair of admitted) {
    const movement = pair.movement?.label
    if (movement === 'insensitive' || movement === 'moves-against-outcome') {
      excluded.push({ measure: pair.measure, reason: movement })
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
  for (const measure of remaining) guards.push(guard(measure, sizeLimited ? 'size-limit' : 'no-gain'))

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
