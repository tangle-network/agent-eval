/**
 * Causal sweep — WHY did this run fail?
 *
 * Orchestrates the dormant counterfactual primitives into a responsibility
 * report: for each candidate step, run `reps` counterfactual replays per
 * mutation (via `runCounterfactual` — the consumer's `CounterfactualRunner`
 * is the execution seam) and reduce the per-rep score deltas into a mean
 * effect + bootstrap confidence interval (via `confidenceInterval`).
 *
 * Why `reps` is REQUIRED: a single intervention delta is one stochastic
 * draw — LLM re-execution from a prefix is sampled, so one replay cannot
 * distinguish "this step caused the failure" from sampling noise. The
 * signal is the distribution of deltas across reps; the CI over that
 * distribution is what lets a caller say "this step's effect excludes
 * zero" instead of eyeballing a point estimate.
 *
 * Budget discipline: the sweep never silently drops cells. When the
 * remaining budget cannot fund a full `reps`-sized cell, the sweep halts
 * and every step not fully probed is named in `uncovered`.
 */

import {
  attributeCounterfactuals,
  type CounterfactualMutation,
  type CounterfactualResult,
  type CounterfactualRunner,
  runCounterfactual,
} from '../counterfactual'
import { ValidationError } from '../errors'
import { confidenceInterval } from '../statistics'
import type { Span } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { buildTrajectory, type Trajectory, type TrajectoryStep } from '../trajectory'

/** Stable reference to a trajectory step — carried through reports,
 *  findings, and corpus records so evidence stays addressable. */
export interface StepRef {
  index: number
  spanId: string
  kind: Span['kind']
  name: string
}

export function stepRefOf(step: TrajectoryStep): StepRef {
  return {
    index: step.index,
    spanId: step.span.spanId,
    kind: step.span.kind,
    name: step.span.name,
  }
}

export interface CausalSweepOptions {
  store: TraceStore
  /** The failed run to diagnose. Its `outcome.score` is the baseline every
   *  counterfactual delta is measured against. */
  runId: string
  /** Execution seam — identical contract to `runCounterfactual`: re-runs the
   *  agent from the mutation point and MUST `endRun` with a numeric score. */
  runner: CounterfactualRunner
  /** Trajectory indices to probe. Default: every llm + tool span — the kinds
   *  the existing `CounterfactualMutation` set targets. */
  candidateSteps?: number[]
  /**
   * Mutations to probe a given step with. Returned mutations MUST target
   * `step.index`. Default probes are the payload-free existing kinds:
   *   - tool span → `swap-tool-result` with `newResult: null` (knockout:
   *     how much did the run depend on this tool's information?)
   *   - llm span → `truncate-after` (re-roll: how much did the realized
   *     turn deviate from the policy's typical continuation?)
   * `swap-model` / `inject-system-message` need consumer payloads, so they
   * are opt-in via this callback.
   */
  mutationsPerStep?: (step: TrajectoryStep) => CounterfactualMutation[]
  /** Replays per (step, mutation) cell. Minimum 2 — see module doc. */
  reps: number
  /** Hard cap on total counterfactual replays across the whole sweep. */
  budget: number
  /** Seed for the bootstrap CI resampler. Deterministic default so two
   *  sweeps over the same deltas report identical intervals. */
  ciSeed?: number
  /** Bootstrap CI confidence level. Default 0.95. */
  ciConfidence?: number
}

export interface StepResponsibility {
  stepRef: StepRef
  mutationKind: CounterfactualMutation['kind']
  /** Mean of per-rep score deltas (counterfactual − original). */
  meanEffect: number
  /** Bootstrap CI over the per-rep deltas. */
  ci: { mean: number; lower: number; upper: number }
  /** `ci.lower > 0 || ci.upper < 0` — the effect is distinguishable from noise. */
  ciExcludesZero: boolean
  reps: number
  /** Raw per-rep deltas — downstream evidence, never re-derived. */
  deltas: number[]
  /** Replay run ids (layer='meta', parentRunId=original) for audit. */
  counterfactualRunIds: string[]
}

export interface CausalResponsibilityReport {
  runId: string
  originalScore: number
  /** Ranked by |meanEffect| descending — the blame ordering. */
  steps: StepResponsibility[]
  /** Kind-level aggregate from the existing `attributeCounterfactuals`. */
  byMutationKind: ReturnType<typeof attributeCounterfactuals>
  replaysUsed: number
  budget: number
  /** Steps planned but not fully probed before the budget ran out.
   *  Named, never silent: an absent step is "no effect found"; an
   *  uncovered step is "not measured". */
  uncovered: StepRef[]
}

const DEFAULT_CI_SEED = 0x5eed

function defaultMutations(step: TrajectoryStep): CounterfactualMutation[] {
  if (step.span.kind === 'tool') {
    return [{ kind: 'swap-tool-result', at: step.index, newResult: null }]
  }
  if (step.span.kind === 'llm') {
    return [{ kind: 'truncate-after', at: step.index }]
  }
  return []
}

export async function causalSweep(opts: CausalSweepOptions): Promise<CausalResponsibilityReport> {
  if (!Number.isInteger(opts.reps) || opts.reps < 2) {
    throw new ValidationError(
      `causalSweep: reps must be an integer >= 2 (got ${opts.reps}) — a single-intervention delta is one stochastic draw, not a measurement`,
    )
  }
  if (!Number.isInteger(opts.budget) || opts.budget < 1) {
    throw new ValidationError(`causalSweep: budget must be an integer >= 1 (got ${opts.budget})`)
  }

  const originalRun = await opts.store.getRun(opts.runId)
  if (!originalRun) throw new ValidationError(`causalSweep: run ${opts.runId} not found`)
  const originalScore = originalRun.outcome?.score
  if (typeof originalScore !== 'number' || !Number.isFinite(originalScore)) {
    throw new ValidationError(
      `causalSweep: run ${opts.runId} has no numeric outcome.score — deltas have no baseline`,
    )
  }

  const trajectory = await buildTrajectory(opts.store, opts.runId)
  const candidates = resolveCandidates(trajectory, opts.candidateSteps)
  const mutationsFor = opts.mutationsPerStep ?? defaultMutations

  interface Cell {
    step: TrajectoryStep
    mutation: CounterfactualMutation
  }
  const cells: Cell[] = []
  for (const step of candidates) {
    const mutations = mutationsFor(step)
    for (const m of mutations) {
      if (m.at !== step.index) {
        throw new ValidationError(
          `causalSweep: mutationsPerStep returned a mutation targeting at=${m.at} for step index=${step.index} — mutations must target the step they were asked for`,
        )
      }
      cells.push({ step, mutation: m })
    }
  }

  const responsibilities: StepResponsibility[] = []
  const allResults: CounterfactualResult[] = []
  const uncoveredIndices = new Set<number>()
  let replaysUsed = 0
  let halted = false

  for (const cell of cells) {
    if (halted || replaysUsed + opts.reps > opts.budget) {
      // A partial cell would report a CI over fewer reps than requested —
      // weaker evidence masquerading as the real thing. Halt and name it.
      halted = true
      uncoveredIndices.add(cell.step.index)
      continue
    }
    const deltas: number[] = []
    const cfRunIds: string[] = []
    for (let rep = 0; rep < opts.reps; rep++) {
      const result = await runCounterfactual(opts.store, opts.runId, cell.mutation, opts.runner)
      replaysUsed++
      const d = result.delta.deltaScore
      if (typeof d !== 'number' || !Number.isFinite(d)) {
        throw new ValidationError(
          `causalSweep: counterfactual replay for step ${cell.step.index} (${cell.mutation.kind}) rep ${rep} produced no numeric score — the runner must endRun with a numeric outcome.score`,
        )
      }
      deltas.push(d)
      cfRunIds.push(result.counterfactualRunId)
      allResults.push(result)
    }
    const ci = confidenceInterval(deltas, opts.ciConfidence ?? 0.95, {
      seed: opts.ciSeed ?? DEFAULT_CI_SEED,
    })
    responsibilities.push({
      stepRef: stepRefOf(cell.step),
      mutationKind: cell.mutation.kind,
      meanEffect: ci.mean,
      ci,
      ciExcludesZero: ci.lower > 0 || ci.upper < 0,
      reps: opts.reps,
      deltas,
      counterfactualRunIds: cfRunIds,
    })
  }

  responsibilities.sort((a, b) => Math.abs(b.meanEffect) - Math.abs(a.meanEffect))

  // A step probed under one mutation but cut off under another appears in
  // BOTH steps and uncovered — partial coverage is named, not blended.
  const uncovered = candidates.filter((s) => uncoveredIndices.has(s.index)).map(stepRefOf)

  return {
    runId: opts.runId,
    originalScore,
    steps: responsibilities,
    byMutationKind: attributeCounterfactuals(allResults),
    replaysUsed,
    budget: opts.budget,
    uncovered,
  }
}

function resolveCandidates(trajectory: Trajectory, indices?: number[]): TrajectoryStep[] {
  if (indices === undefined) {
    return trajectory.steps.filter((s) => s.span.kind === 'llm' || s.span.kind === 'tool')
  }
  return indices.map((i) => {
    const step = trajectory.steps[i]
    if (!step) {
      throw new ValidationError(
        `causalSweep: candidateSteps index ${i} out of range [0, ${trajectory.steps.length})`,
      )
    }
    return step
  })
}
