/**
 * Changes and the outcomes joined to them, shared by the measure validity
 * study and the guard drift check. Internal to `meta-eval`; `MeasuredChange`
 * is public through the barrel.
 */

import { ValidationError } from '../errors'
import type {
  MeasureValidityOutcome,
  MeasureValidityPlan,
} from '../experiment/measure-validity-plan'
import { reduceOutcomeObservation } from './outcome-observations'
import type { DeploymentOutcome } from './outcome-store'

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

export interface JoinedOutcome {
  /** 0 or 1 for binary (1 is better); the direction-aligned value for continuous. */
  better: number
  capturedAt: number
}

export interface PreparedChange {
  change: MeasuredChange
  preCut: boolean
  outcomes: Map<string, JoinedOutcome>
}

export function validateChanges(
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

/**
 * The observations a change may join, each excluded one counted under the
 * first reason that applies. `asOf` is when the outcomes were read: nothing
 * captured after it can have been known.
 */
export function eligibleObservations(
  observations: readonly DeploymentOutcome[],
  change: MeasuredChange,
  plan: MeasureValidityPlan,
  preCut: boolean,
  asOf?: number,
) {
  const counts = {
    capturedBeforeChange: 0,
    capturedAfterAsOf: 0,
    capturedAfterCutForPreCutChange: 0,
    beyondMaxCaptureLag: 0,
  }
  const eligible: DeploymentOutcome[] = []
  for (const observation of observations) {
    if (observation.capturedAt < change.at) counts.capturedBeforeChange++
    else if (asOf !== undefined && observation.capturedAt > asOf) counts.capturedAfterAsOf++
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

export function joinOutcomes(
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

export function statisticOf(outcome: MeasureValidityOutcome): 'auc' | 'spearman' {
  return outcome.kind === 'binary' ? 'auc' : 'spearman'
}
