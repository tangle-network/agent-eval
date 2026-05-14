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
 */

import { TraceEmitter } from './trace/emitter'
import type { LlmSpan, Span, ToolSpan } from './trace/schema'
import type { TraceStore } from './trace/store'
import { buildTrajectory, type Trajectory, type TrajectoryStep } from './trajectory'

export type CounterfactualMutation =
  | { kind: 'swap-model'; at: number; newModel: string }
  | { kind: 'swap-tool-result'; at: number; newResult: unknown }
  | { kind: 'truncate-after'; at: number }
  | { kind: 'inject-system-message'; at: number; content: string }
  | {
      kind: 'custom'
      at: number
      describe: string
      apply: (step: TrajectoryStep) => TrajectoryStep
    }

export interface CounterfactualContext {
  originalRunId: string
  originalTrajectory: Trajectory
  /** Steps up to (but not including) the mutation point — the prefix the
   *  replayed agent inherits as its prior conversation/tool history. */
  prefix: TrajectoryStep[]
  mutation: CounterfactualMutation
  /** Pre-applied mutation on the step at `mutation.at`. Consumers use this
   *  as the FIRST step the replayed agent emits (they decide whether to
   *  re-emit it or continue from there). */
  mutatedStep: TrajectoryStep
}

export interface CounterfactualResult {
  counterfactualRunId: string
  originalRunId: string
  mutation: CounterfactualMutation
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
  if (!originalRun) throw new Error(`counterfactual: run ${originalRunId} not found`)
  const trajectory = await buildTrajectory(store, originalRunId)
  if (mutation.at < 0 || mutation.at >= trajectory.steps.length) {
    throw new Error(
      `counterfactual: mutation.at=${mutation.at} out of range [0, ${trajectory.steps.length})`,
    )
  }
  const targetStep = trajectory.steps[mutation.at]
  const mutatedStep = applyMutation(targetStep, mutation)

  const cfEmitter = new TraceEmitter(store)
  await cfEmitter.startRun({
    scenarioId: originalRun.scenarioId,
    variantId: originalRun.variantId
      ? `${originalRun.variantId}+cf:${mutation.kind}@${mutation.at}`
      : `cf:${mutation.kind}@${mutation.at}`,
    projectId: originalRun.projectId,
    parentRunId: originalRunId,
    layer: 'meta',
    tags: { counterfactual: 'true', mutationKind: mutation.kind, mutationAt: String(mutation.at) },
  })

  await runner.executeFrom(
    {
      originalRunId,
      originalTrajectory: trajectory,
      prefix: trajectory.steps.slice(0, mutation.at),
      mutation,
      mutatedStep,
    },
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
  return { counterfactualRunId: cfEmitter.runId, originalRunId, mutation, delta }
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

/**
 * Aggregate a batch of counterfactuals into a simple attribution table:
 * which mutation kinds move outcomes most? (Useful when you run a grid
 * over the same trajectory — swap-model at every llm span, swap-tool
 * at every tool span — and want a ranked summary.)
 */
export function attributeCounterfactuals(results: CounterfactualResult[]): Array<{
  mutationKind: CounterfactualMutation['kind']
  n: number
  meanAbsDelta: number
  meanSignedDelta: number
}> {
  const grouped = new Map<string, CounterfactualResult[]>()
  for (const r of results) {
    const arr = grouped.get(r.mutation.kind) ?? []
    arr.push(r)
    grouped.set(r.mutation.kind, arr)
  }
  const out: Array<{
    mutationKind: CounterfactualMutation['kind']
    n: number
    meanAbsDelta: number
    meanSignedDelta: number
  }> = []
  for (const [kind, items] of grouped) {
    const deltas = items
      .map((i) => i.delta.deltaScore)
      .filter((d): d is number => typeof d === 'number')
    if (deltas.length === 0) continue
    const meanAbs = deltas.reduce((a, b) => a + Math.abs(b), 0) / deltas.length
    const meanSigned = deltas.reduce((a, b) => a + b, 0) / deltas.length
    out.push({
      mutationKind: kind as CounterfactualMutation['kind'],
      n: deltas.length,
      meanAbsDelta: meanAbs,
      meanSignedDelta: meanSigned,
    })
  }
  return out.sort((a, b) => b.meanAbsDelta - a.meanAbsDelta)
}

// Re-export Span type for consumer ergonomics.
export type { Span }
