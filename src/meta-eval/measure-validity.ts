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
 * units. Each test is one-sided, in the direction fixed before the cut, and
 * Benjamini-Hochberg at the plan's level runs across every pair tested. A
 * pooled statistic compares changes across units; a within-unit statistic
 * compares changes of the same unit, so a measure that only tells units apart
 * is visible as `predicts-pooled-only`.
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
import { benjaminiHochberg } from '../statistics/multiplicity'
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
import { type MeasureSelection, outcomeReference, selectMeasures } from './measure-selection'
import { groupOutcomesByRun } from './outcome-observations'
import type { OutcomeStore } from './outcome-store'

export interface MeasureValidityInput {
  plan: SealedMeasureValidityPlan
  changes: readonly MeasuredChange[]
  outcomes: OutcomeStore
}

export type MeasureValidityReason =
  | 'below-minimum-count'
  | 'too-few-units'
  | 'too-little-variation'
  | 'no-pre-cut-direction'
  | 'constant-after-cut'
  | 'not-significant'
  | 'direction-reversed'
  | 'within-unit-not-shown'

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
  /**
   * `predicts`: the pooled test and, where it can be estimated, the within-unit
   * test pass. `predicts-pooled-only`: the pooled test passes and the
   * within-unit test does not, so the ranking may come from differences between
   * units rather than between changes. `not-shown`: tested and not admitted.
   * `insufficient`: not tested; `reason` says why.
   */
  label: 'predicts' | 'predicts-pooled-only' | 'not-shown' | 'insufficient'
  reason: MeasureValidityReason | null
  /** Which end of the measure predicts the better outcome, fixed before the cut. */
  direction: 'higher' | 'lower' | null
  /** Before the cut, outcome known by the cut: the measure as recorded against the better outcome. */
  preCut: { n: number; units: number; estimate: number | null }
  /**
   * After the cut, measure aligned to its fixed direction: above the null
   * favors the better outcome. Both tests are one-sided in that direction.
   * `withinUnit` is null when no `minUnits` units hold a comparable pair.
   */
  postCut: {
    n: number
    units: number
    /** Joined changes whose value differs from the measure's most common value. */
    minority: number
    association: ClusteredAssociation | null
    qValue: number | null
    withinUnit: ClusteredAssociation | null
    withinUnitQValue: number | null
  }
  /** Outcome capture time minus change time over the joined changes after the cut. */
  leadTimeMs: { median: number; min: number; max: number } | null
  movement: MeasureMovementValidity | null
}

export interface MeasureValidityReport {
  planDigest: string
  plan: MeasureValidityPlan
  claim: { causal: false; scope: string; causeRequires: string }
  /** How every p-value feeding the false-discovery correction was computed. */
  hypothesis: string
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
  /** Pairs given a pooled p-value: the false-discovery family. */
  tested: number
  /** Tested pairs with a within-unit p-value: a second family at the same level. */
  withinUnitTested: number
  /** Pairs labelled `predicts`. */
  admitted: number
  /** Pairs whose movement agreement was tested: a second family at the same level. */
  movementTested: number
  selections: MeasureSelection[]
}

const HYPOTHESIS =
  'one-sided: the measure, aligned to the direction fixed before the cut, is above the null for the better outcome; Benjamini-Hochberg per family at the plan level'

const CLAIM = {
  causal: false as const,
  scope: 'held-out prediction: the measure forecasts the outcome of changes after the cut',
  causeRequires:
    'randomized or interleaved assignment of changes, so the measure moves for reasons unrelated to the outcome',
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
  const excluded = {
    capturedBeforeChange: 0,
    capturedAfterCutForPreCutChange: 0,
    beyondMaxCaptureLag: 0,
  }
  const prepared = input.changes.map((change) => {
    const preCut = change.at < plan.cut
    const { eligible, ...counts } = eligibleObservations(
      byRun.get(change.id) ?? [],
      change,
      plan,
      preCut,
    )
    excluded.capturedBeforeChange += counts.capturedBeforeChange
    excluded.capturedAfterCutForPreCutChange += counts.capturedAfterCutForPreCutChange
    excluded.beyondMaxCaptureLag += counts.beyondMaxCaptureLag
    return {
      change,
      preCut,
      outcomes: joinOutcomes(eligible, change, plan.outcomes, plan.reduction),
    }
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
    pair.postCut.qValue = qValues[index]!
  })
  const withinTested = tested.filter((pair) => pair.postCut.withinUnit !== null)
  const withinQ = benjaminiHochberg(
    withinTested.map((pair) => pair.postCut.withinUnit!.pValue),
    plan.level,
  ).qValues
  withinTested.forEach((pair, index) => {
    pair.postCut.withinUnitQValue = withinQ[index]!
  })
  for (const pair of tested) {
    const association = pair.postCut.association!
    if (pair.postCut.qValue! <= plan.level) {
      const withinShown =
        pair.postCut.withinUnit === null || pair.postCut.withinUnitQValue! <= plan.level
      pair.label = withinShown ? 'predicts' : 'predicts-pooled-only'
      pair.reason = withinShown ? null : 'within-unit-not-shown'
    } else {
      pair.label = 'not-shown'
      // A one-sided test cannot reject the other way; a reversal is an interval wholly past the null.
      pair.reason = association.high < association.null ? 'direction-reversed' : 'not-significant'
    }
  }

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
      q <= plan.level
        ? 'moves-with-outcome'
        : agreement.high < agreement.null
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
    hypothesis: HYPOTHESIS,
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
    withinUnitTested: withinTested.length,
    admitted: pairs.filter((pair) => pair.label === 'predicts').length,
    movementTested: movementTested.length,
    selections,
  }
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
    postCut: {
      n: postRows.length,
      units: postUnits,
      minority: minorityCount(postRows.map((row) => row.x)),
      association: null,
      qValue: null,
      withinUnit: null,
      withinUnitQValue: null,
    },
    leadTimeMs:
      lags.length === 0
        ? null
        : {
            median: sampleMedian(lags)!,
            min: lags.reduce((a, b) => Math.min(a, b)),
            max: lags.reduce((a, b) => Math.max(a, b)),
          },
    movement: null,
  }
  const aligned = postRows.map((row) => ({
    x: direction === 'lower' ? -row.x : row.x,
    y: row.y,
    unit: row.unit,
  }))
  if (postRows.length < plan.minJoined) result.reason = 'below-minimum-count'
  else if (postUnits < plan.minUnits) result.reason = 'too-few-units'
  else if (result.postCut.minority < plan.minMinority) result.reason = 'too-little-variation'
  else if (direction === null) result.reason = 'no-pre-cut-direction'
  else if (!Number.isFinite(associationEstimate(statistic, aligned)))
    result.reason = 'constant-after-cut'
  if (result.reason !== null) return result
  const options = {
    statistic,
    alternative: 'greater' as const,
    resamples: plan.resamples,
    confidence: plan.confidence,
    ...(plan.seed === undefined ? {} : { seed: plan.seed }),
  }
  result.postCut.association = clusteredAssociation(aligned, options)
  const withinUnits = comparableUnits(aligned)
  if (
    withinUnits >= plan.minUnits &&
    Number.isFinite(associationEstimate(statistic, aligned, 'within-unit'))
  ) {
    result.postCut.withinUnit = clusteredAssociation(aligned, { ...options, scope: 'within-unit' })
  }
  return result
}

/** Values that differ from the most common value: the smaller class of a two-valued measure. */
function minorityCount(values: readonly number[]): number {
  const counts = new Map<number, number>()
  let largest = 0
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1
    counts.set(value, count)
    largest = Math.max(largest, count)
  }
  return values.length - largest
}

/** Units holding a comparable pair: two changes with different outcomes. */
function comparableUnits(rows: readonly { y: number; unit: string }[]): number {
  const seen = new Map<string, number>()
  const comparable = new Set<string>()
  for (const row of rows) {
    const first = seen.get(row.unit)
    if (first === undefined) seen.set(row.unit, row.y)
    else if (first !== row.y) comparable.add(row.unit)
  }
  return comparable.size
}

// ── Movement under change ────────────────────────────────────────────

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
    alternative: 'greater',
    resamples: plan.resamples,
    confidence: plan.confidence,
    ...(plan.seed === undefined ? {} : { seed: plan.seed }),
  })
  return result
}
