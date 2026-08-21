/**
 * The five-tier funnel and the only thing in it that pays.
 *
 *   t0  parsed          one finding or the literal decline, inside the budget
 *   t1  reproduced      the recorded state at k comes back under replay
 *   t2  executes        the intervention runs at k
 *   t3  local flip      the held-out suite passes immediately after it
 *   t4  repair flip     the suite passes after the pinned policy continues
 *
 * t0, t1 and t2 are nested gates. t3 and t4 are two different measurements of
 * the same intervention and neither contains the other: an intervention that
 * fixes the task outright flips locally, and one that unblocks an agent which
 * still has work left flips only after the continuation.
 *
 * `t1` is a gate that pays nothing, and that is structural rather than a
 * convention: `RepairCredit` has no reproduction term, so there is no field to
 * award. Naming a step whose nonzero exit reproduces earns exactly what naming
 * one that does not earns.
 *
 * Reproduction is deliberately not "a nonzero exit came back". Most admitted
 * rows end on a clean exit — the agent believed it was finished and the tests
 * disagreed — so the gate asks whether the RECORDED state at k reproduces,
 * whatever that state was, including a returncode of zero.
 */

import type { BudgetMeasurement, BudgetViolation } from './action-budget'
import type { ResponseParseFailure } from './analyst-response'
import type { RepairContinuationOutcome } from './ports'

/** Why an answer never reached the reproduction gate. */
export type RepairRejection =
  | { readonly source: 'parse'; readonly reason: ResponseParseFailure; readonly detail: string }
  | {
      readonly source: 'budget'
      readonly reason: BudgetViolation
      readonly detail: string
      readonly measurement: BudgetMeasurement
    }
  | {
      readonly source: 'target'
      readonly reason: 'k-out-of-range' | 'recorded-action-reproposed'
      readonly detail: string
    }

export interface PrefixReplayEvidence {
  /** Recorded steps 1..k-1 executed to rebuild the state at k. */
  readonly stepsReplayed: number
  /** Replayed steps whose exit code differed from the recorded returncode. */
  readonly divergences: number
  readonly wallMs: number
}

/**
 * What the reproduction gate observed at k.
 *
 * `signature` and `signatureObserved` are null together when the recorded
 * observation carried no error line; the gate then rests on the returncode
 * alone and says so through `basis`.
 */
export type ReproductionEvidence =
  | {
      /** The step recorded no observation, so there is no state to reproduce.
       *  The gate passes vacuously and no container is opened for it. */
      readonly basis: 'no-recorded-observation'
      readonly reproduced: true
    }
  | {
      readonly basis: 'returncode-only' | 'returncode+output-substring'
      readonly reproduced: boolean
      readonly recordedReturncode: number
      readonly observedExitCode: number
      readonly signature: string | null
      readonly signatureObserved: boolean | null
      readonly prefix: PrefixReplayEvidence
    }

export interface InterventionExecution {
  readonly command: string
  readonly exitCode: number
  readonly timedOut: boolean
  readonly wallMs: number
  readonly output: string
  readonly prefix: PrefixReplayEvidence
}

export interface TestRunEvidence {
  readonly passed: boolean
  readonly exitCode: number
  readonly timedOut: boolean
  /** Digest of the suite the oracle read back from inside the container. */
  readonly suiteDigest: string
}

/**
 * One repair rollout.
 *
 * A rollout whose intervention failed to run is kept and counted as a
 * non-pass rather than dropped. Dropping it would quietly remove the rollouts
 * where the environment behaved worst, which is the direction that flatters
 * the intervention.
 */
export type RepairRolloutEvidence =
  | {
      readonly rolloutIndex: number
      readonly status: 'completed'
      readonly interventionExitCode: number
      readonly continuation: RepairContinuationOutcome
      readonly tests: TestRunEvidence
    }
  | {
      readonly rolloutIndex: number
      readonly status: 'intervention-failed'
      readonly interventionExitCode: number
      readonly timedOut: boolean
    }

export interface RepairArmEvidence {
  /** Rollouts attempted. The denominator of `repairRate`. */
  readonly rollouts: number
  /** Rollouts whose held-out suite passed. */
  readonly passes: number
  /** Rollouts where the intervention did not run, counted as non-passes. */
  readonly interventionFailures: number
  /** Policy digest every completed rollout reported, checked against the
   *  controls. Null when no rollout completed. */
  readonly policyDigest: string | null
  readonly rolloutEvidence: readonly RepairRolloutEvidence[]
}

/**
 * The deepest state an answer reached.
 *
 * Only `measured` carries a repair, so a gate that closed has no field a score
 * could read.
 */
export type RepairGrade =
  | { readonly outcome: 'rejected'; readonly rejection: RepairRejection }
  | { readonly outcome: 'declined' }
  | {
      readonly outcome: 'not-reproduced'
      readonly k: number
      readonly reproduction: ReproductionEvidence
    }
  | {
      readonly outcome: 'did-not-execute'
      readonly k: number
      readonly reproduction: ReproductionEvidence
      readonly execution: InterventionExecution
    }
  | {
      readonly outcome: 'measured'
      readonly k: number
      readonly reproduction: ReproductionEvidence
      readonly execution: InterventionExecution
      readonly localFlip: TestRunEvidence
      readonly repair: RepairArmEvidence
    }

/**
 * Everything an answer earns.
 *
 * Three numeric terms and no reproduction term. A vector rather than a scalar
 * because the three measure different things: whether the action ran, whether
 * it fixed the task outright, and how often it led to a fix once the agent
 * carried on.
 */
export interface RepairCredit {
  readonly executes: 0 | 1
  readonly localFlip: 0 | 1
  /** Share of repair rollouts whose held-out suite passed. */
  readonly repairRate: number
}

/**
 * Compile-time proof that no reproduction term can be added to the credit
 * vector without breaking `pnpm typecheck`. A tier that pays nothing must have
 * nothing to pay into.
 */
type CreditHasNoReproductionTerm =
  Extract<keyof RepairCredit, `${string}eproduc${string}`> extends never ? true : never
const _creditHasNoReproductionTerm: CreditHasNoReproductionTerm = true
void _creditHasNoReproductionTerm

export const CREDIT_TERMS = [
  'executes',
  'localFlip',
  'repairRate',
] as const satisfies readonly (keyof RepairCredit)[]

const ZERO_CREDIT: RepairCredit = Object.freeze({ executes: 0, localFlip: 0, repairRate: 0 })

/** What an answer earned. Every outcome but `measured` earns nothing. */
export function repairCredit(grade: RepairGrade): RepairCredit {
  if (grade.outcome !== 'measured') return ZERO_CREDIT
  return {
    executes: 1,
    localFlip: grade.localFlip.passed ? 1 : 0,
    repairRate: grade.repair.rollouts === 0 ? 0 : grade.repair.passes / grade.repair.rollouts,
  }
}

/** True once the recorded state at k came back. A decline never reaches the
 *  gate, because it names no k. */
function reachedT1(grade: RepairGrade): boolean {
  return grade.outcome === 'did-not-execute' || grade.outcome === 'measured'
}

/** True once the intervention ran at k and exited cleanly. */
function reachedT2(grade: RepairGrade): boolean {
  return grade.outcome === 'measured'
}

export interface RepairFunnelCounts {
  readonly rows: number
  readonly rejected: number
  readonly declined: number
  readonly t0Parsed: number
  readonly t1Reproduced: number
  readonly t2Executed: number
  readonly t3LocalFlip: number
  /** Rows where at least one repair rollout passed the held-out suite. */
  readonly t4RepairFlipAny: number
  /** Rows where every repair rollout passed. */
  readonly t4RepairFlipAll: number
}

export function countFunnel(grades: readonly RepairGrade[]): RepairFunnelCounts {
  let rejected = 0
  let declined = 0
  let t1 = 0
  let t2 = 0
  let t3 = 0
  let t4Any = 0
  let t4All = 0
  for (const grade of grades) {
    if (grade.outcome === 'rejected') rejected += 1
    if (grade.outcome === 'declined') declined += 1
    if (reachedT1(grade)) t1 += 1
    if (reachedT2(grade)) t2 += 1
    if (grade.outcome === 'measured') {
      if (grade.localFlip.passed) t3 += 1
      if (grade.repair.passes > 0) t4Any += 1
      if (grade.repair.rollouts > 0 && grade.repair.passes === grade.repair.rollouts) t4All += 1
    }
  }
  return {
    rows: grades.length,
    rejected,
    declined,
    t0Parsed: grades.length - rejected,
    t1Reproduced: t1,
    t2Executed: t2,
    t3LocalFlip: t3,
    t4RepairFlipAny: t4Any,
    t4RepairFlipAll: t4All,
  }
}
