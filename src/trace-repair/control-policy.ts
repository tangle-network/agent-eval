/**
 * The control policy admission screens under, declared rather than assumed.
 *
 * Admission conditions 3 and 4 ask whether a row is rescued by continuing from
 * the recorded end state with no intervention, and by continuing after an
 * action that changes nothing. Both are questions about a policy, and neither
 * is answerable without knowing what that policy is allowed to do.
 *
 * One number decides whether the question can be answered at all. Condition 2
 * has already graded the recorded end state and found it failing. A control
 * rollout that makes no model call executes no command, so the container it
 * grades holds those same bytes — the ones already graded as failing. Under
 * such a policy a control pass is not a rescue; it is the task's own grader
 * answering differently about identical state. The condition cannot fire for
 * the reason it exists, and every row walks through it.
 *
 * So the policy is a required, hashed parameter that lands on every admission
 * decision, and a configuration whose control cannot reach the outcome it
 * screens for is refused where it is configured rather than passed silently.
 */

import { CaptureIntegrityError, ValidationError } from '../errors'
import { contentHash } from '../verdict-cache'

/** The declared control cannot produce the outcome the criteria screen for. */
export class UncalibratedControlError extends CaptureIntegrityError {}

/**
 * What the criteria expect of the control.
 *
 * - `enforced` — conditions 3 and 4 decide admission, so the control must be
 *   able to rescue a row.
 * - `declared-inert` — the campaign has pinned a control that cannot rescue
 *   anything (a calibration run comparing arms at equal depth, for instance).
 *   Conditions 3 and 4 still run, but a pass then means the task's grader
 *   disagreed with itself about identical state, and the row leaves as that.
 */
export type ControlScreening = 'enforced' | 'declared-inert'

export const CONTROL_SCREENING_MODES: readonly ControlScreening[] = ['enforced', 'declared-inert']

export interface ControlPolicyInput {
  /** Stable name for the frozen configuration. */
  readonly id: string
  /** Model calls one control rollout may make after the arm's own treatment. */
  readonly stepBudget: number
  /** Scaffold the rollout runs under. */
  readonly scaffold: string
  /** Requested model id, or `null` when the budget calls no model. */
  readonly model: string | null
  /** Per-command wall-clock limit inside the container. */
  readonly commandTimeoutSeconds: number
}

/**
 * The part of a control the calibration rule reads.
 *
 * Both admission paths declare a control in their own vocabulary — the pure
 * contract takes a `ControlPolicy`, the executing pre-pass runs a pinned
 * continuation policy — and both are checked by one rule against this shape,
 * so the two cannot drift into disagreeing about what a usable control is.
 */
export interface ControlCapability {
  readonly id: string
  readonly digest: string
  /** Model calls one control rollout may make after the arm's own treatment. */
  readonly stepBudget: number
}

export interface ControlPolicy extends ControlPolicyInput, ControlCapability {
  /** Hash over the whole declaration. A hand-written label cannot stand in for
   *  it, so two runs cannot share a digest while differing in step budget. */
  readonly digest: string
  /**
   * Whether a rollout under this policy can reach a state the recorded end
   * state was not already in. False at a zero step budget: no model call means
   * no command, which means the graded bytes are the ones condition 2 read.
   */
  readonly canRescue: boolean
}

/**
 * A control rollout changes the graded state only by executing something, and
 * it executes only what a model call asks for. At a zero budget it grades the
 * bytes it was handed.
 */
export function controlCanRescue(stepBudget: number): boolean {
  return stepBudget > 0
}

export function defineControlPolicy(input: ControlPolicyInput): ControlPolicy {
  if (!input.id.trim()) throw new ValidationError('control policy requires an id')
  if (!input.scaffold.trim()) throw new ValidationError('control policy requires a scaffold name')
  if (!Number.isInteger(input.stepBudget) || input.stepBudget < 0) {
    throw new ValidationError(
      `control policy stepBudget must be a non-negative integer, got ${input.stepBudget}`,
    )
  }
  if (!Number.isInteger(input.commandTimeoutSeconds) || input.commandTimeoutSeconds <= 0) {
    throw new ValidationError(
      `control policy commandTimeoutSeconds must be a positive integer, got ${input.commandTimeoutSeconds}`,
    )
  }
  // The model is the other half of "which control screened this row". A budget
  // that calls a model without naming one, or names one it will never call,
  // makes the recorded policy unreadable either way.
  if (input.stepBudget === 0 && input.model !== null) {
    throw new ValidationError(
      `control policy ${input.id} declares model ${input.model} at a zero step budget; ` +
        'a policy that makes no model call must record model: null',
    )
  }
  if (input.stepBudget > 0 && !input.model?.trim()) {
    throw new ValidationError(
      `control policy ${input.id} allows ${input.stepBudget} model call(s) but names no model`,
    )
  }
  const declaration: ControlPolicyInput = {
    id: input.id,
    stepBudget: input.stepBudget,
    scaffold: input.scaffold,
    model: input.model,
    commandTimeoutSeconds: input.commandTimeoutSeconds,
  }
  return Object.freeze({
    ...declaration,
    digest: contentHash(declaration),
    canRescue: controlCanRescue(input.stepBudget),
  })
}

/**
 * Refuse a configuration whose control and screening mode contradict.
 *
 * Both directions are faults, and both are silent without this. A screening
 * control that cannot act passes every row through a condition it can never
 * fire. A control declared inert that can in fact act hides a real screen
 * behind a label that says nothing was screened.
 */
export function assertControlCalibrated(
  policy: ControlCapability,
  screening: ControlScreening,
): void {
  if (!CONTROL_SCREENING_MODES.includes(screening)) {
    throw new ValidationError(`unknown control screening mode: ${screening}`)
  }
  const canRescue = controlCanRescue(policy.stepBudget)
  if (screening === 'enforced' && !canRescue) {
    throw new UncalibratedControlError(
      `control policy ${policy.id} (digest ${policy.digest}) allows ${policy.stepBudget} model ` +
        'call(s) per rollout, so a control rollout executes no command and grades the same bytes ' +
        'the end-state check already graded as failing. Under it conditions 3 and 4 can only fire ' +
        'on a grader that disagrees with itself, so they screen nothing. Give the control a step ' +
        "budget of at least 1, or set controlScreening to 'declared-inert' and read a control pass " +
        'as the oracle flip it is.',
    )
  }
  if (screening === 'declared-inert' && canRescue) {
    throw new UncalibratedControlError(
      `control policy ${policy.id} (digest ${policy.digest}) allows ${policy.stepBudget} model ` +
        'call(s) per rollout, so it can rescue a row, but the criteria declare it inert. Set ' +
        "controlScreening to 'enforced' so a control pass is recorded as a rescue.",
    )
  }
}
