/**
 * Admission: the executed checks a row must pass before an analyst is allowed
 * to see it, and the brand that proves it did.
 *
 * Every check is analyst-independent. None of them reads a finding, a label,
 * or a k, and all of them are anchored at the recorded end state — the point
 * the agent actually stopped at — so the same evidence admits a row no matter
 * which step an analyst later blames:
 *
 *   oracle-determinism the task's own suite returns one verdict on identical
 *                      bytes, so its answer is about the state
 *   prefix-fidelity    the recorded trajectory replays with at most 10 % of
 *                      its steps diverging from their recorded returncode
 *   end-state-fails    the held-out suite fails on the recorded end state
 *   no-fix-control     3 of 3 continuations from the end state fail
 *   no-op-control      3 of 3 continuations from the end state, after an
 *                      action that changes nothing, fail
 *
 * The two controls are what make `Delta-repair` a difference rather than a
 * rate, and what stops a row where the agent was one free step from success
 * from counting as a repair the analyst caused. They only do that under a
 * control that can act: `control-policy.ts` holds the declaration, and the
 * criteria name which reading of a control pass applies.
 *
 * The determinism check sits in front of all of it. Every downstream check
 * reads the same suite, so a suite whose verdict is not a function of the state
 * makes each of them a coin flip rather than a measurement.
 *
 * This module owns the CONTRACT, not the execution. `runAdmission` in
 * `./admission` executes the checks against real containers and hands the
 * measured evidence to `admitRow`, which decides and brands. Splitting it that
 * way keeps the decision auditable from the recorded numbers alone: a reviewer
 * can re-derive every admission from the evidence file without re-running a
 * container.
 */

import { ValidationError } from '../errors'
import type { RecordedTrajectoryStep } from '../trajectory-replay/steps'
import {
  assertControlCalibrated,
  type ControlPolicy,
  type ControlScreening,
} from './control-policy'
import type { OracleDeterminismVerdict } from './oracle-determinism'

/** Pre-registered admission thresholds. */
export interface AdmissionCriteria {
  /** Share of replayed prefix steps allowed to diverge from their recorded
   *  returncode. Above it the container state under test is not the recorded
   *  one, so nothing measured on it is about the recorded run. */
  readonly maxPrefixDivergenceRatio: number
  /** Control rollouts each control arm must run. */
  readonly controlRollouts: number
  /** How a control pass is read. `enforced` requires a control that can act. */
  readonly controlScreening: ControlScreening
}

export const TB_REPAIR_ADMISSION_CRITERIA: AdmissionCriteria = Object.freeze({
  maxPrefixDivergenceRatio: 0.1,
  controlRollouts: 3,
  controlScreening: 'enforced' as ControlScreening,
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
  /** Policy digest every rollout reported. An arm that ran something other
   *  than the declared control is not the control the criteria describe. */
  readonly policyDigest: string
}

export interface AdmissionEvidence {
  readonly rowId: string
  /** Terminal-Bench-2 task the trajectory ran. It selects the certification
   *  below, and a certification for another task is refused rather than read. */
  readonly taskName: string
  /** Published image the trajectory was recorded against. */
  readonly image: string
  /** Working directory the scaffold ran every action from. */
  readonly cwd: string
  /** Task statement handed to the recorded agent. */
  readonly taskStatement: string
  readonly steps: readonly RecordedTrajectoryStep[]
  /**
   * The task's certified oracle determinism. Required: a campaign that has not
   * measured whether its ground truth is a function of the state cannot
   * construct evidence, which is where that omission should stop.
   */
  readonly oracleDeterminism: OracleDeterminismVerdict
  /** The control both arms ran, declared and hashed. */
  readonly controlPolicy: ControlPolicy
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
  | 'task-oracle-nondeterministic'
  | 'prefix-divergence-too-high'
  | 'end-state-already-passes'
  | 'no-fix-control-passed'
  | 'no-op-control-passed'
  | 'control-passed-on-identical-state'
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
  readonly taskName: string
  readonly image: string
  readonly cwd: string
  readonly taskStatement: string
  readonly steps: readonly RecordedTrajectoryStep[]
  readonly criteria: AdmissionCriteria
  readonly prefixDivergenceRatio: number
  readonly suiteDigest: string
  /** The control the row was screened under, carried whole so a later reader
   *  never has to open the runner's source to learn what screened it. */
  readonly controlPolicy: ControlPolicy
  readonly controlScreening: ControlScreening
  /** Policy digest both controls ran under. Every intervention rollout must
   *  report the same one or the arms are not comparable. */
  readonly policyDigest: string
  /** Control rate the paired delta subtracts. Zero by admission, carried
   *  explicitly so the estimator never hardcodes it. */
  readonly controlRate: number
  readonly controlRollouts: number
}

/** Carried by every decision, admitted or not, so an artifact answers "which
 *  control screened this row" without reading the runner's source. */
export interface AdmissionScreeningRecord {
  readonly controlPolicy: ControlPolicy
  readonly controlScreening: ControlScreening
  readonly controlPolicyDigest: string
  readonly taskName: string
  readonly oracleStable: boolean
  readonly oracleFlipRate: number
}

export type AdmissionDecision =
  | {
      readonly admitted: true
      readonly screening: AdmissionScreeningRecord
      readonly row: AdmittedRow
    }
  | {
      readonly admitted: false
      readonly rowId: string
      readonly screening: AdmissionScreeningRecord
      readonly rejection: AdmissionRejection
      readonly detail: string
    }

/**
 * Decide admission from executed evidence.
 *
 * Pure: it opens no container and calls no model. Every threshold it applies
 * is in `criteria`, and every number it reads is in `evidence`, so an
 * admission decision is reproducible from the recorded evidence alone.
 *
 * It throws, rather than rejecting, when the criteria and the declared control
 * contradict. A contradiction there is a property of the configuration and not
 * of the row, so it must stop the run instead of producing one verdict per row
 * that reads as if a check had been applied.
 */
export function admitRow(
  evidence: AdmissionEvidence,
  criteria: AdmissionCriteria = TB_REPAIR_ADMISSION_CRITERIA,
): AdmissionDecision {
  assertCriteria(criteria)
  assertControlCalibrated(evidence.controlPolicy, criteria.controlScreening)
  // A certification measured on another task says nothing about this one, and
  // reading it as if it did is the same corruption the certification exists to
  // prevent. It is a wiring fault, so it stops the run.
  if (evidence.oracleDeterminism.taskName !== evidence.taskName) {
    throw new ValidationError(
      `row ${evidence.rowId} is from task ${evidence.taskName} but carries the oracle ` +
        `certification for ${evidence.oracleDeterminism.taskName}`,
    )
  }

  const screening: AdmissionScreeningRecord = {
    controlPolicy: evidence.controlPolicy,
    controlScreening: criteria.controlScreening,
    controlPolicyDigest: evidence.controlPolicy.digest,
    taskName: evidence.oracleDeterminism.taskName,
    oracleStable: evidence.oracleDeterminism.stable,
    oracleFlipRate: evidence.oracleDeterminism.flipRate,
  }
  const reject = (rejection: AdmissionRejection, detail: string): AdmissionDecision => ({
    admitted: false,
    rowId: evidence.rowId,
    screening,
    rejection,
    detail,
  })

  const oracle = evidence.oracleDeterminism
  if (!oracle.stable) {
    return reject(
      'task-oracle-nondeterministic',
      `task ${oracle.taskName} graded byte-identical state inconsistently: flip rate ` +
        `${(oracle.flipRate * 100).toFixed(1)} % over ${oracle.replicates} replicates ` +
        `(${oracle.detail}). Every check below reads that suite, so none of them measures state.`,
    )
  }

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
  for (const [name, arm, rescued] of [
    ['no-fix control', evidence.noFixControl, 'no-fix-control-passed'],
    ['no-op control', evidence.noOpControl, 'no-op-control-passed'],
  ] as const) {
    if (arm.rollouts !== criteria.controlRollouts) {
      return reject(
        'control-rollouts-short',
        `${name} ran ${arm.rollouts} rollouts, the criteria pre-register ${criteria.controlRollouts}`,
      )
    }
    if (arm.policyDigest !== evidence.controlPolicy.digest) {
      return reject(
        'control-policy-mismatch',
        `${name} reported policy ${arm.policyDigest} but the criteria screen under ` +
          `${evidence.controlPolicy.id} (${evidence.controlPolicy.digest}); the arm did not run the declared control`,
      )
    }
    if (arm.passes !== 0) {
      // Under a control that cannot act, the arm graded the same bytes the
      // end-state check read as failing. That is the task's grader answering
      // twice about one state, so it is recorded as the flip and never as a
      // rescue the control performed.
      return criteria.controlScreening === 'enforced'
        ? reject(
            rescued,
            `${name} passed ${arm.passes}/${arm.rollouts}; the row is repairable by continuing alone`,
          )
        : reject(
            'control-passed-on-identical-state',
            `${name} passed ${arm.passes}/${arm.rollouts} under ${evidence.controlPolicy.id}, which ` +
              'executes no command, so it graded the same bytes the end-state check graded as failing. ' +
              `The task's certification reports flip rate ${(oracle.flipRate * 100).toFixed(1)} %; this row ` +
              'is a further flip, not a rescue.',
          )
    }
  }

  return {
    admitted: true,
    screening,
    // The brand is type-level only, so the branded value carries no phantom
    // property a consumer could copy to forge one.
    row: {
      rowId: evidence.rowId,
      taskName: evidence.taskName,
      image: evidence.image,
      cwd: evidence.cwd,
      taskStatement: evidence.taskStatement,
      steps: evidence.steps,
      criteria,
      prefixDivergenceRatio,
      suiteDigest: evidence.suiteDigest,
      controlPolicy: evidence.controlPolicy,
      controlScreening: criteria.controlScreening,
      policyDigest: evidence.controlPolicy.digest,
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
