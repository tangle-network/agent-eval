/**
 * Replay-validated repair — WHAT SHOULD HAVE HAPPENED?
 *
 * Takes the blamed steps from a `CausalResponsibilityReport`, asks a
 * consumer-supplied `proposeFix` (LLM-backed in live use) for candidate
 * mutations, and machine-verifies each candidate by replaying the run
 * WITH the mutation applied (through the same `runCounterfactual` seam
 * the sweep uses).
 *
 * A repair is "what should have happened" ONLY when every validation
 * replay crosses `flipThreshold` — a prescription is never speculated,
 * it is demonstrated. Candidates that don't flip, or whose replay
 * errors, land in `rejected` with a typed reason; nothing is dropped
 * silently.
 */

import {
  type CounterfactualMutation,
  type CounterfactualRunner,
  runCounterfactual,
} from '../counterfactual'
import { ValidationError } from '../errors'
import type { TraceStore } from '../trace/store'
import { buildTrajectory, type Trajectory, type TrajectoryStep } from '../trajectory'
import type { StepRef, StepResponsibility } from './causal-sweep'

/** Context handed to `proposeFix` so an LLM-backed proposer can see the
 *  full trajectory plus the responsibility evidence for the blamed step. */
export interface RepairContext {
  runId: string
  trajectory: Trajectory
  originalScore: number
  responsibility: StepResponsibility
}

export interface PrescribeRepairOptions {
  store: TraceStore
  /** The failed run the sweep diagnosed. */
  runId: string
  /** Execution seam — same `CounterfactualRunner` contract as the sweep. */
  runner: CounterfactualRunner
  /** Blamed steps from `causalSweep` — typically `report.steps.slice(0, k)`. */
  blamed: StepResponsibility[]
  /** Candidate-fix generator. Consumer-supplied; LLM-backed in live use.
   *  Returned mutations MUST target the blamed step's index. */
  proposeFix: (step: TrajectoryStep, context: RepairContext) => Promise<CounterfactualMutation[]>
  /** Score every validation replay must reach for the repair to count. Default 0.5. */
  flipThreshold?: number
  /** Validation replays per candidate mutation. Default 3. */
  repsToValidate?: number
  /** Max candidate mutations tried per step. Default: all proposed. */
  maxAttemptsPerStep?: number
}

export interface ValidatedRepair {
  stepRef: StepRef
  mutation: CounterfactualMutation
  /** Always true — presence in `repairs` IS the machine-verified claim. */
  validated: true
  /** Mean counterfactual score across the validation reps. */
  meanScore: number
  /** meanScore − originalScore. */
  deltaScore: number
  reps: number
  /** Replay run ids backing the validation — audit trail. */
  counterfactualRunIds: string[]
}

export interface RejectedRepair {
  stepRef: StepRef
  mutation: CounterfactualMutation
  reason: 'did-not-flip' | 'error'
  /** Present for 'did-not-flip': mean delta over the reps that ran. */
  deltaScore?: number
  /** Present for 'error': the message, preserved for diagnosis. */
  error?: string
}

export interface RepairReport {
  runId: string
  originalScore: number
  flipThreshold: number
  repairs: ValidatedRepair[]
  rejected: RejectedRepair[]
  replaysUsed: number
}

export async function prescribeRepair(opts: PrescribeRepairOptions): Promise<RepairReport> {
  const flipThreshold = opts.flipThreshold ?? 0.5
  const repsToValidate = opts.repsToValidate ?? 3
  if (!Number.isInteger(repsToValidate) || repsToValidate < 1) {
    throw new ValidationError(
      `prescribeRepair: repsToValidate must be an integer >= 1 (got ${repsToValidate})`,
    )
  }
  const maxAttempts = opts.maxAttemptsPerStep ?? Number.POSITIVE_INFINITY
  if (maxAttempts < 1) {
    throw new ValidationError(
      `prescribeRepair: maxAttemptsPerStep must be >= 1 (got ${opts.maxAttemptsPerStep})`,
    )
  }
  if (opts.blamed.length === 0) {
    throw new ValidationError('prescribeRepair: blamed is empty — nothing to repair')
  }

  const originalRun = await opts.store.getRun(opts.runId)
  if (!originalRun) throw new ValidationError(`prescribeRepair: run ${opts.runId} not found`)
  const originalScore = originalRun.outcome?.score
  if (typeof originalScore !== 'number' || !Number.isFinite(originalScore)) {
    throw new ValidationError(
      `prescribeRepair: run ${opts.runId} has no numeric outcome.score — flips have no baseline`,
    )
  }

  const trajectory = await buildTrajectory(opts.store, opts.runId)

  const repairs: ValidatedRepair[] = []
  const rejected: RejectedRepair[] = []
  let replaysUsed = 0

  for (const responsibility of opts.blamed) {
    const step = trajectory.steps[responsibility.stepRef.index]
    if (!step || step.span.spanId !== responsibility.stepRef.spanId) {
      throw new ValidationError(
        `prescribeRepair: blamed step index=${responsibility.stepRef.index} spanId=${responsibility.stepRef.spanId} does not match run ${opts.runId} — stale report?`,
      )
    }

    const candidates = await opts.proposeFix(step, {
      runId: opts.runId,
      trajectory,
      originalScore,
      responsibility,
    })
    const toTry = candidates.slice(0, maxAttempts)

    for (const mutation of toTry) {
      if (mutation.at !== step.index) {
        throw new ValidationError(
          `prescribeRepair: proposeFix returned a mutation targeting at=${mutation.at} for blamed step index=${step.index}`,
        )
      }
      const scores: number[] = []
      const cfRunIds: string[] = []
      let failure: string | undefined
      for (let rep = 0; rep < repsToValidate; rep++) {
        try {
          const result = await runCounterfactual(opts.store, opts.runId, mutation, opts.runner)
          replaysUsed++
          const score = result.delta.counterfactualOutcomeScore
          if (typeof score !== 'number' || !Number.isFinite(score)) {
            failure = `validation rep ${rep} produced no numeric score — the runner must endRun with a numeric outcome.score`
            break
          }
          scores.push(score)
          cfRunIds.push(result.counterfactualRunId)
        } catch (err) {
          replaysUsed++
          failure = err instanceof Error ? err.message : String(err)
          break
        }
      }

      if (failure !== undefined) {
        rejected.push({
          stepRef: responsibility.stepRef,
          mutation,
          reason: 'error',
          error: failure,
        })
        continue
      }

      const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length
      const everyRepFlipped = scores.every((s) => s >= flipThreshold)
      if (everyRepFlipped) {
        repairs.push({
          stepRef: responsibility.stepRef,
          mutation,
          validated: true,
          meanScore,
          deltaScore: meanScore - originalScore,
          reps: repsToValidate,
          counterfactualRunIds: cfRunIds,
        })
        // First validated repair per step IS the prescription; remaining
        // candidates are untried, not rejected — we don't fabricate verdicts.
        break
      }
      rejected.push({
        stepRef: responsibility.stepRef,
        mutation,
        reason: 'did-not-flip',
        deltaScore: meanScore - originalScore,
      })
    }
  }

  return { runId: opts.runId, originalScore, flipThreshold, repairs, rejected, replaysUsed }
}
