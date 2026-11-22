/**
 * The registered plan of a measure validity study: the cut, the
 * false-discovery level, the minimum counts, the outcomes and the measures.
 *
 * Sealing resolves every default into the plan and hashes it under the same
 * RFC 8785 scheme as `sealExperiment`, so the study reads its rules only from
 * a verified seal and a later change to the cut, level or outcome list is a
 * different digest. A seal verifies identity, not when it was made: seal
 * before reading changes made after the cut, and keep the digest where an
 * independent reader can see it.
 *
 * A plan sealed now carries `format: 2`. A plan without it was sealed before
 * outcome windows, exposures and the minimum effect existed: it still verifies
 * under the digest it was sealed with and runs under the rules it was sealed
 * with, so a seal outlives an upgrade.
 */

import { ValidationError } from '../errors'
import { hashCanonical } from '../ledger-core/canonical'

/**
 * A measure the outcome grows with for a reason other than the quality being
 * measured, such as a change's size for "a later fix touched it": a bigger
 * change has more to fix. Every other measure is also tested inside bins of
 * the exposure, so one that predicts only by tracking it is visible.
 */
export interface MeasureValidityExposure {
  /** A planned measure id. */
  measure: string
  /** Bins with edges at the exposure's quantiles before the cut. Default 10. */
  bins?: number
}

export interface MeasureValidityOutcome {
  /** Exact key in `DeploymentOutcome.metrics`. */
  id: string
  direction: 'higher-is-better' | 'lower-is-better'
  /** `binary` outcomes are 0 or 1 and use AUC; `continuous` outcomes use rank correlation. */
  kind: 'binary' | 'continuous'
  /**
   * Time after the change within which the outcome is decided. A change before
   * the cut counts for this outcome only when `at + windowMs` is at or before
   * the cut, and a change after it only when `at + windowMs` is at or before
   * the study's `asOf`, whatever its value and capture time. Declare it
   * whenever a caller records an event when it happens and its absence when
   * the window closes: otherwise the changes just before the cut, and the last
   * changes read, keep their events and lose their non-events.
   */
  windowMs?: number
  exposure?: MeasureValidityExposure
}

/** An outcome as sealed: an exposure carries its resolved bin count. */
export interface MeasureValidityPlanOutcome extends MeasureValidityOutcome {
  exposure?: Required<MeasureValidityExposure>
}

export interface MeasureValidityMeasure {
  /** Exact key in `MeasuredChange.measures` and `MeasuredChange.movements`. */
  id: string
  /**
   * Largest `|after - before|` that is noise, such as the largest movement seen
   * when nothing changed. Required when any change records a movement of this measure.
   */
  noise?: number
  /** Caller-defined cost of measuring it, carried into the selection. */
  cost?: number
}

export interface MeasureValiditySelectionRules {
  /** Largest climbed subset. Default 3. */
  maxMeasures?: number
  /** Smallest before-cut gain in the composite's statistic that admits another measure. Default 0.01. */
  minGain?: number
  /** Absolute before-cut rank correlation with a climbed measure at or above which a candidate is redundant. Default 0.9. */
  maxRedundancy?: number
  /**
   * Smallest distance of the after-cut estimate from the null for an admitted
   * measure to be climbed; a smaller one is real by the test and too small to
   * be worth climbing. Default 0.05 for AUC and 0.1 for Spearman.
   */
  minEffect?: { auc?: number; spearman?: number }
}

/** Selection rules as sealed, every default resolved. */
export interface MeasureValidityPlanSelection {
  maxMeasures: number
  minGain: number
  maxRedundancy: number
  /** Absent on a plan sealed without `format`: no floor. */
  minEffect?: { auc: number; spearman: number }
}

/** The format every plan is sealed in now. */
const PLAN_FORMAT = 2 as const

export interface MeasureValidityPlanInput {
  id: string
  /** Epoch milliseconds. Changes before it fit directions and the selection; changes at or after it are the test. */
  cut: number
  /** Benjamini-Hochberg false-discovery level across every measure-outcome pair tested. Required. */
  level: number
  outcomes: readonly MeasureValidityOutcome[]
  measures: readonly MeasureValidityMeasure[]
  /** Fewest joined changes after the cut for a pair to be tested. Default 100. */
  minJoined?: number
  /** Fewest independent units after the cut for a pair to be tested. Default 20. */
  minUnits?: number
  /**
   * Fewest joined changes after the cut whose value differs from the measure's
   * most common value: the smaller class of a two-valued measure. Below it the
   * pair is insufficient. Default 20.
   */
  minMinority?: number
  /** Whole-unit resamples per interval. Default 1000. */
  resamples?: number
  /** Interval level. Default 0.95. */
  confidence?: number
  /** Absent, every interval's seed derives from its own rows. */
  seed?: number
  /** Reduce several observations of one outcome for one change. Default latest. */
  reduction?: 'latest' | 'mean' | 'max'
  /** Ignore outcome observations captured later than this after the change. */
  maxCaptureLagMs?: number
  /** Upper confidence bound on the share of changes that move a measure beyond its noise, below which it is insensitive. Default 0.05. */
  minSensitivity?: number
  selection?: MeasureValiditySelectionRules
}

/** A plan with every default resolved, as sealed. */
export interface MeasureValidityPlan {
  /**
   * 2 on every plan sealed now. Absent on a plan sealed before it existed,
   * which declares no outcome window, exposure or minimum effect and runs
   * without them.
   */
  format?: 2
  id: string
  cut: number
  level: number
  outcomes: MeasureValidityPlanOutcome[]
  measures: MeasureValidityMeasure[]
  minJoined: number
  minUnits: number
  minMinority: number
  resamples: number
  confidence: number
  seed?: number
  reduction: 'latest' | 'mean' | 'max'
  maxCaptureLagMs?: number
  minSensitivity: number
  selection: MeasureValidityPlanSelection
}

export interface SealedMeasureValidityPlan {
  plan: MeasureValidityPlan
  /** sha256 over the RFC 8785 encoding of `plan`. */
  digest: string
  algo: 'sha256-rfc8785'
  sealedAt: string
}

/** Validate the plan, resolve its defaults, and hash it. */
export function sealMeasureValidityPlan(
  input: MeasureValidityPlanInput,
  options: { sealedAt?: string } = {},
): SealedMeasureValidityPlan {
  const plan = resolvePlan(input, PLAN_FORMAT)
  return {
    plan,
    digest: planDigest(plan),
    algo: 'sha256-rfc8785',
    sealedAt: options.sealedAt ?? new Date().toISOString(),
  }
}

/** True when the seal's scheme is supported and its digest matches its plan. */
export function verifyMeasureValidityPlan(sealed: SealedMeasureValidityPlan): boolean {
  if (sealed?.algo !== 'sha256-rfc8785') return false
  try {
    return planDigest(resolvePlan(sealed.plan, sealed.plan.format)) === sealed.digest
  } catch {
    return false
  }
}

function planDigest(plan: MeasureValidityPlan): string {
  return hashCanonical(plan).slice('sha256:'.length)
}

/**
 * Resolve the input under `format`. Without a format the plan is resolved
 * exactly as it was before `format` existed, adding nothing, so its digest is
 * the one it was sealed with.
 */
function resolvePlan(input: MeasureValidityPlanInput, format: unknown): MeasureValidityPlan {
  const current = format === PLAN_FORMAT
  const problems: string[] = []
  const check = (ok: boolean, problem: string) => {
    if (!ok) problems.push(problem)
  }
  check(typeof input.id === 'string' && input.id.trim().length > 0, 'id must be nonempty')
  check(Number.isFinite(input.cut), 'cut must be finite epoch milliseconds')
  check(
    typeof input.level === 'number' && input.level > 0 && input.level < 1,
    'level must be in (0,1)',
  )
  const outcomes: MeasureValidityPlanOutcome[] = (input.outcomes ?? []).map((outcome) => ({
    id: outcome.id,
    direction: outcome.direction,
    kind: outcome.kind,
    ...(outcome.windowMs === undefined ? {} : { windowMs: outcome.windowMs }),
    ...(outcome.exposure === undefined
      ? {}
      : { exposure: { measure: outcome.exposure.measure, bins: outcome.exposure.bins ?? 10 } }),
  }))
  check(outcomes.length > 0, 'at least one outcome is required')
  for (const outcome of outcomes) {
    check(
      typeof outcome.id === 'string' && outcome.id.trim().length > 0,
      'outcome id must be nonempty',
    )
    check(
      outcome.direction === 'higher-is-better' || outcome.direction === 'lower-is-better',
      `outcome ${outcome.id} must declare higher-is-better or lower-is-better`,
    )
    check(
      outcome.kind === 'binary' || outcome.kind === 'continuous',
      `outcome ${outcome.id} must declare kind binary or continuous`,
    )
  }
  const measures = (input.measures ?? []).map((measure) => ({
    id: measure.id,
    ...(measure.noise === undefined ? {} : { noise: measure.noise }),
    ...(measure.cost === undefined ? {} : { cost: measure.cost }),
  }))
  check(measures.length > 0, 'at least one measure is required')
  for (const measure of measures) {
    check(
      typeof measure.id === 'string' && measure.id.trim().length > 0,
      'measure id must be nonempty',
    )
    check(
      measure.noise === undefined || (Number.isFinite(measure.noise) && measure.noise >= 0),
      `measure ${measure.id} noise must be finite and nonnegative`,
    )
    check(
      measure.cost === undefined || Number.isFinite(measure.cost),
      `measure ${measure.id} cost must be finite`,
    )
  }
  check(unique(outcomes.map((outcome) => outcome.id)), 'outcome ids must be unique')
  check(unique(measures.map((measure) => measure.id)), 'measure ids must be unique')
  const measureIds = new Set(measures.map((measure) => measure.id))
  for (const outcome of outcomes) {
    check(
      outcome.windowMs === undefined || (Number.isFinite(outcome.windowMs) && outcome.windowMs > 0),
      `outcome ${outcome.id} windowMs must be finite and positive`,
    )
    if (outcome.exposure === undefined) continue
    check(
      measureIds.has(outcome.exposure.measure),
      `outcome ${outcome.id} exposure must be a planned measure`,
    )
    check(
      Number.isSafeInteger(outcome.exposure.bins) && outcome.exposure.bins >= 2,
      `outcome ${outcome.id} exposure bins must be an integer >= 2`,
    )
  }
  const minJoined = input.minJoined ?? 100
  const minUnits = input.minUnits ?? 20
  const minMinority = input.minMinority ?? 20
  const resamples = input.resamples ?? 1000
  const confidence = input.confidence ?? 0.95
  const reduction = input.reduction ?? 'latest'
  const minSensitivity = input.minSensitivity ?? 0.05
  const selection: MeasureValidityPlanSelection = {
    maxMeasures: input.selection?.maxMeasures ?? 3,
    minGain: input.selection?.minGain ?? 0.01,
    maxRedundancy: input.selection?.maxRedundancy ?? 0.9,
    ...(current
      ? {
          minEffect: {
            auc: input.selection?.minEffect?.auc ?? 0.05,
            spearman: input.selection?.minEffect?.spearman ?? 0.1,
          },
        }
      : {}),
  }
  if (!current) {
    check(format === undefined, `format must be ${PLAN_FORMAT} or absent`)
    check(
      outcomes.every((outcome) => outcome.windowMs === undefined && outcome.exposure === undefined) &&
        input.selection?.minEffect === undefined,
      'a plan without format declares no outcome window, exposure or minimum effect',
    )
  }
  check(Number.isSafeInteger(minJoined) && minJoined >= 3, 'minJoined must be an integer >= 3')
  check(Number.isSafeInteger(minUnits) && minUnits >= 2, 'minUnits must be an integer >= 2')
  check(
    Number.isSafeInteger(minMinority) && minMinority >= 1,
    'minMinority must be a positive integer',
  )
  check(Number.isSafeInteger(resamples) && resamples >= 1, 'resamples must be a positive integer')
  check(confidence > 0 && confidence < 1, 'confidence must be in (0,1)')
  check(input.seed === undefined || Number.isSafeInteger(input.seed), 'seed must be an integer')
  check(
    reduction === 'latest' || reduction === 'mean' || reduction === 'max',
    'reduction must be latest, mean or max',
  )
  check(
    input.maxCaptureLagMs === undefined ||
      (Number.isFinite(input.maxCaptureLagMs) && input.maxCaptureLagMs >= 0),
    'maxCaptureLagMs must be finite and nonnegative',
  )
  check(minSensitivity >= 0 && minSensitivity <= 1, 'minSensitivity must be in [0,1]')
  check(
    Number.isSafeInteger(selection.maxMeasures) && selection.maxMeasures >= 1,
    'selection.maxMeasures must be a positive integer',
  )
  check(
    Number.isFinite(selection.minGain) && selection.minGain >= 0,
    'selection.minGain must be finite and nonnegative',
  )
  check(
    selection.maxRedundancy > 0 && selection.maxRedundancy <= 1,
    'selection.maxRedundancy must be in (0,1]',
  )
  const minEffect = selection.minEffect
  check(
    minEffect === undefined || (minEffect.auc >= 0 && minEffect.auc < 0.5),
    'selection.minEffect.auc must be in [0,0.5)',
  )
  check(
    minEffect === undefined || (minEffect.spearman >= 0 && minEffect.spearman < 1),
    'selection.minEffect.spearman must be in [0,1)',
  )
  if (problems.length > 0) {
    throw new ValidationError(`measure validity plan: ${problems.join('; ')}`)
  }
  return {
    ...(current ? { format: PLAN_FORMAT } : {}),
    id: input.id,
    cut: input.cut,
    level: input.level,
    outcomes,
    measures,
    minJoined,
    minUnits,
    minMinority,
    resamples,
    confidence,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    reduction,
    ...(input.maxCaptureLagMs === undefined ? {} : { maxCaptureLagMs: input.maxCaptureLagMs }),
    minSensitivity,
    selection,
  }
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}
