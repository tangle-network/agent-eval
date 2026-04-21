/**
 * Trajectory — ordered, structured view over a run's spans.
 *
 * A pure function `buildTrajectory(store, runId) → Trajectory` returns
 * a topologically ordered list of `TrajectoryStep` with parent-child
 * grouping collapsed into a single line-of-agent-work. Separate
 * analyzers (stuck-loop detection, waste ratio) live in
 * `pipelines/` and consume the trajectory.
 */

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

export interface Trajectory {
  runId: string
  steps: TrajectoryStep[]
  llmTurns: number
  toolCalls: number
  judgeVerdicts: number
  retrievals: number
  totalDurationMs: number
}

export async function buildTrajectory(store: TraceStore, runId: string): Promise<Trajectory> {
  const spans = await store.spans({ runId })
  const events = await store.events({ runId })
  const childrenOf = new Map<string | undefined, Span[]>()
  for (const s of spans) {
    const arr = childrenOf.get(s.parentSpanId) ?? []
    arr.push(s)
    childrenOf.set(s.parentSpanId, arr)
  }
  // Sort children by startedAt so DFS yields chronological order within siblings.
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.startedAt - b.startedAt)

  const eventsBySpan = new Map<string, TraceEvent[]>()
  for (const e of events) {
    if (!e.spanId) continue
    const arr = eventsBySpan.get(e.spanId) ?? []
    arr.push(e)
    eventsBySpan.set(e.spanId, arr)
  }

  const steps: TrajectoryStep[] = []
  const walk = (spanId: string | undefined, depth: number): void => {
    const kids = childrenOf.get(spanId) ?? []
    for (const child of kids) {
      steps.push({
        index: steps.length,
        span: child,
        depth,
        events: eventsBySpan.get(child.spanId) ?? [],
      })
      walk(child.spanId, depth + 1)
    }
  }
  walk(undefined, 0)

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

  return { runId, steps, llmTurns, toolCalls, judgeVerdicts, retrievals, totalDurationMs }
}

// Re-export core types for convenience so consumers don't import from two paths.
export type { Span, TraceEvent } from './trace/schema'
export type { TraceStore } from './trace/store'
