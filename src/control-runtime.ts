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

/** What every step of one loop shares. `state` and `evals` are the latest observation. */
interface ControlRun<TState, TAction, TActionResult, TEval extends ControlEvalResult> {
  config: ControlRuntimeConfig<TState, TAction, TActionResult, TEval>
  budget: ControlBudget
  signal: AbortSignal
  started: number
  history: ControlStep<TState, TAction, TActionResult, TEval>[]
  emitter: TraceEmitter | undefined
  runtimeErrors: ControlRuntimeError[]
  repeatedDetector: ReturnType<typeof repeatedActionDetector>
  progressDetector: ReturnType<typeof noProgressDetector>
  spentCostUsd: number
  state: TState
  evals: TEval[]
}

type RunResult<TState, TAction, TActionResult, TEval extends ControlEvalResult> = ControlRunResult<
  TState,
  TAction,
  TActionResult,
  TEval
>

/** How a run ends. The run's current state and evals fill whatever the caller leaves out. */
type Settlement<TState, TEval> = Pick<
  ControlRunResult<TState, unknown, unknown, ControlEvalResult>,
  'pass' | 'completed' | 'reason' | 'failureClass' | 'stoppedBy'
> & { score?: number; finalState?: TState | undefined; finalEvals?: TEval[] }

/** The next value, or the result that ends the run. */
type Flow<T, TResult> = { next: T } | { ended: TResult }

/** One action attempted at a step, with what the step needs to record it. */
interface ActionAttempt<TState, TAction, TActionResult, TEval extends ControlEvalResult> {
  decision: Extract<ControlDecision<TAction>, { type: 'continue' }>
  beforeState: TState
  evalsBefore: TEval[]
  scoreBefore: number | undefined
  actionStarted: number
  stepHandle: SpanHandle | undefined
  outcome: ControlActionOutcome<TActionResult>
}

export async function runAgentControlLoop<
  TState,
  TAction,
  TActionResult,
  TEval extends ControlEvalResult = ControlEvalResult,
>(
  config: ControlRuntimeConfig<TState, TAction, TActionResult, TEval>,
): Promise<ControlRunResult<TState, TAction, TActionResult, TEval>> {
  const budget = normalizeBudget(config.budget)
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
  const run: ControlRun<TState, TAction, TActionResult, TEval> = {
    config,
    budget,
    signal: controller.signal,
    started,
    history: [],
    // `runTrace` records every dropped trace write as a runtime error, so the
    // emitter's default process warning would only repeat it.
    emitter: config.store
      ? new TraceEmitter(config.store, { onCaptureError: () => undefined })
      : undefined,
    runtimeErrors: [],
    // The stuck-detection kernels (shared with the online detectors). Thresholds 0 = disabled; the
    // streak is still tracked for telemetry. Both stops report `tool_recovery_failure`.
    repeatedDetector: repeatedActionDetector({
      maxRepeated: config.stopPolicies?.maxRepeatedActions ?? 0,
    }),
    progressDetector: noProgressDetector({
      maxNoProgress: config.stopPolicies?.maxNoProgressSteps ?? 0,
      minScoreDelta: config.stopPolicies?.minScoreDelta ?? 0.001,
    }),
    spentCostUsd: 0,
    // The first observation assigns both before any step reads them.
    state: undefined as TState,
    evals: [],
  }

  try {
    await startTrace(run)
    const failedStart = await observeInitial(run)
    if (failedStart) return failedStart
    // Prime the no-progress detector with the initial state + score so step 0 can already detect a
    // no-op (mirrors the pre-loop fingerprint baseline). The priming observe never signals (streak 0).
    run.progressDetector.observe({
      stateFingerprint: fingerprintState(run.state, config.stopPolicies),
      score: averageScore(run.evals),
    })

    for (let stepIndex = 0; stepIndex < budget.maxSteps; stepIndex++) {
      const ended = await runStep(run, stepIndex)
      if (ended) return ended
    }

    return settle(run, {
      pass: false,
      completed: false,
      reason: `budget exhausted: maxSteps=${budget.maxSteps}`,
      failureClass: 'budget_exceeded',
      stoppedBy: 'budget',
    })
  } catch (err) {
    run.runtimeErrors.push(runtimeError('act', run.history.length, err))
    return settle(run, {
      pass: false,
      completed: false,
      reason: lastErrorMessage(run),
      finalState: undefined,
      finalEvals: [],
      failureClass: 'unknown',
      stoppedBy: 'runtime-error',
    })
  } finally {
    if (wallTimer) clearTimeout(wallTimer)
    if (config.signal) config.signal.removeEventListener('abort', upstreamAbort)
  }
}

/** End the run with `how`; everything not named there is read from the run as it stands now. */
function settle<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  how: Settlement<TState, TEval>,
): Promise<RunResult<TState, TAction, TActionResult, TEval>> {
  return finish(run.emitter, {
    intent: run.config.intent,
    pass: how.pass,
    completed: how.completed,
    reason: how.reason,
    ...('score' in how ? { score: how.score } : {}),
    steps: run.history,
    finalState: 'finalState' in how ? how.finalState : run.state,
    finalEvals: how.finalEvals ?? run.evals,
    wallMs: Date.now() - run.started,
    spentCostUsd: run.spentCostUsd,
    runId: run.emitter?.runId ?? null,
    failureClass: how.failureClass,
    runtimeErrors: run.runtimeErrors,
    stoppedBy: how.stoppedBy,
  })
}

function lastErrorMessage(run: { runtimeErrors: ControlRuntimeError[] }): string {
  return run.runtimeErrors[run.runtimeErrors.length - 1]!.message
}

/** End the run on the runtime error just recorded. */
function settleOnRuntimeError<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  finalState?: { value: TState },
): Promise<RunResult<TState, TAction, TActionResult, TEval>> {
  return settle(run, {
    pass: false,
    completed: false,
    reason: lastErrorMessage(run),
    score: averageScore(run.evals),
    ...(finalState ? { finalState: finalState.value } : {}),
    failureClass: 'unknown',
    stoppedBy: 'runtime-error',
  })
}

async function startTrace<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
): Promise<void> {
  const { emitter, config, budget } = run
  if (!emitter) return
  await runTrace(emitter, run.runtimeErrors, 0, () =>
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

/** The first observation and validation. Returns the result that ends the run when either fails. */
async function observeInitial<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
): Promise<RunResult<TState, TAction, TActionResult, TEval> | undefined> {
  try {
    run.state = await run.config.observe({ history: run.history, abortSignal: run.signal })
  } catch (err) {
    const error = runtimeError('observe', 0, err)
    run.runtimeErrors.push(error)
    return settle(run, {
      pass: false,
      completed: false,
      reason: error.message,
      failureClass: 'unknown',
      stoppedBy: 'runtime-error',
    })
  }
  try {
    run.evals = await run.config.validate({
      intent: run.config.intent,
      state: run.state,
      history: run.history,
      abortSignal: run.signal,
    })
    await recordEvalSpans(run.emitter, run.evals, 'initial', run.runtimeErrors, 0)
  } catch (err) {
    const error = runtimeError('validate', 0, err)
    run.runtimeErrors.push(error)
    return settle(run, {
      pass: false,
      completed: false,
      reason: error.message,
      finalEvals: [],
      failureClass: 'unknown',
      stoppedBy: 'runtime-error',
    })
  }
  return undefined
}

/** One decide-act-observe step. Returns the result that ends the run, or nothing to go on. */
async function runStep<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  stepIndex: number,
): Promise<RunResult<TState, TAction, TActionResult, TEval> | undefined> {
  const halted = await checkAbortAndBudget(run)
  if (halted) return halted

  const ctx = makeRunContext(run, stepIndex)
  const stopped = await checkStopPolicy(run, ctx, stepIndex)
  if (stopped) return stopped

  const chosen = await decideAction(run, ctx, stepIndex)
  if ('ended' in chosen) return chosen.ended
  const { decision } = chosen.next

  const repeated = await detectRepeatedAction(run, decision)
  if ('ended' in repeated) return repeated.ended

  const attempt = await attemptAction(run, ctx, decision, stepIndex, repeated.next)
  if ('ended' in attempt) return attempt.ended

  const observed = await observeAfterAction(run, attempt.next, stepIndex)
  if (observed) return observed
  return recordStepAndCheck(run, attempt.next, stepIndex)
}

async function checkAbortAndBudget<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
): Promise<RunResult<TState, TAction, TActionResult, TEval> | undefined> {
  if (run.signal.aborted) {
    return settle(run, {
      pass: false,
      completed: false,
      reason: abortReason(run.signal),
      score: undefined,
      failureClass: 'timeout',
      stoppedBy: 'abort',
    })
  }
  const budgetStop = budgetStopDecision(run.budget, run.spentCostUsd)
  if (!budgetStop.stop) return undefined
  return settle(run, {
    pass: false,
    completed: false,
    reason: budgetStop.reason,
    score: averageScore(run.evals),
    failureClass: 'budget_exceeded',
    stoppedBy: 'budget',
  })
}

function makeRunContext<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  stepIndex: number,
): ControlContext<TState, TAction, TActionResult, TEval> {
  return makeContext(
    run.config.intent,
    run.state,
    run.evals,
    run.history,
    run.budget,
    stepIndex,
    run.started,
    run.spentCostUsd,
    run.signal,
    run.emitter,
  )
}

/** Ask the stop policy about the current state. `errorStep` is the step a failing policy is recorded against. */
async function checkStopPolicy<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  ctx: ControlContext<TState, TAction, TActionResult, TEval>,
  errorStep: number,
): Promise<RunResult<TState, TAction, TActionResult, TEval> | undefined> {
  let stop: StopDecision
  try {
    stop = run.config.shouldStop ? await run.config.shouldStop(ctx) : defaultStopDecision(run.evals)
  } catch (err) {
    run.runtimeErrors.push(runtimeError('stop-policy', errorStep, err))
    return settleOnRuntimeError(run)
  }
  if (!stop.stop) return undefined
  return settle(run, {
    pass: stop.pass,
    completed: true,
    reason: stop.reason,
    score: stop.score,
    failureClass: stop.failureClass,
    stoppedBy: 'stop-policy',
  })
}

async function decideAction<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  ctx: ControlContext<TState, TAction, TActionResult, TEval>,
  stepIndex: number,
): Promise<
  Flow<
    { decision: Extract<ControlDecision<TAction>, { type: 'continue' }> },
    RunResult<TState, TAction, TActionResult, TEval>
  >
> {
  let decision: ControlDecision<TAction>
  try {
    decision = await run.config.decide(ctx)
  } catch (err) {
    run.runtimeErrors.push(runtimeError('decide', stepIndex, err))
    return { ended: await settleOnRuntimeError(run) }
  }
  if (decision.type !== 'stop') return { next: { decision } }
  const pass = decision.pass ?? false
  return {
    ended: await settle(run, {
      pass,
      completed: true,
      reason: decision.reason,
      score: decision.score,
      failureClass: pass ? undefined : (decision.failureClass ?? 'unknown'),
      stoppedBy: 'policy',
    }),
  }
}

/** Feed the chosen action to the repeated-action detector; its streak is returned for the step's trace. */
async function detectRepeatedAction<
  TState,
  TAction,
  TActionResult,
  TEval extends ControlEvalResult,
>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  decision: Extract<ControlDecision<TAction>, { type: 'continue' }>,
): Promise<Flow<number, RunResult<TState, TAction, TActionResult, TEval>>> {
  const actionFingerprint = fingerprintAction(decision.action, run.config.stopPolicies)
  const signal = run.repeatedDetector.observe({ actionFingerprint })
  if (!signal) return { next: run.repeatedDetector.streak }
  return {
    ended: await settle(run, {
      pass: false,
      completed: true,
      reason: signal.reason,
      score: averageScore(run.evals),
      failureClass: 'tool_recovery_failure',
      stoppedBy: 'stop-policy',
    }),
  }
}

/** Run the chosen action under its trace span and price it. A failed action ends the run only when `actionFailure` is 'stop'. */
async function attemptAction<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  ctx: ControlContext<TState, TAction, TActionResult, TEval>,
  decision: Extract<ControlDecision<TAction>, { type: 'continue' }>,
  stepIndex: number,
  repeatedActionStreak: number,
): Promise<
  Flow<
    ActionAttempt<TState, TAction, TActionResult, TEval>,
    RunResult<TState, TAction, TActionResult, TEval>
  >
> {
  const { config, emitter, runtimeErrors } = run
  const beforeState = run.state
  const evalsBefore = run.evals
  const scoreBefore = averageScore(run.evals)
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
  let outcome: ControlActionOutcome<TActionResult>
  try {
    const result = await config.act(decision.action, ctx)
    const rawCostUsd = config.getActionCostUsd?.({
      action: decision.action,
      result,
      state: run.state,
      evals: run.evals,
      history: run.history,
    })
    const costUsd = normalizeActionCostUsd(rawCostUsd, runtimeErrors, stepIndex)
    if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd > 0) {
      run.spentCostUsd += costUsd
      await recordCostBudget(
        emitter,
        run.budget,
        run.spentCostUsd,
        stepHandle,
        runtimeErrors,
        stepIndex,
      )
    }
    outcome = {
      ok: true,
      result,
      ...(costUsd !== undefined ? { costUsd } : {}),
      durationMs: Date.now() - actionStarted,
    }
  } catch (err) {
    runtimeErrors.push(runtimeError('act', stepIndex, err))
    outcome = {
      ok: false,
      error: lastErrorMessage(run),
      durationMs: Date.now() - actionStarted,
    }
    if ((config.actionFailure ?? 'continue') === 'stop') {
      await runTrace(emitter, runtimeErrors, stepIndex, () =>
        stepHandle?.fail(outcome.error ?? 'action failed'),
      )
      const step = buildStep(
        run,
        { decision, beforeState, evalsBefore, scoreBefore, actionStarted, stepHandle, outcome },
        stepIndex,
        run.state,
      )
      run.history.push(step)
      await runOnStep(config.onStep, step, runtimeErrors)
      return {
        ended: await settle(run, {
          pass: false,
          completed: false,
          reason: outcome.error ?? 'action failed',
          score: averageScore(run.evals),
          failureClass: 'unknown',
          stoppedBy: 'runtime-error',
        }),
      }
    }
  }
  return {
    next: { decision, beforeState, evalsBefore, scoreBefore, actionStarted, stepHandle, outcome },
  }
}

function buildStep<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  attempt: ActionAttempt<TState, TAction, TActionResult, TEval>,
  stepIndex: number,
  afterState: TState,
): ControlStep<TState, TAction, TActionResult, TEval> {
  return {
    index: stepIndex,
    decision: attempt.decision,
    beforeState: attempt.beforeState,
    afterState,
    evalsBefore: attempt.evalsBefore,
    evalsAfter: run.evals,
    actionOutcome: attempt.outcome,
    startedAt: new Date(attempt.actionStarted).toISOString(),
    endedAt: new Date().toISOString(),
  }
}

/** Observe and validate after the action. A failure records the step and ends the run. */
async function observeAfterAction<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  attempt: ActionAttempt<TState, TAction, TActionResult, TEval>,
  stepIndex: number,
): Promise<RunResult<TState, TAction, TActionResult, TEval> | undefined> {
  const { config, emitter, runtimeErrors } = run
  let observationPhase: 'observe' | 'validate' = 'observe'
  try {
    run.state = await config.observe({ history: run.history, abortSignal: run.signal })
    observationPhase = 'validate'
    run.evals = await config.validate({
      intent: config.intent,
      state: run.state,
      history: run.history,
      abortSignal: run.signal,
    })
    await recordEvalSpans(
      emitter,
      run.evals,
      `step-${stepIndex}`,
      runtimeErrors,
      stepIndex,
      attempt.stepHandle?.span.spanId,
    )
    return undefined
  } catch (err) {
    runtimeErrors.push(runtimeError(observationPhase, stepIndex, err))
    const afterState = observationPhase === 'observe' ? attempt.beforeState : run.state
    const step = buildStep(run, attempt, stepIndex, afterState)
    run.history.push(step)
    await runTrace(emitter, runtimeErrors, stepIndex, () =>
      attempt.stepHandle?.fail(lastErrorMessage(run)),
    )
    await runOnStep(config.onStep, step, runtimeErrors)
    return settleOnRuntimeError(run, { value: afterState })
  }
}

/** Record the finished step, then apply the no-progress, budget and stop-policy checks that follow it. */
async function recordStepAndCheck<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRun<TState, TAction, TActionResult, TEval>,
  attempt: ActionAttempt<TState, TAction, TActionResult, TEval>,
  stepIndex: number,
): Promise<RunResult<TState, TAction, TActionResult, TEval> | undefined> {
  const { config, emitter, runtimeErrors } = run
  const scoreAfter = averageScore(run.evals)
  const stateFingerprint = fingerprintState(run.state, config.stopPolicies)
  const noProgressSignal = run.progressDetector.observe({ stateFingerprint, score: scoreAfter })
  const noProgressStreak = run.progressDetector.streak

  const step = buildStep(run, attempt, stepIndex, run.state)
  run.history.push(step)
  const { outcome, stepHandle } = attempt
  if (outcome.ok) {
    await runTrace(emitter, runtimeErrors, stepIndex, () =>
      stepHandle?.end({
        attributes: {
          actionCostUsd: outcome.costUsd ?? null,
          spentCostUsd: run.spentCostUsd,
          scoreBefore: attempt.scoreBefore ?? null,
          scoreAfter: scoreAfter ?? null,
          noProgressStreak,
        },
      }),
    )
  } else {
    await runTrace(emitter, runtimeErrors, stepIndex, () =>
      stepHandle?.fail(outcome.error ?? 'action failed', {
        attributes: {
          spentCostUsd: run.spentCostUsd,
          noProgressStreak,
        },
      }),
    )
  }
  await runOnStep(config.onStep, step, runtimeErrors)

  if (noProgressSignal) {
    return settle(run, {
      pass: false,
      completed: true,
      reason: noProgressSignal.reason,
      score: scoreAfter,
      failureClass: 'tool_recovery_failure',
      stoppedBy: 'stop-policy',
    })
  }

  const postStepBudgetStop = budgetStopDecision(run.budget, run.spentCostUsd)
  if (postStepBudgetStop.stop) {
    return settle(run, {
      pass: false,
      completed: false,
      reason: postStepBudgetStop.reason,
      score: scoreAfter,
      failureClass: 'budget_exceeded',
      stoppedBy: 'budget',
    })
  }

  return checkStopPolicy(run, makeRunContext(run, stepIndex + 1), stepIndex + 1)
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
