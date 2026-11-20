/**
 * Trajectory — a structured view over every span of one run.
 *
 * `buildTrajectory(store, runId)` lists each captured span once, in
 * containment order (see `trace/containment-order.ts`): depth first, with
 * roots and siblings ordered by start time and ties kept in store order.
 * Containment order is not time order. With parallel branches, a step late in
 * the list can have started before a step early in it, so code that needs
 * "what had happened by step k" reads `trajectoryTimingBoundary`, not a slice
 * of `steps`.
 *
 * A span whose parent is not in the capture stays in the trajectory as a root
 * and is listed in `missingParents`, so a trace with a hole is never presented
 * as complete. Separate analyzers (stuck-loop detection, waste ratio) live in
 * `pipelines/` and consume the trajectory.
 */

import { ValidationError } from './errors'
import { containmentOrder, type DetachedCause } from './trace/containment-order'
import type { Span, TraceEvent } from './trace/schema'
import type { TraceStore } from './trace/store'

export interface TrajectoryStep {
  index: number
  span: Span
  /** Depth in the span tree from the root. 0 = top-level. */
  depth: number
  /** Events attached to this span. */
  events: TraceEvent[]
}

/** A captured span placed at the root although it names a parent. */
export interface TrajectoryMissingParent {
  /** The span's step index in `Trajectory.steps`. */
  index: number
  spanId: string
  /** The parent id the span names. */
  parentSpanId: string
  /**
   * `absent`: no captured span has `parentSpanId`. `cycle`: the parent is
   * captured, but its ancestry loops back to this span, so no captured root
   * holds it.
   */
  cause: DetachedCause
}

export interface Trajectory {
  runId: string
  /** Every captured span once, in containment order; never a time order. */
  steps: TrajectoryStep[]
  /** Spans whose ancestry does not reach a captured root, in step order. Empty when there are none. */
  missingParents: TrajectoryMissingParent[]
  llmTurns: number
  toolCalls: number
  judgeVerdicts: number
  retrievals: number
  totalDurationMs: number
}

export async function buildTrajectory(store: TraceStore, runId: string): Promise<Trajectory> {
  const spans = await store.spans({ runId })
  const events = await store.events({ runId })

  const eventsBySpan = new Map<string, TraceEvent[]>()
  for (const e of events) {
    if (!e.spanId) continue
    const arr = eventsBySpan.get(e.spanId) ?? []
    arr.push(e)
    eventsBySpan.set(e.spanId, arr)
  }

  const ordered = containmentOrder(spans, {
    id: (span) => span.spanId,
    parentId: (span) => span.parentSpanId,
    compare: (a, b) => a.startedAt - b.startedAt,
  })
  const steps: TrajectoryStep[] = []
  const missingParents: TrajectoryMissingParent[] = []
  for (const { item: span, depth, detached } of ordered) {
    const index = steps.length
    steps.push({ index, span, depth, events: eventsBySpan.get(span.spanId) ?? [] })
    if (detached && span.parentSpanId) {
      missingParents.push({
        index,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        cause: detached,
      })
    }
  }

  const llmTurns = steps.filter((s) => s.span.kind === 'llm').length
  const toolCalls = steps.filter((s) => s.span.kind === 'tool').length
  const judgeVerdicts = steps.filter((s) => s.span.kind === 'judge').length
  const retrievals = steps.filter((s) => s.span.kind === 'retrieval').length

  let totalDurationMs = 0
  if (steps.length > 0) {
    const starts = spans.map((s) => s.startedAt)
    const ends = spans.map((s) => s.endedAt ?? s.startedAt)
    totalDurationMs = Math.max(...ends) - Math.min(...starts)
  }

  return {
    runId,
    steps,
    missingParents,
    llmTurns,
    toolCalls,
    judgeVerdicts,
    retrievals,
    totalDurationMs,
  }
}

/** A step of a trajectory: its index in `steps`, or the id of its span. */
export type TrajectoryStepRef = number | { spanId: string }

/** What had settled, and what was still running, when one step started. */
export interface TrajectoryTimingBoundary {
  /** The step the boundary is drawn at. */
  target: TrajectoryStep
  /** The target's ancestors and every step that ended before it started, in containment order. */
  prefix: TrajectoryStep[]
  /** Steps that started before the target and had not ended when it started, or never ended, in containment order. Ancestors are never listed here. */
  inFlight: TrajectoryStep[]
}

/** The step a reference names; a ValidationError when it names none, or more than one. */
function resolveTrajectoryStep(trajectory: Trajectory, ref: TrajectoryStepRef): TrajectoryStep {
  const { steps } = trajectory
  if (typeof ref === 'number') {
    if (!Number.isSafeInteger(ref) || ref < 0 || ref >= steps.length) {
      throw new ValidationError(
        `trajectory ${trajectory.runId}: step ${ref} out of range [0, ${steps.length})`,
      )
    }
    return steps[ref]!
  }
  const matches = steps.filter((s) => s.span.spanId === ref.spanId)
  if (matches.length === 0) {
    throw new ValidationError(
      `trajectory ${trajectory.runId}: no step has span id ${JSON.stringify(ref.spanId)}`,
    )
  }
  if (matches.length > 1) {
    throw new ValidationError(
      `trajectory ${trajectory.runId}: span id ${JSON.stringify(ref.spanId)} names ${matches.length} steps; name the step by index`,
    )
  }
  return matches[0]!
}

/**
 * The boundary at one step, read from span timing.
 *
 * `prefix` holds the target's ancestors plus every step that ended before the
 * target started. `inFlight` holds the steps, other than ancestors, that started
 * before the target and had not ended when it started, or never ended. Steps
 * that started after the target, and the target's own descendants, are in
 * neither. When a step's end equals the target's start exactly, or two steps
 * start at the same instant, the step counts as earlier only if it precedes the
 * target in containment order. Ancestry is read from the step tree (depths), so
 * duplicate span ids cannot confuse it.
 *
 * For a sequential trace, where every step before the target in `steps` is an
 * ancestor or had ended by the time the target started, and no later step
 * outside the target's subtree started before it, `prefix` equals
 * `steps.slice(0, target.index)` and `inFlight` is empty.
 *
 * Throws a ValidationError when `at` is out of range, names no span, or names a
 * span id that more than one step carries.
 *
 * Timing is necessary, not sufficient: a step in `prefix` had finished, but
 * nothing here proves the target consumed its output. Environment state at the
 * boundary, including the partial effects of `inFlight` steps, is the
 * executor's to restore.
 */
export function trajectoryTimingBoundary(
  trajectory: Trajectory,
  at: TrajectoryStepRef,
): TrajectoryTimingBoundary {
  const target = resolveTrajectoryStep(trajectory, at)
  const { steps } = trajectory
  const ancestors = new Set<number>()
  let depth = target.depth
  for (let i = target.index - 1; i >= 0 && depth > 0; i -= 1) {
    if (steps[i]!.depth === depth - 1) {
      ancestors.add(i)
      depth -= 1
    }
  }
  let subtreeEnd = target.index + 1
  while (subtreeEnd < steps.length && steps[subtreeEnd]!.depth > target.depth) subtreeEnd += 1

  const start = target.span.startedAt
  const prefix: TrajectoryStep[] = []
  const inFlight: TrajectoryStep[] = []
  for (const step of steps) {
    if (step.index === target.index) continue
    if (step.index > target.index && step.index < subtreeEnd) continue
    if (ancestors.has(step.index)) {
      prefix.push(step)
      continue
    }
    const earlierOnTie = step.index < target.index
    const { startedAt, endedAt } = step.span
    if (endedAt !== undefined && (endedAt < start || (endedAt === start && earlierOnTie))) {
      prefix.push(step)
    } else if (startedAt < start || (startedAt === start && earlierOnTie)) {
      inFlight.push(step)
    }
  }
  return { target, prefix, inFlight }
}
