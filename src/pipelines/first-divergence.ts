/**
 * FirstDivergenceView — aligns two trajectories by step index, reports
 * the first step where they differ.
 *
 * "Differ" is configurable — default is (kind, toolName if tool, model
 * if llm). Use this view to attribute "why is variant B better?" to a
 * specific step rather than an aggregate mean delta.
 */

import type { TraceStore } from '../trace/store'
import { buildTrajectory, type Trajectory, type TrajectoryStep } from '../trajectory'

export interface DivergenceReport {
  runA: string
  runB: string
  firstDivergenceIndex: number | null
  aStep?: TrajectoryStep
  bStep?: TrajectoryStep
  reason?: string
  /** Common prefix length (steps that matched). */
  commonPrefixLen: number
}

export interface DivergenceOptions {
  /** Returns true if two steps are considered equal. Default: kind + tool/model match. */
  stepEquals?: (a: TrajectoryStep, b: TrajectoryStep) => boolean
}

export async function firstDivergenceView(
  store: TraceStore,
  runA: string,
  runB: string,
  options: DivergenceOptions = {},
): Promise<DivergenceReport> {
  const [a, b] = await Promise.all([buildTrajectory(store, runA), buildTrajectory(store, runB)])
  const eq = options.stepEquals ?? defaultStepEquals
  const minLen = Math.min(a.steps.length, b.steps.length)
  for (let i = 0; i < minLen; i++) {
    const aStep = a.steps[i]!
    const bStep = b.steps[i]!
    if (!eq(aStep, bStep)) {
      return {
        runA,
        runB,
        firstDivergenceIndex: i,
        aStep,
        bStep,
        reason: describeDifference(aStep, bStep),
        commonPrefixLen: i,
      }
    }
  }
  if (a.steps.length === b.steps.length) {
    return { runA, runB, firstDivergenceIndex: null, commonPrefixLen: minLen }
  }
  const longer: Trajectory = a.steps.length > b.steps.length ? a : b
  const extra = longer.steps.length - minLen
  // minLen === 0 means one trajectory is empty: divergence is the first step
  // itself (index 0), and the absent side has no step to surface.
  const reason =
    minLen === 0
      ? `one trajectory is empty; the other has ${extra} step(s) starting at index 0`
      : `one trajectory has ${extra} more step(s) after index ${minLen - 1}`
  return {
    runA,
    runB,
    firstDivergenceIndex: minLen,
    aStep: a.steps[minLen],
    bStep: b.steps[minLen],
    reason,
    commonPrefixLen: minLen,
  }
}

function defaultStepEquals(a: TrajectoryStep, b: TrajectoryStep): boolean {
  if (a.span.kind !== b.span.kind) return false
  if (a.span.kind === 'tool' && b.span.kind === 'tool') return a.span.toolName === b.span.toolName
  if (a.span.kind === 'llm' && b.span.kind === 'llm') return a.span.model === b.span.model
  if (a.span.kind === 'judge' && b.span.kind === 'judge')
    return a.span.dimension === b.span.dimension
  return a.span.name === b.span.name
}

function describeDifference(a: TrajectoryStep, b: TrajectoryStep): string {
  if (a.span.kind !== b.span.kind) return `kind ${a.span.kind} vs ${b.span.kind}`
  if (a.span.kind === 'tool' && b.span.kind === 'tool' && a.span.toolName !== b.span.toolName) {
    return `tool ${a.span.toolName} vs ${b.span.toolName}`
  }
  if (a.span.kind === 'llm' && b.span.kind === 'llm' && a.span.model !== b.span.model) {
    return `model ${a.span.model} vs ${b.span.model}`
  }
  return `name "${a.span.name}" vs "${b.span.name}"`
}
