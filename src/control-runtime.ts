/**
 * Policy-based agent control runtime.
 *
 * This is the minimal reusable loop behind driver-agent patterns:
 *
 *   observe state -> validate -> decide next action -> act -> observe -> ...
 *
 * It deliberately does not model named "topologies". Direct execution,
 * critic/revise, driver intervention, specialist calls, and human escalation
 * are all just actions chosen by the control policy.
 */

import type {
  ControlActionOutcome,
  ControlBudget,
  ControlContext,
  ControlDecision,
  ControlEvalResult,
  ControlRunResult,
  ControlRuntimeConfig,
  ControlRuntimeError,
  ControlStep,
  ControlStopPolicies,
  StopDecision,
} from './control-runtime/contract'
import {
  averageScore,
  budgetStopDecision,
  defaultStopDecision,
  normalizeBudget,
} from './control-runtime/policy'
import { noProgressDetector, repeatedActionDetector } from './detectors'
import { canonicalString } from './ledger-core/canonical'
import { type SpanHandle, TraceEmitter } from './trace/emitter'

export async function runAgentControlLoop<
  TState,
  TAction,
  TActionResult,
  TEval extends ControlEvalResult = ControlEvalResult,
>(
  config: ControlRuntimeConfig<TState, TAction, TActionResult, TEval>,
): Promise<ControlRunResult<TState, TAction, TActionResult, TEval>> {
  const budget = normalizeBudget(config.budget)
  const actionFailure = config.actionFailure ?? 'continue'
  const controller = new AbortController()
  const upstreamAbort = () => controller.abort(config.signal?.reason)
  if (config.signal) {
    if (config.signal.aborted) controller.abort(config.signal.reason)
    else config.signal.addEventListener('abort', upstreamAbort, { once: true })
  }

  const started = Date.now()
  const wallTimer = budget.maxWallMs
    ? setTimeout(
        () => controller.abort(new Error('control runtime wall timeout')),
        budget.maxWallMs,
      )
    : undefined
  const history: ControlStep<TState, TAction, TActionResult, TEval>[] = []
  // `runTrace` records every dropped trace write as a runtime error, so the
  // emitter's default process warning would only repeat it.
  const emitter = config.store
    ? new TraceEmitter(config.store, { onCaptureError: () => undefined })
    : undefined
  let spentCostUsd = 0
  const runtimeErrors: ControlRuntimeError[] = []
  // The stuck-detection kernels (shared with the online detectors). Thresholds 0 = disabled; the
  // streak is still tracked for telemetry. Both stops report `tool_recovery_failure`.
  const repeatedDetector = repeatedActionDetector({
    maxRepeated: config.stopPolicies?.maxRepeatedActions ?? 0,
  })
  const progressDetector = noProgressDetector({
    maxNoProgress: config.stopPolicies?.maxNoProgressSteps ?? 0,
    minScoreDelta: config.stopPolicies?.minScoreDelta ?? 0.001,
  })

  try {
    if (emitter) {
      await runTrace(emitter, runtimeErrors, 0, () =>
        emitter.startRun({
          scenarioId: config.scenarioId ?? 'agent-control-loop',
          projectId: config.projectId,
          variantId: config.variantId,
          layer: 'meta',
          tags: {
            intent: config.intent.slice(0, 120),
            maxSteps: String(budget.maxSteps),
            ...(budget.maxCostUsd !== undefined ? { maxCostUsd: String(budget.maxCostUsd) } : {}),
          },
        }),
      )
    }

    let state: TState
    let evals: TEval[]
    try {
      state = await config.observe({ history, abortSignal: controller.signal })
    } catch (err) {
      const error = runtimeError('observe', 0, err)
      runtimeErrors.push(error)
      return finish(emitter, {
        intent: config.intent,
        pass: false,
        completed: false,
        reason: error.message,
        steps: history,
        finalState: undefined,
        finalEvals: [],
        wallMs: Date.now() - started,
        spentCostUsd,
        runId: emitter?.runId ?? null,
        failureClass: 'unknown',
        runtimeErrors,
        stoppedBy: 'runtime-error',
      })
    }
    try {
      evals = await config.validate({
        intent: config.intent,
        state,
        history,
        abortSignal: controller.signal,
      })
      await recordEvalSpans(emitter, evals, 'initial', runtimeErrors, 0)
    } catch (err) {
      const error = runtimeError('validate', 0, err)
      runtimeErrors.push(error)
      return finish(emitter, {
        intent: config.intent,
        pass: false,
        completed: false,
        reason: error.message,
        steps: history,
        finalState: state,
        finalEvals: [],
        wallMs: Date.now() - started,
        spentCostUsd,
        runId: emitter?.runId ?? null,
        failureClass: 'unknown',
        runtimeErrors,
        stoppedBy: 'runtime-error',
      })
    }
    // Prime the no-progress detector with the initial state + score so step 0 can already detect a
    // no-op (mirrors the pre-loop fingerprint baseline). The priming observe never signals (streak 0).
    progressDetector.observe({
      stateFingerprint: fingerprintState(state, config.stopPolicies),
      score: averageScore(evals),
    })

    for (let stepIndex = 0; stepIndex < budget.maxSteps; stepIndex++) {
      if (controller.signal.aborted) {
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: abortReason(controller.signal),
          score: undefined,
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'timeout',
          runtimeErrors,
          stoppedBy: 'abort',
        })
      }

      const budgetStop = budgetStopDecision(budget, spentCostUsd)
      if (budgetStop.stop) {
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: budgetStop.reason,
          score: averageScore(evals),
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'budget_exceeded',
          runtimeErrors,
          stoppedBy: 'budget',
        })
      }

      const ctx = makeContext(
        config.intent,
        state,
        evals,
        history,
        budget,
        stepIndex,
        started,
        spentCostUsd,
        controller.signal,
        emitter,
      )
      let stop: StopDecision
      try {
        stop = config.shouldStop ? await config.shouldStop(ctx) : defaultStopDecision(evals)
      } catch (err) {
        runtimeErrors.push(runtimeError('stop-policy', stepIndex, err))
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: runtimeErrors[runtimeErrors.length - 1]!.message,
          score: averageScore(evals),
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'unknown',
          runtimeErrors,
          stoppedBy: 'runtime-error',
        })
      }
      if (stop.stop) {
        return finish(emitter, {
          intent: config.intent,
          pass: stop.pass,
          completed: true,
          reason: stop.reason,
          score: stop.score,
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: stop.failureClass,
          runtimeErrors,
          stoppedBy: 'stop-policy',
        })
      }

      let decision: ControlDecision<TAction>
      try {
        decision = await config.decide(ctx)
      } catch (err) {
        runtimeErrors.push(runtimeError('decide', stepIndex, err))
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: runtimeErrors[runtimeErrors.length - 1]!.message,
          score: averageScore(evals),
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'unknown',
          runtimeErrors,
          stoppedBy: 'runtime-error',
        })
      }
      if (decision.type === 'stop') {
        const pass = decision.pass ?? false
        return finish(emitter, {
          intent: config.intent,
          pass,
          completed: true,
          reason: decision.reason,
          score: decision.score,
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: pass ? undefined : (decision.failureClass ?? 'unknown'),
          runtimeErrors,
          stoppedBy: 'policy',
        })
      }

      const actionFingerprint = fingerprintAction(decision.action, config.stopPolicies)
      const repeatedActionSignal = repeatedDetector.observe({ actionFingerprint })
      const repeatedActionStreak = repeatedDetector.streak
      if (repeatedActionSignal) {
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: true,
          reason: repeatedActionSignal.reason,
          score: averageScore(evals),
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'tool_recovery_failure',
          runtimeErrors,
          stoppedBy: 'stop-policy',
        })
      }

      const beforeState = state
      const evalsBefore = evals
      const scoreBefore = averageScore(evals)
      const actionStarted = Date.now()
      const stepHandle = emitter
        ? await runTrace(emitter, runtimeErrors, stepIndex, () =>
            emitter.tool({
              name: `control-step-${stepIndex}`,
              toolName: 'agent-control-action',
              args: decision.action,
              attributes: {
                decision: decision.reason ?? 'continue',
                repeatedActionStreak,
              },
            }),
          )
        : undefined
      let actionOutcome: ControlActionOutcome<TActionResult>
      try {
        const result = await config.act(decision.action, ctx)
        const rawCostUsd = config.getActionCostUsd?.({
          action: decision.action,
          result,
          state,
          evals,
          history,
        })
        const costUsd = normalizeActionCostUsd(rawCostUsd, runtimeErrors, stepIndex)
        if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd > 0) {
          spentCostUsd += costUsd
          await recordCostBudget(
            emitter,
            budget,
            spentCostUsd,
            stepHandle,
            runtimeErrors,
            stepIndex,
          )
        }
        actionOutcome = {
          ok: true,
          result,
          ...(costUsd !== undefined ? { costUsd } : {}),
          durationMs: Date.now() - actionStarted,
        }
      } catch (err) {
        runtimeErrors.push(runtimeError('act', stepIndex, err))
        actionOutcome = {
          ok: false,
          error: runtimeErrors[runtimeErrors.length - 1]!.message,
          durationMs: Date.now() - actionStarted,
        }
        if (actionFailure === 'stop') {
          await runTrace(emitter, runtimeErrors, stepIndex, () =>
            stepHandle?.fail(actionOutcome.error ?? 'action failed'),
          )
          const step: ControlStep<TState, TAction, TActionResult, TEval> = {
            index: stepIndex,
            decision,
            beforeState,
            afterState: state,
            evalsBefore,
            evalsAfter: evals,
            actionOutcome,
            startedAt: new Date(actionStarted).toISOString(),
            endedAt: new Date().toISOString(),
          }
          history.push(step)
          await runOnStep(config.onStep, step, runtimeErrors)
          return finish(emitter, {
            intent: config.intent,
            pass: false,
            completed: false,
            reason: actionOutcome.error ?? 'action failed',
            score: averageScore(evals),
            steps: history,
            finalState: state,
            finalEvals: evals,
            wallMs: Date.now() - started,
            spentCostUsd,
            runId: emitter?.runId ?? null,
            failureClass: 'unknown',
            runtimeErrors,
            stoppedBy: 'runtime-error',
          })
        }
      }

      let observationPhase: 'observe' | 'validate' = 'observe'
      try {
        state = await config.observe({ history, abortSignal: controller.signal })
        observationPhase = 'validate'
        evals = await config.validate({
          intent: config.intent,
          state,
          history,
          abortSignal: controller.signal,
        })
        await recordEvalSpans(
          emitter,
          evals,
          `step-${stepIndex}`,
          runtimeErrors,
          stepIndex,
          stepHandle?.span.spanId,
        )
      } catch (err) {
        runtimeErrors.push(runtimeError(observationPhase, stepIndex, err))
        const afterState = observationPhase === 'observe' ? beforeState : state
        const step: ControlStep<TState, TAction, TActionResult, TEval> = {
          index: stepIndex,
          decision,
          beforeState,
          afterState,
          evalsBefore,
          evalsAfter: evals,
          actionOutcome,
          startedAt: new Date(actionStarted).toISOString(),
          endedAt: new Date().toISOString(),
        }
        history.push(step)
        await runTrace(emitter, runtimeErrors, stepIndex, () =>
          stepHandle?.fail(runtimeErrors[runtimeErrors.length - 1]!.message),
        )
        await runOnStep(config.onStep, step, runtimeErrors)
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: runtimeErrors[runtimeErrors.length - 1]!.message,
          score: averageScore(evals),
          steps: history,
          finalState: afterState,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'unknown',
          runtimeErrors,
          stoppedBy: 'runtime-error',
        })
      }
      const scoreAfter = averageScore(evals)
      const stateFingerprint = fingerprintState(state, config.stopPolicies)
      const noProgressSignal = progressDetector.observe({ stateFingerprint, score: scoreAfter })
      const noProgressStreak = progressDetector.streak

      const step: ControlStep<TState, TAction, TActionResult, TEval> = {
        index: stepIndex,
        decision,
        beforeState,
        afterState: state,
        evalsBefore,
        evalsAfter: evals,
        actionOutcome,
        startedAt: new Date(actionStarted).toISOString(),
        endedAt: new Date().toISOString(),
      }
      history.push(step)
      if (actionOutcome.ok) {
        await runTrace(emitter, runtimeErrors, stepIndex, () =>
          stepHandle?.end({
            attributes: {
              actionCostUsd: actionOutcome.costUsd ?? null,
              spentCostUsd,
              scoreBefore: scoreBefore ?? null,
              scoreAfter: scoreAfter ?? null,
              noProgressStreak,
            },
          }),
        )
      } else {
        await runTrace(emitter, runtimeErrors, stepIndex, () =>
          stepHandle?.fail(actionOutcome.error ?? 'action failed', {
            attributes: {
              spentCostUsd,
              noProgressStreak,
            },
          }),
        )
      }
      await runOnStep(config.onStep, step, runtimeErrors)

      if (noProgressSignal) {
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: true,
          reason: noProgressSignal.reason,
          score: scoreAfter,
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'tool_recovery_failure',
          runtimeErrors,
          stoppedBy: 'stop-policy',
        })
      }

      const postStepBudgetStop = budgetStopDecision(budget, spentCostUsd)
      if (postStepBudgetStop.stop) {
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: postStepBudgetStop.reason,
          score: scoreAfter,
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'budget_exceeded',
          runtimeErrors,
          stoppedBy: 'budget',
        })
      }

      const postStepCtx = makeContext(
        config.intent,
        state,
        evals,
        history,
        budget,
        stepIndex + 1,
        started,
        spentCostUsd,
        controller.signal,
        emitter,
      )
      let postStepStop: StopDecision
      try {
        postStepStop = config.shouldStop
          ? await config.shouldStop(postStepCtx)
          : defaultStopDecision(evals)
      } catch (err) {
        runtimeErrors.push(runtimeError('stop-policy', stepIndex + 1, err))
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: runtimeErrors[runtimeErrors.length - 1]!.message,
          score: averageScore(evals),
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'unknown',
          runtimeErrors,
          stoppedBy: 'runtime-error',
        })
      }
      if (postStepStop.stop) {
        return finish(emitter, {
          intent: config.intent,
          pass: postStepStop.pass,
          completed: true,
          reason: postStepStop.reason,
          score: postStepStop.score,
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: postStepStop.failureClass,
          runtimeErrors,
          stoppedBy: 'stop-policy',
        })
      }
    }

    return finish(emitter, {
      intent: config.intent,
      pass: false,
      completed: false,
      reason: `budget exhausted: maxSteps=${budget.maxSteps}`,
      steps: history,
      finalState: state,
      finalEvals: evals,
      wallMs: Date.now() - started,
      spentCostUsd,
      runId: emitter?.runId ?? null,
      failureClass: 'budget_exceeded',
      runtimeErrors,
      stoppedBy: 'budget',
    })
  } catch (err) {
    runtimeErrors.push(runtimeError('act', history.length, err))
    return finish(emitter, {
      intent: config.intent,
      pass: false,
      completed: false,
      reason: runtimeErrors[runtimeErrors.length - 1]!.message,
      steps: history,
      finalState: undefined,
      finalEvals: [],
      wallMs: Date.now() - started,
      spentCostUsd,
      runId: emitter?.runId ?? null,
      failureClass: 'unknown',
      runtimeErrors,
      stoppedBy: 'runtime-error',
    })
  } finally {
    if (wallTimer) clearTimeout(wallTimer)
    if (config.signal) config.signal.removeEventListener('abort', upstreamAbort)
  }
}

function makeContext<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  intent: string,
  state: TState,
  evals: TEval[],
  history: ControlStep<TState, TAction, TActionResult, TEval>[],
  budget: ControlBudget,
  stepIndex: number,
  started: number,
  spentCostUsd: number,
  abortSignal: AbortSignal,
  emitter?: TraceEmitter,
): ControlContext<TState, TAction, TActionResult, TEval> {
  return {
    intent,
    state,
    evals,
    history,
    budget,
    stepIndex,
    wallMs: Date.now() - started,
    spentCostUsd,
    remainingCostUsd:
      budget.maxCostUsd === undefined ? undefined : Math.max(0, budget.maxCostUsd - spentCostUsd),
    abortSignal,
    emitter,
  }
}

function fingerprintState<TState, TAction>(
  state: TState,
  policies?: ControlStopPolicies<TState, TAction>,
): string {
  if (policies?.stateFingerprint) return policies.stateFingerprint(state)
  return stableFingerprint(state)
}

function fingerprintAction<TState, TAction>(
  action: TAction,
  policies?: ControlStopPolicies<TState, TAction>,
): string {
  if (policies?.actionFingerprint) return policies.actionFingerprint(action)
  return stableFingerprint(action)
}

/** Default state/action fingerprint: the value itself for a string, `String(value)`
 * for a number, boolean, null or undefined, and RFC 8785 canonical JSON for
 * everything else. A value with no canonical JSON form (an `undefined`-valued
 * field, a non-finite number, a class instance) throws: two states that differ
 * in such a field must not fingerprint alike, and a caller with such state
 * supplies `stopPolicies.stateFingerprint` / `actionFingerprint`. */
function stableFingerprint(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value)
  return canonicalString(value)
}

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason
  if (reason instanceof Error) return reason.message
  return reason ? String(reason) : 'aborted'
}

function runtimeError(
  phase: ControlRuntimeError['phase'],
  stepIndex: number,
  err: unknown,
): ControlRuntimeError {
  const message = err instanceof Error ? err.message : String(err)
  return { phase, stepIndex, message }
}

async function recordCostBudget(
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

async function recordEvalSpans(
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

async function runOnStep<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
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
async function runTrace<T>(
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

async function finish<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
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

function normalizeActionCostUsd(
  costUsd: number | undefined,
  runtimeErrors: ControlRuntimeError[],
  stepIndex: number,
): number | undefined {
  if (costUsd === undefined) return undefined
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    runtimeErrors.push(
      runtimeError('act', stepIndex, new Error(`invalid action costUsd: ${String(costUsd)}`)),
    )
    return undefined
  }
  return costUsd
}
