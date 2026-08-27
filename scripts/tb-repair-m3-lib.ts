/**
 * Milestone 3 shared pieces: the control every arm is screened under, and the
 * upgrade that carries a milestone-2 row into the current admission contract.
 *
 * The milestone-2 pre-pass recorded evidence before the contract required a
 * task name, a measured oracle-determinism verdict and a declared control. Those
 * three fields exist because of what this run has to get right: the verdict is
 * what refuses a task whose grader is a coin flip, and the declared control is
 * what proves both arms were screened by the same thing. Backfilling them from
 * measurements already taken lets the ADMISSION GATE exclude a nondeterministic
 * task, rather than a runner filtering rows by name and asking to be trusted.
 *
 * Nothing here invents a measurement. The determinism verdict is derived from
 * the recorded replicates by the same pure function the certification tool
 * calls, and the control policy restates the zero-step continuation the
 * milestone-2 controls and every rollout here actually run.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AdmissionCriteria,
  type AdmissionEvidence,
  type ControlPolicy,
  defineControlPolicy,
  oracleDeterminism,
  type OracleDeterminismEvidence,
  type OracleDeterminismVerdict,
  type RepairContinuationOutcome,
  TB_REPAIR_ADMISSION_CRITERIA,
} from '../src/trace-repair'

/** Where the certification run wrote one `determinism.json` per task. */
export const DETERMINISM_DIR =
  process.env.TBR_DETERMINISM_DIR ?? '/home/drew/bench-cache/oracle-determinism-20260810b'

/**
 * The control both control arms ran and every intervention rollout continues
 * under: zero model calls, so the graded bytes are the ones the arm wrote.
 *
 * `commandTimeoutSeconds` restates `STEP_TIMEOUT_MS` from the milestone-2
 * runner. The declaration is hashed, so this policy cannot share a digest with
 * a differently-budgeted one.
 */
export const M3_CONTROL_POLICY: ControlPolicy = defineControlPolicy({
  id: 'zero-step-continuation',
  stepBudget: 0,
  scaffold: 'mini-swe-agent',
  model: null,
  commandTimeoutSeconds: 300,
})

/**
 * The continuation runner, reporting the digest of the policy above.
 *
 * `gradeRepairRow` refuses a rollout whose continuation digest differs from the
 * digest its controls were screened under, so these two must come from one
 * declaration.
 */
export const m3ZeroStepContinuation = async (): Promise<RepairContinuationOutcome> => ({
  policyId: M3_CONTROL_POLICY.id,
  policyDigest: M3_CONTROL_POLICY.digest,
  steps: 0,
  exitStatus: 'zero-step-policy',
  submitted: false,
})

/**
 * The control runs zero model calls, so it executes no command and grades the
 * same bytes the end-state check already graded as failing. Under an `enforced`
 * reading, conditions 3 and 4 would claim to screen "repairable by continuing
 * alone" while being unable to fire on anything except a grader disagreeing
 * with itself. Declaring it inert is what makes a control pass readable as the
 * oracle flip it actually is — which is what the milestone-2
 * `no-fix-control-passed` rejections on largest-eigenval were.
 */
export const M3_CRITERIA: AdmissionCriteria = Object.freeze({
  ...TB_REPAIR_ADMISSION_CRITERIA,
  controlScreening: 'declared-inert',
})

/** `<task>::<row>::<trial>` — the task name is the first field. */
export function taskNameOf(rowId: string): string {
  const name = rowId.split('::')[0]
  if (!name) throw new Error(`row id ${rowId} carries no task name`)
  return name
}

const verdictCache = new Map<string, OracleDeterminismVerdict>()

/**
 * The task's determinism verdict, derived from its recorded replicates.
 *
 * Reduced here by the same pure function the certification tool uses, so the
 * verdict a row is admitted against is re-derivable from the replicates rather
 * than copied from a summary line.
 */
export function determinismVerdict(taskName: string): OracleDeterminismVerdict {
  const cached = verdictCache.get(taskName)
  if (cached) return cached
  const path = join(DETERMINISM_DIR, taskName, 'determinism.json')
  const evidence = JSON.parse(readFileSync(path, 'utf8')) as OracleDeterminismEvidence
  if (evidence.taskName !== taskName) {
    throw new Error(
      `determinism evidence at ${path} is for ${evidence.taskName}, not ${taskName}; ` +
        'a certification for another task is refused rather than read',
    )
  }
  const verdict = oracleDeterminism(evidence)
  verdictCache.set(taskName, verdict)
  return verdict
}

/** Evidence as milestone 2 recorded it, before the three fields existed. */
export interface LegacyAdmissionEvidence {
  readonly rowId: string
  readonly image: string
  readonly cwd: string
  readonly taskStatement: string
  readonly steps: AdmissionEvidence['steps']
  readonly prefixFidelity: AdmissionEvidence['prefixFidelity']
  readonly endStatePassed: boolean
  readonly suiteDigest: string
  readonly noFixControl: AdmissionEvidence['noFixControl']
  readonly noOpControl: AdmissionEvidence['noOpControl']
}

/**
 * Carry a recorded row into the current contract.
 *
 * The control arms' recorded `policyDigest` is restamped with the digest of the
 * declaration above. That is a rename, not a re-measurement: milestone 2 ran
 * these controls under a hand-written label for the same zero-step policy this
 * declaration hashes, and `admitRow` compares the two for equality, so one of
 * the two spellings has to be used throughout.
 */
export function upgradeEvidence(legacy: LegacyAdmissionEvidence): AdmissionEvidence {
  const taskName = taskNameOf(legacy.rowId)
  return {
    ...legacy,
    taskName,
    oracleDeterminism: determinismVerdict(taskName),
    controlPolicy: M3_CONTROL_POLICY,
    noFixControl: { ...legacy.noFixControl, policyDigest: M3_CONTROL_POLICY.digest },
    noOpControl: { ...legacy.noOpControl, policyDigest: M3_CONTROL_POLICY.digest },
  }
}
