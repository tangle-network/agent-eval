/**
 * Admission: the four executed checks a row must pass before an analyst is
 * allowed to see it, and the brand that proves it did.
 *
 * Every check is analyst-independent. None of them reads a finding, a label,
 * or a k, and all of them are anchored at the recorded end state — the point
 * the agent actually stopped at — so the same evidence admits a row no matter
 * which step an analyst later blames:
 *
 *   prefix-fidelity    the recorded trajectory replays with at most 10 % of
 *                      its steps diverging from their recorded returncode
 *   end-state-fails    the held-out suite fails on the recorded end state
 *   no-fix-control     3 of 3 continuations from the end state fail
 *   no-op-control      3 of 3 continuations from the end state, after an
 *                      action that changes nothing, fail
 *
 * The last two are what make `Delta-repair` a difference rather than a rate.
 * They are also what stops a row where the agent was one free step from
 * success from counting as a repair the analyst caused.
 *
 * This module owns the CONTRACT, not the execution. A campaign runner
 * executes the checks against real containers and hands the measured evidence
 * to `admitRow`, which decides and brands. Splitting it that way keeps the
 * decision auditable from the recorded numbers alone: a reviewer can re-derive
 * every admission from the evidence file without re-running a container.
 */

import { ValidationError } from '../errors'
import type { RecordedTrajectoryStep } from '../trajectory-replay/steps'

/** Pre-registered admission thresholds. */
export interface AdmissionCriteria {
  /** Share of replayed prefix steps allowed to diverge from their recorded
   *  returncode. Above it the container state under test is not the recorded
   *  one, so nothing measured on it is about the recorded run. */
  readonly maxPrefixDivergenceRatio: number
  /** Control rollouts each control arm must run. */
  readonly controlRollouts: number
}

export const TB_REPAIR_ADMISSION_CRITERIA: AdmissionCriteria = Object.freeze({
  maxPrefixDivergenceRatio: 0.1,
  controlRollouts: 3,
})

export interface PrefixFidelityEvidence {
  /** Recorded steps that were replayed. */
  readonly stepsReplayed: number
  /** Replayed steps whose exit code differed from the recorded returncode. */
  readonly divergences: number
}

export interface ControlArmEvidence {
  readonly rollouts: number
  /** Rollouts whose held-out suite passed. Admission requires zero. */
  readonly passes: number
  /** Policy digest every rollout reported. Arms that disagree are not
   *  comparable, so the grader checks its own rollouts against this. */
  readonly policyDigest: string
}

export interface AdmissionEvidence {
  readonly rowId: string
  /** Published image the trajectory was recorded against. */
  readonly image: string
  /** Working directory the scaffold ran every action from. */
  readonly cwd: string
  /** Task statement handed to the recorded agent. */
  readonly taskStatement: string
  readonly steps: readonly RecordedTrajectoryStep[]
  readonly prefixFidelity: PrefixFidelityEvidence
  /** Held-out suite result on the recorded end state. Admission requires a fail. */
  readonly endStatePassed: boolean
  /** Digest of the suite that produced every result above. */
  readonly suiteDigest: string
  readonly noFixControl: ControlArmEvidence
  readonly noOpControl: ControlArmEvidence
}

/** Which pre-registered check refused the row. */
export type AdmissionRejection =
  | 'prefix-divergence-too-high'
  | 'end-state-already-passes'
  | 'no-fix-control-passed'
  | 'no-op-control-passed'
  | 'control-rollouts-short'
  | 'control-policy-mismatch'
  | 'empty-trajectory'

declare const ADMITTED: unique symbol

/**
 * A row that passed every admission check.
 *
 * The brand is a phantom: it exists in the type and never in the value, and
 * the symbol that names it is not exported, so `AdmittedRow` cannot be
 * constructed anywhere but here. Both `blindTrajectory` and `gradeRepairRow`
 * require one. That is the structural form of "admission runs before any
 * analyst sees a row": there is no signature that accepts an unadmitted row.
 */
export interface AdmittedRow {
  readonly [ADMITTED]: true
  readonly rowId: string
  readonly image: string
  readonly cwd: string
  readonly taskStatement: string
  readonly steps: readonly RecordedTrajectoryStep[]
  readonly criteria: AdmissionCriteria
  readonly prefixDivergenceRatio: number
  readonly suiteDigest: string
  /** Policy digest both controls ran under. Every intervention rollout must
   *  report the same one or the arms are not comparable. */
  readonly policyDigest: string
  /** Control rate the paired delta subtracts. Zero by admission, carried
   *  explicitly so the estimator never hardcodes it. */
  readonly controlRate: number
  readonly controlRollouts: number
}

export type AdmissionOutcome =
  | { readonly admitted: true; readonly row: AdmittedRow }
  | {
      readonly admitted: false
      readonly rowId: string
      readonly rejection: AdmissionRejection
      readonly detail: string
    }

/**
 * Decide admission from executed evidence.
 *
 * Pure: it opens no container and calls no model. Every threshold it applies
 * is in `criteria`, and every number it reads is in `evidence`, so an
 * admission decision is reproducible from the recorded evidence alone.
 */
export function admitRow(
  evidence: AdmissionEvidence,
  criteria: AdmissionCriteria = TB_REPAIR_ADMISSION_CRITERIA,
): AdmissionOutcome {
  assertCriteria(criteria)
  const reject = (rejection: AdmissionRejection, detail: string): AdmissionOutcome => ({
    admitted: false,
    rowId: evidence.rowId,
    rejection,
    detail,
  })

  if (evidence.steps.length === 0) {
    return reject('empty-trajectory', 'the row records no steps')
  }
  const { stepsReplayed, divergences } = evidence.prefixFidelity
  if (stepsReplayed <= 0) {
    return reject('empty-trajectory', 'no recorded step was replayed')
  }
  const prefixDivergenceRatio = divergences / stepsReplayed
  if (prefixDivergenceRatio > criteria.maxPrefixDivergenceRatio) {
    return reject(
      'prefix-divergence-too-high',
      `${divergences}/${stepsReplayed} replayed steps diverged (${(prefixDivergenceRatio * 100).toFixed(1)} %), ` +
        `above the ${(criteria.maxPrefixDivergenceRatio * 100).toFixed(1)} % ceiling`,
    )
  }
  if (evidence.endStatePassed) {
    return reject(
      'end-state-already-passes',
      'the held-out suite passes on the recorded end state, so the row records no failure to repair',
    )
  }
  for (const [name, arm, rejection] of [
    ['no-fix control', evidence.noFixControl, 'no-fix-control-passed'],
    ['no-op control', evidence.noOpControl, 'no-op-control-passed'],
  ] as const) {
    if (arm.rollouts !== criteria.controlRollouts) {
      return reject(
        'control-rollouts-short',
        `${name} ran ${arm.rollouts} rollouts, the criteria pre-register ${criteria.controlRollouts}`,
      )
    }
    if (arm.passes !== 0) {
      return reject(
        rejection,
        `${name} passed ${arm.passes}/${arm.rollouts}; the row is repairable by continuing alone`,
      )
    }
  }
  if (evidence.noFixControl.policyDigest !== evidence.noOpControl.policyDigest) {
    return reject(
      'control-policy-mismatch',
      `no-fix control ran policy ${evidence.noFixControl.policyDigest} and no-op control ran ` +
        `${evidence.noOpControl.policyDigest}; the controls are not comparable`,
    )
  }

  return {
    admitted: true,
    // The brand is type-level only, so the branded value carries no phantom
    // property a consumer could copy to forge one.
    row: {
      rowId: evidence.rowId,
      image: evidence.image,
      cwd: evidence.cwd,
      taskStatement: evidence.taskStatement,
      steps: evidence.steps,
      criteria,
      prefixDivergenceRatio,
      suiteDigest: evidence.suiteDigest,
      policyDigest: evidence.noFixControl.policyDigest,
      controlRate: evidence.noFixControl.passes / evidence.noFixControl.rollouts,
      controlRollouts: evidence.noFixControl.rollouts,
    } as unknown as AdmittedRow,
  }
}

function assertCriteria(criteria: AdmissionCriteria): void {
  const { maxPrefixDivergenceRatio, controlRollouts } = criteria
  if (!(maxPrefixDivergenceRatio >= 0 && maxPrefixDivergenceRatio <= 1)) {
    throw new ValidationError(
      `admission maxPrefixDivergenceRatio must be within [0,1], got ${maxPrefixDivergenceRatio}`,
    )
  }
  if (!Number.isInteger(controlRollouts) || controlRollouts <= 0) {
    throw new ValidationError(
      `admission controlRollouts must be a positive integer, got ${controlRollouts}`,
    )
  }
}
