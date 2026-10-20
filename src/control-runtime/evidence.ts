import type { SpanHandle, TraceEmitter } from '../trace/emitter'
import { runtimeError } from './context'
import type {
  ControlBudget,
  ControlEvalResult,
  ControlRunResult,
  ControlRuntimeConfig,
  ControlRuntimeError,
  ControlStep,
} from './contract'
import { averageScore } from './policy'

export async function recordCostBudget(
  emitter: TraceEmitter | undefined,
  budget: ControlBudget,
  spentCostUsd: number,
  handle: SpanHandle | undefined,
  runtimeErrors: ControlRuntimeError[],
  stepIndex: number,
): Promise<void> {
  if (!emitter || budget.maxCostUsd === undefined) return
  const maxCostUsd = budget.maxCostUsd
  await runTrace(emitter, runtimeErrors, stepIndex, () =>
    emitter.recordBudget({
      dimension: 'usd',
      limit: maxCostUsd,
      consumed: spentCostUsd,
      remaining: Math.max(0, maxCostUsd - spentCostUsd),
      breached: spentCostUsd >= maxCostUsd,
      spanId: handle?.span.spanId,
    }),
  )
}

export async function recordEvalSpans(
  emitter: TraceEmitter | undefined,
  evals: ControlEvalResult[],
  phase: string,
  runtimeErrors: ControlRuntimeError[],
  stepIndex: number,
  targetSpanId?: string,
): Promise<void> {
  if (!emitter) return
  for (const result of evals) {
    await runTrace(emitter, runtimeErrors, stepIndex, () =>
      emitter.recordJudge({
        judgeId: result.objective ? 'objective-validator' : 'subjective-judge',
        targetSpanId: targetSpanId ?? emitter.runId,
        name: `control-eval/${result.id}`,
        dimension: result.id,
        score: typeof result.score === 'number' ? result.score : result.passed ? 1 : 0,
        rationale: result.detail,
        evidence: result.evidence,
        attributes: {
          phase,
          passed: result.passed,
          severity: result.severity,
          objective: result.objective,
        },
      }),
    )
  }
}

export async function runOnStep<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  onStep: ControlRuntimeConfig<TState, TAction, TActionResult, TEval>['onStep'] | undefined,
  step: ControlStep<TState, TAction, TActionResult, TEval>,
  runtimeErrors: ControlRuntimeError[],
): Promise<void> {
  if (!onStep) return
  try {
    await onStep(step)
  } catch (err) {
    runtimeErrors.push(runtimeError('on-step', step.index, err))
  }
}

/**
 * Run trace writes and record a `trace` runtime error when any of them was
 * dropped. The emitter never throws a failed store write; it counts it, so the
 * count is what this reads. A throw from building the write is recorded too.
 */
export async function runTrace<T>(
  emitter: TraceEmitter | undefined,
  runtimeErrors: ControlRuntimeError[],
  stepIndex: number,
  write: () => Promise<T | undefined> | T | undefined,
): Promise<T | undefined> {
  if (!emitter) return undefined
  const droppedBefore = emitter.captureStats().dropped
  let value: T | undefined
  try {
    value = await write()
  } catch (err) {
    runtimeErrors.push(runtimeError('trace', stepIndex, err))
    return undefined
  }
  const after = emitter.captureStats()
  if (after.dropped > droppedBefore) {
    runtimeErrors.push(runtimeError('trace', stepIndex, after.lastError ?? 'trace write dropped'))
  }
  return value
}

export async function finish<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  emitter: TraceEmitter | undefined,
  result: ControlRunResult<TState, TAction, TActionResult, TEval>,
): Promise<ControlRunResult<TState, TAction, TActionResult, TEval>> {
  await runTrace(emitter, result.runtimeErrors, result.steps.length, () =>
    emitter?.endRun({
      pass: result.pass,
      score: result.score ?? averageScore(result.finalEvals),
      failureClass: result.failureClass,
      notes: result.reason,
    }),
  )
  return result
}
