/**
 * Counterfactual replay — "what would have happened if we'd changed
 * exactly one thing at turn N?"
 *
 * The framework does NOT drive the agent — it sets up the replay
 * context (prior spans, prior state, mutation spec) and records the
 * resulting divergence. Consumers supply an `executeFrom(ctx)` callback
 * that runs their agent starting from turn N with the mutation applied.
 *
 * Counterfactual runs are recorded as a new Run with `layer='meta'` and
 * `parentRunId = originalRunId`, so downstream diff + correlation
 * pipelines see them natively.
 *
 * The prefix is drawn by span timing (`trajectoryTimingBoundary`), not by
 * slicing the step list: with parallel branches, a step listed before the
 * target can have started after it, and the replayed agent must not inherit it.
 */

import { NotFoundError } from './errors'
import { TraceEmitter } from './trace/emitter'
import type { LlmSpan, Span, ToolSpan } from './trace/schema'
import type { TraceStore } from './trace/store'
import {
  buildTrajectory,
  type Trajectory,
  type TrajectoryStep,
  type TrajectoryStepRef,
  trajectoryTimingBoundary,
} from './trajectory'

/**
 * The step a mutation changes: its index in the original trajectory's steps, or
 * the id of its span. A span id stays valid when the step list is rebuilt.
 */
export type CounterfactualMutation =
  | { kind: 'swap-model'; at: TrajectoryStepRef; newModel: string }
  | { kind: 'swap-tool-result'; at: TrajectoryStepRef; newResult: unknown }
  | { kind: 'truncate-after'; at: TrajectoryStepRef }
  | { kind: 'inject-system-message'; at: TrajectoryStepRef; content: string }
  | {
      kind: 'custom'
      at: TrajectoryStepRef
      describe: string
      apply: (step: TrajectoryStep) => TrajectoryStep
    }

export interface CounterfactualContext {
  originalRunId: string
  originalTrajectory: Trajectory
  /** What the replayed agent inherits: the target's ancestors and every step
   *  that ended before the target started, in containment order. A sequential
   *  trace's prefix is every step before the target. See
   *  `trajectoryTimingBoundary` for what timing does not prove. */
  prefix: TrajectoryStep[]
  /** Steps that were still running when the target started. Their outcome was
   *  not available to the decision; their partial effects on the environment
   *  are the executor's to account for. */
  inFlight: TrajectoryStep[]
  mutation: CounterfactualMutation
  /** Pre-applied mutation on the target step. Consumers use this
   *  as the FIRST step the replayed agent emits (they decide whether to
   *  re-emit it or continue from there). */
  mutatedStep: TrajectoryStep
}

export interface CounterfactualResult {
  counterfactualRunId: string
  originalRunId: string
  mutation: CounterfactualMutation
  /** Span id of the step the mutation changed. */
  targetSpanId: string
  /** Structured delta summary — caller can extend via scoring. */
  delta: {
    originalOutcomeScore: number | null
    counterfactualOutcomeScore: number | null
    deltaScore: number | null
  }
}

export interface CounterfactualRunner {
  /**
   * Execute the agent from `ctx.prefix` with the mutation applied.
   * MUST emit spans into the provided emitter so they become part of
   * the counterfactual run. MUST call emitter.endRun() with a verdict.
   */
  executeFrom: (ctx: CounterfactualContext, emitter: TraceEmitter) => Promise<void>
}

export async function runCounterfactual(
  store: TraceStore,
  originalRunId: string,
  mutation: CounterfactualMutation,
  runner: CounterfactualRunner,
): Promise<CounterfactualResult> {
  const originalRun = await store.getRun(originalRunId)
  if (!originalRun) throw new NotFoundError(`counterfactual: run ${originalRunId} not found`)
  const trajectory = await buildTrajectory(store, originalRunId)
  const { target, prefix, inFlight } = trajectoryTimingBoundary(trajectory, mutation.at)
  const mutatedStep = applyMutation(target, mutation)
  const targetSpanId = target.span.spanId
  // An index target keeps its `@<index>` variant id; a span target is named by span.
  const at = typeof mutation.at === 'number' ? String(mutation.at) : `span:${targetSpanId}`

  const cfEmitter = new TraceEmitter(store)
  await cfEmitter.startRun({
    scenarioId: originalRun.scenarioId,
    variantId: originalRun.variantId
      ? `${originalRun.variantId}+cf:${mutation.kind}@${at}`
      : `cf:${mutation.kind}@${at}`,
    projectId: originalRun.projectId,
    parentRunId: originalRunId,
    layer: 'meta',
    tags: {
      counterfactual: 'true',
      mutationKind: mutation.kind,
      mutationAt: String(target.index),
      mutationSpanId: targetSpanId,
    },
  })

  await runner.executeFrom(
    { originalRunId, originalTrajectory: trajectory, prefix, inFlight, mutation, mutatedStep },
    cfEmitter,
  )

  const counterfactual = await store.getRun(cfEmitter.runId)
  const delta = {
    originalOutcomeScore: originalRun.outcome?.score ?? null,
    counterfactualOutcomeScore: counterfactual?.outcome?.score ?? null,
    deltaScore:
      originalRun.outcome?.score !== undefined && counterfactual?.outcome?.score !== undefined
        ? counterfactual.outcome.score - originalRun.outcome.score
        : null,
  }
  return { counterfactualRunId: cfEmitter.runId, originalRunId, mutation, targetSpanId, delta }
}

function applyMutation(step: TrajectoryStep, mutation: CounterfactualMutation): TrajectoryStep {
  if (mutation.kind === 'swap-model' && step.span.kind === 'llm') {
    const llm = step.span as LlmSpan
    return { ...step, span: { ...llm, model: mutation.newModel } }
  }
  if (mutation.kind === 'swap-tool-result' && step.span.kind === 'tool') {
    const tool = step.span as ToolSpan
    return { ...step, span: { ...tool, result: mutation.newResult } }
  }
  if (mutation.kind === 'inject-system-message' && step.span.kind === 'llm') {
    const llm = step.span as LlmSpan
    return {
      ...step,
      span: {
        ...llm,
        messages: [{ role: 'system', content: mutation.content }, ...llm.messages],
      },
    }
  }
  if (mutation.kind === 'custom') return mutation.apply(step)
  // swap-tool-result on non-tool span / swap-model on non-llm / truncate-after: no step-level change.
  return step
}

// Re-export Span type for consumer ergonomics.
export type { Span }
