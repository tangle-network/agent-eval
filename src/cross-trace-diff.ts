/**
 * Full cross-trace diff — align two trajectories step-by-step, report
 * per-step score deltas, attribute a variant's total outcome lead to
 * specific turns.
 *
 * 0.5 shipped `firstDivergenceView` (finds the first differing step).
 * This does the heavier work: full alignment via LCS, per-step
 * contribution to score delta using PRM verdicts when available,
 * fallback to structural heuristics (latency, token count, tool
 * outcome) otherwise.
 */

import type { JudgeSpan, Span } from './trace/schema'
import { isJudgeSpan } from './trace/schema'
import type { TraceStore } from './trace/store'
import { buildTrajectory, type TrajectoryStep } from './trajectory'

export type AlignmentOp =
  | { op: 'match'; a: TrajectoryStep; b: TrajectoryStep }
  | { op: 'insert'; b: TrajectoryStep }
  | { op: 'delete'; a: TrajectoryStep }
  | { op: 'replace'; a: TrajectoryStep; b: TrajectoryStep }

export interface StepAttribution {
  op: AlignmentOp
  /** Difference in PRM score (or null when not scored by a matching judge). */
  prmDelta: number | null
  /** Difference in latency (endedAt - startedAt). */
  latencyDeltaMs: number | null
  /** Difference in token count (LLM spans). */
  tokenDelta: number | null
  /** Reason this step is / isn't considered a contributor to the outcome delta. */
  note: string
}

export interface CrossTraceDiff {
  runA: string
  runB: string
  alignment: AlignmentOp[]
  attributions: StepAttribution[]
  /** Total score delta (B - A). */
  totalScoreDelta: number | null
  /** Sum of PRM deltas across matched/replaced steps. Close to
   *  `totalScoreDelta` when PRM covers the trajectory; gap indicates
   *  unmodeled variance. */
  prmDeltaSum: number
}

export interface CrossTraceDiffOptions {
  stepEquals?: (a: TrajectoryStep, b: TrajectoryStep) => boolean
}

export async function crossTraceDiff(
  store: TraceStore,
  runA: string,
  runB: string,
  options: CrossTraceDiffOptions = {},
): Promise<CrossTraceDiff> {
  const [a, b] = await Promise.all([buildTrajectory(store, runA), buildTrajectory(store, runB)])
  const eq = options.stepEquals ?? defaultStepEquals
  const alignment = align(a.steps, b.steps, eq)

  const [judgesA, judgesB] = await Promise.all([
    store.spans({ runId: runA, kind: 'judge' }).then((s) => s.filter(isJudgeSpan)),
    store.spans({ runId: runB, kind: 'judge' }).then((s) => s.filter(isJudgeSpan)),
  ])
  const prmByTargetA = indexPrmByTarget(judgesA)
  const prmByTargetB = indexPrmByTarget(judgesB)

  const attributions: StepAttribution[] = alignment.map((ao) =>
    attributeStep(ao, prmByTargetA, prmByTargetB),
  )
  const prmDeltaSum = attributions.reduce((acc, at) => acc + (at.prmDelta ?? 0), 0)

  const [runRecA, runRecB] = await Promise.all([store.getRun(runA), store.getRun(runB)])
  const totalScoreDelta =
    runRecA?.outcome?.score !== undefined && runRecB?.outcome?.score !== undefined
      ? runRecB.outcome.score - runRecA.outcome.score
      : null

  return { runA, runB, alignment, attributions, totalScoreDelta, prmDeltaSum }
}

// ── Alignment (LCS-based) ────────────────────────────────────────────

function align(
  a: TrajectoryStep[],
  b: TrajectoryStep[],
  eq: (x: TrajectoryStep, y: TrajectoryStep) => boolean,
): AlignmentOp[] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (eq(a[i - 1]!, b[j - 1]!)) dp[i]![j] = dp[i - 1]![j - 1]! + 1
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }
  // Walk back to recover ops.
  const ops: AlignmentOp[] = []
  let i = a.length
  let j = b.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && eq(a[i - 1]!, b[j - 1]!)) {
      ops.push({ op: 'match', a: a[i - 1]!, b: b[j - 1]! })
      i--
      j--
    } else if (i > 0 && j > 0 && dp[i - 1]![j]! === dp[i]![j - 1]!) {
      // Tie → call it a replace when same kind, else delete+insert.
      if (a[i - 1]!.span.kind === b[j - 1]!.span.kind) {
        ops.push({ op: 'replace', a: a[i - 1]!, b: b[j - 1]! })
        i--
        j--
      } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
        ops.push({ op: 'delete', a: a[i - 1]! })
        i--
      } else {
        ops.push({ op: 'insert', b: b[j - 1]! })
        j--
      }
    } else if (i > 0 && (j === 0 || dp[i - 1]![j]! >= dp[i]![j - 1]!)) {
      ops.push({ op: 'delete', a: a[i - 1]! })
      i--
    } else {
      ops.push({ op: 'insert', b: b[j - 1]! })
      j--
    }
  }
  return ops.reverse()
}

function defaultStepEquals(a: TrajectoryStep, b: TrajectoryStep): boolean {
  if (a.span.kind !== b.span.kind) return false
  if (a.span.kind === 'tool' && b.span.kind === 'tool') return a.span.toolName === b.span.toolName
  if (a.span.kind === 'llm' && b.span.kind === 'llm') return a.span.model === b.span.model
  return a.span.name === b.span.name
}

// ── PRM indexing + attribution ───────────────────────────────────────

function indexPrmByTarget(judges: JudgeSpan[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const j of judges) {
    const prior = out.get(j.targetSpanId) ?? 0
    out.set(j.targetSpanId, prior + j.score)
  }
  return out
}

function spanLatency(s: Span): number | null {
  return s.endedAt && s.startedAt ? s.endedAt - s.startedAt : null
}

function spanTokens(s: Span): number | null {
  if (s.kind !== 'llm') return null
  return (s.inputTokens ?? 0) + (s.outputTokens ?? 0)
}

function attributeStep(
  op: AlignmentOp,
  prmA: Map<string, number>,
  prmB: Map<string, number>,
): StepAttribution {
  if (op.op === 'match') {
    const pa = prmA.get(op.a.span.spanId)
    const pb = prmB.get(op.b.span.spanId)
    const prmDelta = pa !== undefined && pb !== undefined ? pb - pa : null
    const la = spanLatency(op.a.span)
    const lb = spanLatency(op.b.span)
    const ta = spanTokens(op.a.span)
    const tb = spanTokens(op.b.span)
    return {
      op,
      prmDelta,
      latencyDeltaMs: la !== null && lb !== null ? lb - la : null,
      tokenDelta: ta !== null && tb !== null ? tb - ta : null,
      note:
        prmDelta === null ? 'matched step, no PRM coverage' : 'matched step, PRM delta recorded',
    }
  }
  if (op.op === 'replace') {
    const pa = prmA.get(op.a.span.spanId) ?? 0
    const pb = prmB.get(op.b.span.spanId) ?? 0
    return {
      op,
      prmDelta: pb - pa,
      latencyDeltaMs: null,
      tokenDelta: null,
      note: `replaced ${op.a.span.kind}/${op.a.span.name} → ${op.b.span.kind}/${op.b.span.name}`,
    }
  }
  if (op.op === 'insert') {
    const pb = prmB.get(op.b.span.spanId) ?? 0
    return {
      op,
      prmDelta: pb,
      latencyDeltaMs: null,
      tokenDelta: null,
      note: `inserted step in B (${op.b.span.kind}/${op.b.span.name})`,
    }
  }
  // delete
  const pa = prmA.get(op.a.span.spanId) ?? 0
  return {
    op,
    prmDelta: -pa,
    latencyDeltaMs: null,
    tokenDelta: null,
    note: `deleted step from A (${op.a.span.kind}/${op.a.span.name})`,
  }
}
