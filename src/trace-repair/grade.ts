/**
 * Grade one analyst answer about one admitted row.
 *
 * The whole funnel runs here, in the order that spends the least before it
 * knows: parse and budget checks open no container, the reproduction gate
 * opens one, the local flip opens one more, and only then does the repair arm
 * pay for its rollouts.
 *
 * Two properties a reviewer should be able to check by reading this file:
 *
 * The intervention is applied at the k the analyst named, on the state
 * produced by replaying steps 1..k-1, and nowhere else. There is no search
 * over nearby steps, no credit for being close, and no label in scope — the
 * grader never receives one. A wrong k therefore scores zero the only honest
 * way it can: the repair has to work where the analyst said the failure was.
 *
 * The row must arrive branded by `admitRow`. That is the type-level form of
 * "admission runs before any analyst sees a row": there is no signature here
 * that accepts an unadmitted row.
 */

import { CaptureIntegrityError, ValidationError } from '../errors'
import { packageVersion } from '../package-version'
import { wrapActionForExec } from '../trajectory-replay/exec'
import {
  deriveFailureSignature,
  parseRecordedReturncode,
  type RecordedTrajectoryStep,
} from '../trajectory-replay/steps'
import { certificationEvidenceDigest, type DefaultVerdict } from '../verdict'
import {
  checkInterventionBudget,
  type InterventionBudget,
  normalizeActionForComparison,
  SCAFFOLD_INTERVENTION_BUDGET,
} from './action-budget'
import type { AdmittedRow } from './admission-contract'
import type { AnalystResponse, RepairFinding } from './analyst-response'
import type { ControlScreening } from './control-policy'
import {
  type InterventionExecution,
  type PrefixReplayEvidence,
  type RepairArmEvidence,
  type RepairCredit,
  type RepairGrade,
  type RepairRolloutEvidence,
  type ReproductionEvidence,
  repairCredit,
  type TestRunEvidence,
} from './funnel'
import { isRecordedTimeout } from './mini-swe-scaffold'
import type {
  RepairArm,
  RepairContinuationOutcome,
  RepairContinuationRunner,
  RepairSession,
  RepairSessionFactory,
  TestOracle,
} from './ports'

/** Rollouts of the repair arm disagreed with the controls about the policy. */
export class RepairArmSymmetryError extends CaptureIntegrityError {}

export interface GradeRepairOptions {
  readonly row: AdmittedRow
  readonly response: AnalystResponse
  readonly sessions: RepairSessionFactory
  readonly oracle: TestOracle
  readonly continuation: RepairContinuationRunner
  /** Repair rollouts for the intervention arm. Defaults to the row's own
   *  control rollout count so the arms are matched. */
  readonly repairRollouts?: number
  readonly budget?: InterventionBudget
  /** Wall-clock limit for one replayed or injected action. */
  readonly stepTimeoutMs?: number
  /**
   * Wall-clock limit for replaying a step the recording itself killed.
   *
   * Such a step carries no returncode, so the replay agrees with the recording
   * no matter how long it waits. Bounding it separately cuts what a prefix
   * costs without changing what it counts. Defaults to `stepTimeoutMs`.
   */
  readonly recordedTimeoutStepMs?: number
  readonly onProgress?: (message: string) => void
}

/** Extends the substrate verdict spine: `valid` = the intervention flipped
 *  the held-out suite in at least one measurement (locally or after the
 *  pinned continuation); `score` = the better of the two flip measurements
 *  (`localFlip`, `repairRate`), so `valid` ⟺ `score > 0`. The credit
 *  VECTOR stays authoritative in `credit` and travels in `scores` —
 *  Delta-repair pairing reads `delta`, never the scalar. Certification is
 *  present exactly when the suite executed (`outcome: 'measured'`); a
 *  closed gate certifies nothing. */
export interface RepairRowResult extends DefaultVerdict {
  readonly rowId: string
  readonly grade: RepairGrade
  readonly credit: RepairCredit
  /** P(tests pass | intervention). Equals `controlRate` when no intervention
   *  arm ran, because the row's state is then the control's state. */
  readonly interventionRate: number
  readonly controlRate: number
  readonly controlRollouts: number
  /** How the row's control pass was read. Travels with the result so a report
   *  can say whether a control rate of zero was screened or merely inert. */
  readonly controlScreening: ControlScreening
  readonly controlPolicyDigest: string
  readonly repairRollouts: number
  /** The row's paired contribution to Delta-repair. */
  readonly delta: number
  readonly wallMs: number
}

const DEFAULT_STEP_TIMEOUT_MS = 300_000
const OUTPUT_EXCERPT_CHARS = 4000

export async function gradeRepairRow(options: GradeRepairOptions): Promise<RepairRowResult> {
  const startedMs = Date.now()
  const grade = await produceGrade(options)
  return finish(options.row, grade, startedMs)
}

function finish(row: AdmittedRow, grade: RepairGrade, startedMs: number): RepairRowResult {
  const credit = repairCredit(grade)
  const interventionRate = grade.outcome === 'measured' ? credit.repairRate : row.controlRate
  const score = Math.max(credit.localFlip, credit.repairRate)
  return {
    rowId: row.rowId,
    grade,
    credit,
    interventionRate,
    controlRate: row.controlRate,
    controlRollouts: row.controlRollouts,
    controlScreening: row.controlScreening,
    controlPolicyDigest: row.policyDigest,
    repairRollouts: grade.outcome === 'measured' ? grade.repair.rollouts : 0,
    delta: interventionRate - row.controlRate,
    wallMs: Date.now() - startedMs,
    valid: score > 0,
    score,
    scores: { ...credit },
    notes: `outcome: ${grade.outcome}`,
    ...(grade.outcome === 'measured'
      ? {
          certification: {
            strategy: 'test',
            checker: {
              name: 'agent-eval:trace-repair-grader',
              version: packageVersion(),
              pins: { suite: row.suiteDigest, policy: row.policyDigest },
            },
            assumptions: gradeAssumptions(grade),
            evidenceDigest: certificationEvidenceDigest(grade),
          },
        }
      : {}),
  }
}

/** Steps a measured grade rests on that no suite run verified. */
function gradeAssumptions(grade: Extract<RepairGrade, { outcome: 'measured' }>): string[] {
  const assumptions: string[] = []
  if (grade.reproduction.basis === 'no-recorded-observation') {
    assumptions.push('step k recorded no observation — the reproduction gate passed vacuously')
  }
  const prefix = grade.execution.prefix
  if (prefix.divergences > 0) {
    assumptions.push(
      `${prefix.divergences} of ${prefix.stepsReplayed} replayed prefix steps diverged from the recording — the state at k is approximate`,
    )
  }
  return assumptions
}

async function produceGrade(options: GradeRepairOptions): Promise<RepairGrade> {
  const { row, response } = options
  if (response.kind === 'no-decisive-failure') return { outcome: 'declined' }

  const target = targetStep(row, response)
  if (!target.ok) return target.grade

  const budget = options.budget ?? SCAFFOLD_INTERVENTION_BUDGET
  const check = checkInterventionBudget(
    response.intervention.action,
    response.intervention.kind,
    budget,
  )
  if (!check.admissible) {
    return {
      outcome: 'rejected',
      rejection: {
        source: 'budget',
        reason: check.violation,
        detail: check.detail,
        measurement: check.measurement,
      },
    }
  }
  if (
    normalizeActionForComparison(response.intervention.action) ===
    normalizeActionForComparison(target.step.action)
  ) {
    return {
      outcome: 'rejected',
      rejection: {
        source: 'target',
        reason: 'recorded-action-reproposed',
        detail: `the intervention is the action already recorded at step ${response.k}`,
      },
    }
  }

  const reproduction = await runReproductionGate(options, response, target.step)
  if (!reproduction.reproduced) {
    return { outcome: 'not-reproduced', k: response.k, reproduction }
  }

  const local = await runLocalFlip(options, response)
  if (local.kind === 'did-not-execute') {
    return {
      outcome: 'did-not-execute',
      k: response.k,
      reproduction,
      execution: local.execution,
    }
  }

  const repair = await runRepairArm(options, response)
  return {
    outcome: 'measured',
    k: response.k,
    reproduction,
    execution: local.execution,
    localFlip: local.tests,
    repair,
  }
}

function targetStep(
  row: AdmittedRow,
  finding: RepairFinding,
): { ok: true; step: RecordedTrajectoryStep } | { ok: false; grade: RepairGrade } {
  if (finding.k < 1 || finding.k > row.steps.length) {
    return {
      ok: false,
      grade: {
        outcome: 'rejected',
        rejection: {
          source: 'target',
          reason: 'k-out-of-range',
          detail: `k=${finding.k} is outside [1, ${row.steps.length}]`,
        },
      },
    }
  }
  const step = row.steps[finding.k - 1]!
  if (step.step_id !== finding.k) {
    throw new ValidationError(
      `trace-repair: row ${row.rowId} steps[${finding.k - 1}].step_id=${step.step_id} != ${finding.k}; ` +
        'an admitted row must carry 1-based contiguous step ids',
    )
  }
  return { ok: true, step }
}

async function runReproductionGate(
  options: GradeRepairOptions,
  finding: RepairFinding,
  target: RecordedTrajectoryStep,
): Promise<ReproductionEvidence> {
  const { row } = options
  if (target.observation === null) {
    options.onProgress?.(
      `row ${row.rowId}: step ${finding.k} recorded no observation; the reproduction gate passes vacuously`,
    )
    return { basis: 'no-recorded-observation', reproduced: true }
  }
  const recordedReturncode = parseRecordedReturncode(target.observation)
  if (recordedReturncode === null) {
    throw new ValidationError(
      `trace-repair: row ${row.rowId} step ${finding.k} carries an observation with no <returncode>; ` +
        'the corpus row is malformed and must not have been admitted',
    )
  }
  const signature = deriveFailureSignature(target.observation)

  const session = await options.sessions.open({
    rowId: row.rowId,
    image: row.image,
    arm: 'reproduce',
    rolloutIndex: 0,
  })
  try {
    const prefix = await replayPrefix(session, options, finding.k)
    const result = await session.exec(
      wrapActionForExec(target.action, row.cwd),
      options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    )
    const output = `${result.stdout}\n${result.stderr}`
    const signatureObserved = signature === null ? null : output.includes(signature)
    const reproduced =
      !result.timedOut && result.exitCode === recordedReturncode && signatureObserved !== false
    options.onProgress?.(
      `row ${row.rowId}: reproduction at step ${finding.k} exit=${result.exitCode} ` +
        `(recorded ${recordedReturncode}) reproduced=${reproduced}`,
    )
    return {
      basis: signature === null ? 'returncode-only' : 'returncode+output-substring',
      reproduced,
      recordedReturncode,
      observedExitCode: result.exitCode,
      signature,
      signatureObserved,
      prefix,
    }
  } finally {
    await session.close()
  }
}

type LocalFlipOutcome =
  | { kind: 'did-not-execute'; execution: InterventionExecution }
  | { kind: 'measured'; execution: InterventionExecution; tests: TestRunEvidence }

async function runLocalFlip(
  options: GradeRepairOptions,
  finding: RepairFinding,
): Promise<LocalFlipOutcome> {
  const { row } = options
  const session = await options.sessions.open({
    rowId: row.rowId,
    image: row.image,
    arm: 'local-flip',
    rolloutIndex: 0,
  })
  try {
    const prefix = await replayPrefix(session, options, finding.k)
    const startedMs = Date.now()
    const result = await session.exec(
      wrapActionForExec(finding.intervention.action, row.cwd),
      options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    )
    const output = `${result.stdout}\n${result.stderr}`.trim()
    const execution: InterventionExecution = {
      command: finding.intervention.action,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      wallMs: Date.now() - startedMs,
      output: excerpt(output),
      prefix,
    }
    if (result.timedOut || result.exitCode !== 0) {
      options.onProgress?.(
        `row ${row.rowId}: the intervention did not run at step ${finding.k} ` +
          `(exit=${result.exitCode} timedOut=${result.timedOut})`,
      )
      return { kind: 'did-not-execute', execution }
    }
    const tests = await gradeTests(options, session, 'local-flip', 0)
    options.onProgress?.(
      `row ${row.rowId}: local flip=${tests.passed} after the intervention at step ${finding.k}`,
    )
    return { kind: 'measured', execution, tests }
  } finally {
    await session.close()
  }
}

async function runRepairArm(
  options: GradeRepairOptions,
  finding: RepairFinding,
): Promise<RepairArmEvidence> {
  const { row } = options
  const rollouts = options.repairRollouts ?? row.controlRollouts
  if (!Number.isInteger(rollouts) || rollouts <= 0) {
    throw new ValidationError(`repairRollouts must be a positive integer, got ${rollouts}`)
  }
  const evidence: RepairRolloutEvidence[] = []
  let passes = 0
  let interventionFailures = 0
  let policyDigest: string | null = null

  for (let index = 0; index < rollouts; index += 1) {
    const session = await options.sessions.open({
      rowId: row.rowId,
      image: row.image,
      arm: 'intervention',
      rolloutIndex: index,
    })
    try {
      await replayPrefix(session, options, finding.k)
      const result = await session.exec(
        wrapActionForExec(finding.intervention.action, row.cwd),
        options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      )
      if (result.timedOut || result.exitCode !== 0) {
        interventionFailures += 1
        evidence.push({
          rolloutIndex: index,
          status: 'intervention-failed',
          interventionExitCode: result.exitCode,
          timedOut: result.timedOut,
        })
        continue
      }
      const continuation = await options.continuation({
        rowId: row.rowId,
        arm: 'intervention',
        rolloutIndex: index,
        session,
        steps: row.steps,
        k: finding.k,
        injected: {
          action: finding.intervention.action,
          returncode: result.exitCode,
          output: `${result.stdout}\n${result.stderr}`.trim(),
          timedOut: result.timedOut,
        },
        taskStatement: row.taskStatement,
      })
      assertPolicySymmetry(row, continuation, index)
      policyDigest = continuation.policyDigest
      const tests = await gradeTests(options, session, 'intervention', index)
      if (tests.passed) passes += 1
      evidence.push({
        rolloutIndex: index,
        status: 'completed',
        interventionExitCode: result.exitCode,
        continuation,
        tests,
      })
      options.onProgress?.(
        `row ${row.rowId}: repair rollout ${index} tests=${tests.passed} ` +
          `after ${continuation.steps} continuation steps (${continuation.exitStatus})`,
      )
    } finally {
      await session.close()
    }
  }

  return { rollouts, passes, interventionFailures, policyDigest, rolloutEvidence: evidence }
}

function assertPolicySymmetry(
  row: AdmittedRow,
  continuation: RepairContinuationOutcome,
  index: number,
): void {
  if (continuation.policyDigest !== row.policyDigest) {
    throw new RepairArmSymmetryError(
      `row ${row.rowId} repair rollout ${index} ran policy ${continuation.policyDigest} but its ` +
        `controls ran ${row.policyDigest}; the difference between the arms would not be the intervention`,
    )
  }
}

async function gradeTests(
  options: GradeRepairOptions,
  session: RepairSession,
  arm: RepairArm,
  rolloutIndex: number,
): Promise<TestRunEvidence> {
  const outcome = await options.oracle.grade(session, {
    rowId: options.row.rowId,
    arm,
    rolloutIndex,
  })
  if (outcome.suiteDigest !== options.row.suiteDigest) {
    throw new RepairArmSymmetryError(
      `row ${options.row.rowId} was admitted against suite ${options.row.suiteDigest} but the ${arm} arm ` +
        `graded against ${outcome.suiteDigest}; the arms did not answer the same question`,
    )
  }
  return {
    passed: outcome.passed,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    suiteDigest: outcome.suiteDigest,
  }
}

/** Replay recorded steps 1..k-1 to rebuild the state the intervention lands
 *  on. Divergence is counted and reported, never repaired. */
async function replayPrefix(
  session: RepairSession,
  options: GradeRepairOptions,
  k: number,
): Promise<PrefixReplayEvidence> {
  const { row } = options
  const timeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const recordedTimeoutMs = options.recordedTimeoutStepMs ?? timeoutMs
  const startedMs = Date.now()
  let divergences = 0
  let stepsReplayed = 0
  for (const step of row.steps.slice(0, k - 1)) {
    const bound = isRecordedTimeout(step.observation) ? recordedTimeoutMs : timeoutMs
    const result = await session.exec(wrapActionForExec(step.action, row.cwd), bound)
    stepsReplayed += 1
    const recorded = parseRecordedReturncode(step.observation)
    if (recorded !== null && recorded !== result.exitCode) divergences += 1
  }
  return { stepsReplayed, divergences, wallMs: Date.now() - startedMs }
}

function excerpt(text: string): string {
  if (text.length <= OUTPUT_EXCERPT_CHARS) return text
  const half = Math.floor(OUTPUT_EXCERPT_CHARS / 2)
  return `${text.slice(0, half)}\n… [${text.length - OUTPUT_EXCERPT_CHARS} chars elided] …\n${text.slice(-half)}`
}
