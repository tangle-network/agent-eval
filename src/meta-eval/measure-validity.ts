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
 * Benjamini-Hochberg at the plan's level runs across every pair tested, again
 * across every tested pair whose within-unit statistic is tested, and again
 * across every tested pair with a within-exposure statistic, whatever its
 * pooled result. A
 * pooled statistic compares changes across units; a within-unit statistic
 * compares changes of the same unit, so a measure that only tells units apart
 * is visible as `predicts-pooled-only`. An outcome may name an exposure, a
 * measure it grows with for another reason (a bigger change has more to fix);
 * every other measure is then also tested inside bins of the exposure, and one
 * that predicts only by tracking it is `predicts-through-exposure`.
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
  type MeasureValidityPlanOutcome,
  type SealedMeasureValidityPlan,
  verifyMeasureValidityPlan,
} from '../experiment/measure-validity-plan'
import { interpolatedQuantile } from '../math/quantile'
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
  /**
   * Epoch milliseconds at which the outcomes were read. An observation
   * captured after it is excluded, and a change after the cut counts for an
   * outcome with `windowMs` only when its window closed by it. Required when
   * any outcome declares `windowMs`; at or after the cut.
   */
  asOf?: number
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
  | 'within-unit-untested'
  | 'within-exposure-not-shown'
  | 'within-exposure-untested'

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
   * `predicts`: the pooled test passes, the test inside exposure bins passes
   * when the outcome names an exposure, and the within-unit test passes when
   * it is tested (`reason` is `within-unit-untested` when it is not).
   * `predicts-through-exposure`: the pooled test passes and the test inside
   * exposure bins does not, so the measure may predict only by tracking the
   * exposure. `predicts-pooled-only`: the pooled test passes and the tested
   * within-unit test does not, so the ranking may come from differences
   * between units rather than between changes. `not-shown`: tested and not
   * admitted. `insufficient`: not tested; `reason` says why.
   */
  label:
    | 'predicts'
    | 'predicts-through-exposure'
    | 'predicts-pooled-only'
    | 'not-shown'
    | 'insufficient'
  reason: MeasureValidityReason | null
  /** Which end of the measure predicts the better outcome, fixed before the cut. */
  direction: 'higher' | 'lower' | null
  /** The outcome's declared exposure measure, or null; the exposure's own pair has no exposure test. */
  exposure: string | null
  /** Which end predicts the better outcome inside exposure bins, fixed before the cut on that statistic. */
  withinExposureDirection: 'higher' | 'lower' | null
  /**
   * Before the cut, outcome known by the cut: the measure as recorded against
   * the better outcome, pooled and inside exposure bins.
   */
  preCut: { n: number; units: number; estimate: number | null; withinExposure: number | null }
  /**
   * After the cut, measure aligned to its fixed direction: above the null
   * favors the better outcome. Every test is one-sided in that direction.
   * `withinUnit` is estimated when at least two units hold a comparable pair
   * and tested (given a q-value) only when `minUnits` do. `withinExposure`
   * compares changes in the same exposure bin, aligned to
   * `withinExposureDirection`.
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
    withinExposure: ClusteredAssociation | null
    withinExposureQValue: number | null
  }
  /** Outcome capture time minus change time over the joined changes after the cut. */
  leadTimeMs: { median: number; min: number; max: number } | null
  movement: MeasureMovementValidity | null
}

/** An outcome's exposure and the bins fixed before the cut. */
export interface MeasureExposureBins {
  outcome: string
  measure: string
  bins: number
  /**
   * Interior edges at the exposure's quantiles over the changes before the cut
   * joined to the outcome, with repeats removed; a value at an edge falls in
   * the lower bin.
   */
  edges: number[]
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
  /** When the outcomes were read, as given; null when not given. */
  asOf: number | null
  excludedObservations: {
    capturedBeforeChange: number
    /** Captured after `asOf`. */
    capturedAfterAsOf: number
    capturedAfterCutForPreCutChange: number
    beyondMaxCaptureLag: number
    /**
     * Change-outcome pairs before the cut with an outcome known by the cut
     * whose `windowMs` had not closed at the cut.
     */
    windowOpenAtCut: number
    /**
     * Change-outcome pairs after the cut with an outcome known by `asOf`
     * whose `windowMs` had not closed at `asOf`.
     */
    windowOpenAtEnd: number
  }
  exposures: MeasureExposureBins[]
  coverage: MeasureCoverage[]
  pairs: MeasureOutcomeValidity[]
  /** Pairs given a pooled p-value: the false-discovery family. */
  tested: number
  /**
   * Pairs given a pooled p-value whose within-unit statistic is tested, whatever
   * their pooled result: a second Benjamini-Hochberg family at the same level.
   */
  withinUnitTested: number
  /**
   * Pairs given a pooled p-value with a statistic inside exposure bins, whatever
   * their pooled result: a third Benjamini-Hochberg family at the same level.
   */
  withinExposureTested: number
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
  const asOf = input.asOf
  if (asOf !== undefined && !(Number.isFinite(asOf) && asOf >= plan.cut)) {
    throw new ValidationError(
      'measureValidityStudy: asOf must be finite epoch milliseconds at or after the cut',
    )
  }
  const windowed = plan.outcomes.filter((outcome) => outcome.windowMs !== undefined)
  if (asOf === undefined && windowed.length > 0) {
    throw new ValidationError(
      `measureValidityStudy: outcome ${windowed[0]!.id} declares windowMs, so asOf, the time the outcomes were read, is required`,
    )
  }
  validateChanges(input.changes, plan, true)
  const byRun = groupOutcomesByRun(await input.outcomes.list())
  const excluded = {
    capturedBeforeChange: 0,
    capturedAfterAsOf: 0,
    capturedAfterCutForPreCutChange: 0,
    beyondMaxCaptureLag: 0,
    windowOpenAtCut: 0,
    windowOpenAtEnd: 0,
  }
  const prepared = input.changes.map((change) => {
    const preCut = change.at < plan.cut
    const { eligible, ...counts } = eligibleObservations(
      byRun.get(change.id) ?? [],
      change,
      plan,
      preCut,
      asOf,
    )
    excluded.capturedBeforeChange += counts.capturedBeforeChange
    excluded.capturedAfterAsOf += counts.capturedAfterAsOf
    excluded.capturedAfterCutForPreCutChange += counts.capturedAfterCutForPreCutChange
    excluded.beyondMaxCaptureLag += counts.beyondMaxCaptureLag
    const outcomes = joinOutcomes(eligible, change, plan.outcomes, plan.reduction)
    // A windowed outcome counts only once its window has closed, by the cut
    // before it and by the read time after it, whatever its value: otherwise
    // recent events stay and recent non-events do not.
    for (const outcome of windowed) {
      const closesBy = preCut ? plan.cut : asOf!
      if (change.at + outcome.windowMs! > closesBy && outcomes.delete(outcome.id)) {
        if (preCut) excluded.windowOpenAtCut++
        else excluded.windowOpenAtEnd++
      }
    }
    return { change, preCut, outcomes }
  })
  const pre = prepared.filter((row) => row.preCut)
  const post = prepared.filter((row) => !row.preCut)
  const preUnits = new Set(pre.map((row) => row.change.unit))
  const postUnits = new Set(post.map((row) => row.change.unit))

  const exposures = plan.outcomes.flatMap((outcome) =>
    outcome.exposure === undefined ? [] : [exposureBins(outcome, pre)],
  )
  const pairs: MeasureOutcomeValidity[] = []
  for (const measure of plan.measures) {
    for (const outcome of plan.outcomes) {
      const bins = exposures.find((row) => row.outcome === outcome.id) ?? null
      pairs.push(assessPair(measure.id, outcome, bins, pre, post, plan))
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
  // The within-unit estimate is reported from two comparable units; it is tested from `minUnits`.
  const withinTested = tested.filter(
    (pair) => pair.postCut.withinUnit !== null && pair.postCut.withinUnit.units >= plan.minUnits,
  )
  const withinQ = benjaminiHochberg(
    withinTested.map((pair) => pair.postCut.withinUnit!.pValue),
    plan.level,
  ).qValues
  withinTested.forEach((pair, index) => {
    pair.postCut.withinUnitQValue = withinQ[index]!
  })
  const exposureTested = tested.filter((pair) => pair.postCut.withinExposure !== null)
  const exposureQ = benjaminiHochberg(
    exposureTested.map((pair) => pair.postCut.withinExposure!.pValue),
    plan.level,
  ).qValues
  exposureTested.forEach((pair, index) => {
    pair.postCut.withinExposureQValue = exposureQ[index]!
  })
  for (const pair of tested) labelPair(pair, plan.level)

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
    asOf: asOf ?? null,
    claim: { ...CLAIM },
    hypothesis: HYPOTHESIS,
    changes: { total: prepared.length, preCut: pre.length, postCut: post.length },
    units: {
      preCut: preUnits.size,
      postCut: postUnits.size,
      both: [...postUnits].filter((unit) => preUnits.has(unit)).length,
    },
    excludedObservations: excluded,
    exposures,
    coverage: plan.measures.map((measure) => coverageOf(measure.id, pre, post)),
    pairs,
    tested: tested.length,
    withinUnitTested: withinTested.length,
    withinExposureTested: exposureTested.length,
    admitted: pairs.filter((pair) => pair.label === 'predicts').length,
    movementTested: movementTested.length,
    selections,
  }
}

/**
 * The pooled test admits; the test inside exposure bins and then the tested
 * within-unit test can only narrow the label.
 */
function labelPair(pair: MeasureOutcomeValidity, level: number): void {
  const association = pair.postCut.association!
  if (pair.postCut.qValue! > level) {
    pair.label = 'not-shown'
    // A one-sided test cannot reject the other way; a reversal is an interval wholly past the null.
    pair.reason = association.high < association.null ? 'direction-reversed' : 'not-significant'
    return
  }
  if (pair.exposure !== null && pair.exposure !== pair.measure) {
    const within = pair.postCut.withinExposure
    if (within === null) {
      pair.label = 'predicts-through-exposure'
      pair.reason = 'within-exposure-untested'
      return
    }
    // Shown beyond the exposure only in the direction the pooled test admitted.
    if (pair.withinExposureDirection !== pair.direction || pair.postCut.withinExposureQValue! > level) {
      pair.label = 'predicts-through-exposure'
      pair.reason = 'within-exposure-not-shown'
      return
    }
  }
  if (pair.postCut.withinUnitQValue === null) {
    pair.label = 'predicts'
    pair.reason = 'within-unit-untested'
  } else if (pair.postCut.withinUnitQValue > level) {
    pair.label = 'predicts-pooled-only'
    pair.reason = 'within-unit-not-shown'
  } else {
    pair.label = 'predicts'
    pair.reason = null
  }
}

/** Bin edges at the exposure's quantiles over changes before the cut joined to the outcome. */
function exposureBins(
  outcome: MeasureValidityPlanOutcome,
  pre: readonly PreparedChange[],
): MeasureExposureBins {
  const { measure, bins } = outcome.exposure!
  const values = pre
    .flatMap((row) => {
      const value = row.change.measures[measure]
      return value === undefined || !row.outcomes.has(outcome.id) ? [] : [value]
    })
    .sort((a, b) => a - b)
  const edges: number[] = []
  if (values.length > 0) {
    for (let k = 1; k < bins; k++) {
      const edge = interpolatedQuantile(values, k / bins)
      if (edge !== edges[edges.length - 1]) edges.push(edge)
    }
  }
  return { outcome: outcome.id, measure, bins, edges }
}

/** The bin of a value: the number of edges below it. */
function binOf(value: number, edges: readonly number[]): string {
  let bin = 0
  while (bin < edges.length && value > edges[bin]!) bin++
  return String(bin)
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

/** Joined changes for one pair; `stratum` is the exposure bin when the exposure was measured. */
function joinedRows(
  rows: readonly PreparedChange[],
  measure: string,
  outcome: string,
  exposure: MeasureExposureBins | null,
) {
  return rows.flatMap((row) => {
    const x = row.change.measures[measure]
    const joined = row.outcomes.get(outcome)
    if (x === undefined || joined === undefined) return []
    const exposed = exposure === null ? undefined : row.change.measures[exposure.measure]
    return [
      {
        x,
        y: joined.better,
        unit: row.change.unit,
        lag: joined.capturedAt - row.change.at,
        ...(exposed === undefined ? {} : { stratum: binOf(exposed, exposure!.edges) }),
      },
    ]
  })
}

function assessPair(
  measure: string,
  outcome: MeasureValidityOutcome,
  exposure: MeasureExposureBins | null,
  pre: readonly PreparedChange[],
  post: readonly PreparedChange[],
  plan: MeasureValidityPlan,
): MeasureOutcomeValidity {
  const statistic = statisticOf(outcome)
  const nullValue = statistic === 'auc' ? 0.5 : 0
  const preRows = joinedRows(pre, measure, outcome.id, exposure)
  const postRows = joinedRows(post, measure, outcome.id, exposure)
  const preEstimate = preRows.length >= 3 ? associationEstimate(statistic, preRows) : Number.NaN
  const direction = directionOf(preEstimate, nullValue)
  const testsExposure = exposure !== null && exposure.measure !== measure
  const preBinned = preRows.filter((row) => row.stratum !== undefined)
  const preWithinExposure =
    testsExposure && preBinned.length >= 3
      ? associationEstimate(statistic, preBinned, 'stratified')
      : Number.NaN
  const exposureDirection = directionOf(preWithinExposure, nullValue)
  const postUnits = new Set(postRows.map((row) => row.unit)).size
  const lags = postRows.map((row) => row.lag)
  const result: MeasureOutcomeValidity = {
    measure,
    outcome: outcome.id,
    statistic,
    label: 'insufficient',
    reason: null,
    direction,
    exposure: exposure?.measure ?? null,
    withinExposureDirection: exposureDirection,
    preCut: {
      n: preRows.length,
      units: new Set(preRows.map((row) => row.unit)).size,
      estimate: Number.isFinite(preEstimate) ? preEstimate : null,
      withinExposure: Number.isFinite(preWithinExposure) ? preWithinExposure : null,
    },
    postCut: {
      n: postRows.length,
      units: postUnits,
      minority: minorityCount(postRows.map((row) => row.x)),
      association: null,
      qValue: null,
      withinUnit: null,
      withinUnitQValue: null,
      withinExposure: null,
      withinExposureQValue: null,
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
  if (
    comparableUnits(aligned) >= 2 &&
    Number.isFinite(associationEstimate(statistic, aligned, 'within-unit'))
  ) {
    result.postCut.withinUnit = clusteredAssociation(aligned, { ...options, scope: 'within-unit' })
  }
  if (testsExposure && exposureDirection !== null) {
    const binned = postRows.flatMap((row) =>
      row.stratum === undefined
        ? []
        : [
            {
              x: exposureDirection === 'lower' ? -row.x : row.x,
              y: row.y,
              unit: row.unit,
              stratum: row.stratum,
            },
          ],
    )
    const units = new Set(binned.map((row) => row.unit)).size
    if (units >= 2 && Number.isFinite(associationEstimate(statistic, binned, 'stratified'))) {
      result.postCut.withinExposure = clusteredAssociation(binned, {
        ...options,
        scope: 'stratified',
      })
    }
  }
  return result
}

function directionOf(estimate: number, nullValue: number): 'higher' | 'lower' | null {
  if (!Number.isFinite(estimate)) return null
  return estimate > nullValue ? 'higher' : estimate < nullValue ? 'lower' : null
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
