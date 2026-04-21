/**
 * Process Reward Modeling — per-step rubric grading.
 *
 * A StepRubric inspects one span and returns a score + rationale.
 * PrmGrader applies an array of rubrics to every LLM span in a
 * trajectory (consumers can broaden to tool/retrieval spans via the
 * `kind` filter on each rubric).
 *
 * Why this matters: outcome-only eval (did the final artifact work?)
 * gives sparse reward — most agent turns are unattributable. PRMs
 * densify the signal so optimizers and RL fine-tuning can assign
 * credit per turn.
 */

import type { Span, JudgeSpan } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { TraceEmitter } from '../trace/emitter'
import { buildTrajectory, type Trajectory, type TrajectoryStep } from '../trajectory'

export interface StepContext {
  trajectory: Trajectory
  step: TrajectoryStep
  /** Steps preceding `step` in trajectory order. */
  prior: TrajectoryStep[]
  /** Steps following `step`. */
  next: TrajectoryStep[]
}

export interface StepRubric {
  id: string
  /** Only grade spans of these kinds (default: all). */
  kinds?: Array<Span['kind']>
  /** Weight in the aggregate score. Default 1. */
  weight?: number
  /** Returns score in 0..1 + optional rationale/evidence. Return `null` to
   *  skip grading (rubric doesn't apply to this step). */
  grade: (ctx: StepContext) => Promise<{ score: number; rationale?: string; evidence?: string } | null>
}

export interface GradedStep {
  spanId: string
  rubricId: string
  score: number
  weight: number
  rationale?: string
  evidence?: string
}

export interface PrmGradedTrace {
  runId: string
  steps: GradedStep[]
  /** Weighted mean of all graded steps; 0..1. */
  aggregateScore: number
  /** Number of spans graded — useful for sanity-checking coverage. */
  gradedCount: number
  /** Number of spans in the trajectory that no rubric matched. */
  ungradedCount: number
}

export class PrmGrader {
  constructor(private rubrics: StepRubric[]) {
    if (rubrics.length === 0) throw new Error('PrmGrader: at least 1 rubric required')
  }

  /**
   * Grade every eligible span in a run. Emits a JudgeVerdict span for each
   * (rubric × span) verdict so the result is visible to downstream pipelines
   * (judgeAgreementView, etc.) — PRM is just "a judge that runs per span."
   */
  async grade(store: TraceStore, runId: string): Promise<PrmGradedTrace> {
    const trajectory = await buildTrajectory(store, runId)
    const emitter = new TraceEmitter(store, { runId })
    const steps: GradedStep[] = []
    let ungraded = 0
    for (let i = 0; i < trajectory.steps.length; i++) {
      const step = trajectory.steps[i]
      const ctx: StepContext = {
        trajectory,
        step,
        prior: trajectory.steps.slice(0, i),
        next: trajectory.steps.slice(i + 1),
      }
      let gradedThis = false
      for (const rubric of this.rubrics) {
        if (rubric.kinds && !rubric.kinds.includes(step.span.kind)) continue
        const verdict = await rubric.grade(ctx)
        if (verdict === null) continue
        const weight = rubric.weight ?? 1
        steps.push({
          spanId: step.span.spanId,
          rubricId: rubric.id,
          score: verdict.score,
          weight,
          rationale: verdict.rationale,
          evidence: verdict.evidence,
        })
        gradedThis = true
        // Persist the verdict as a JudgeSpan so the query pipelines see it
        await emitter.recordJudge({
          judgeId: `prm:${rubric.id}`,
          targetSpanId: step.span.spanId,
          dimension: 'step_quality',
          score: verdict.score,
          rationale: verdict.rationale,
          evidence: verdict.evidence,
          name: `prm:${rubric.id}`,
        })
      }
      if (!gradedThis) ungraded++
    }

    const totalWeight = steps.reduce((a, s) => a + s.weight, 0)
    const aggregateScore = totalWeight === 0 ? 0
      : steps.reduce((a, s) => a + s.score * s.weight, 0) / totalWeight

    return { runId, steps, aggregateScore, gradedCount: steps.length, ungradedCount: ungraded }
  }
}

/** Helper: reads JudgeVerdict spans that PRM emitted so downstream pipelines
 *  can distinguish PRM verdicts from human or top-level LLM judges. */
export function isPrmVerdict(verdict: JudgeSpan): boolean {
  return verdict.judgeId.startsWith('prm:')
}
