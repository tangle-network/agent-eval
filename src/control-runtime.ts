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

import { TraceEmitter, type SpanHandle } from './trace/emitter'
import type { FailureClass } from './trace/schema'
import type { TraceStore } from './trace/store'

export type ControlSeverity = 'info' | 'warning' | 'error' | 'critical'
export type ControlActionFailureMode = 'continue' | 'stop'

export interface ControlEvalResult {
  /** Stable validator or judge id. */
  id: string
  /** Whether this check passed. */
  passed: boolean
  /** Optional normalized score. 1 = best, 0 = worst. */
  score?: number
  /** Objective validators should usually be "error" or "critical" when failed. */
  severity?: ControlSeverity
  /** Human-readable result. */
  detail?: string
  /** Small evidence string or pointer. Avoid large payloads. */
  evidence?: string
  /** True when the result came from deterministic state, not LLM judgment. */
  objective?: boolean
  /** Structured details for downstream control policies and reports. */
  metadata?: Record<string, unknown>
}

export interface ControlBudget {
  maxSteps: number
  maxWallMs?: number
  maxCostUsd?: number
}

export interface ControlStopPolicies<TState, TAction> {
  /**
   * Stop after N consecutive steps with no state fingerprint change and
   * less than `minScoreDelta` score movement. Disabled when omitted.
   */
  maxNoProgressSteps?: number
  /**
   * Stop after the same action fingerprint is selected N consecutive
   * times. Disabled when omitted.
   */
  maxRepeatedActions?: number
  /** Minimum score movement that counts as progress. Default 0.001. */
  minScoreDelta?: number
  /** Override the default JSON/string fingerprint for state comparisons. */
  stateFingerprint?: (state: TState) => string
  /** Override the default JSON/string fingerprint for repeated-action checks. */
  actionFingerprint?: (action: TAction) => string
}

export interface ControlContext<TState, TAction, TActionResult, TEval extends ControlEvalResult = ControlEvalResult> {
  intent: string
  state: TState
  evals: TEval[]
  history: ControlStep<TState, TAction, TActionResult, TEval>[]
  budget: ControlBudget
  stepIndex: number
  wallMs: number
  spentCostUsd: number
  remainingCostUsd?: number
  abortSignal: AbortSignal
  emitter?: TraceEmitter
}

export type ControlDecision<TAction> =
  | {
    type: 'continue'
    action: TAction
    reason?: string
  }
  | {
    type: 'stop'
    reason: string
    pass?: boolean
    score?: number
  }

export interface StopDecision {
  stop: boolean
  pass: boolean
  reason: string
  score?: number
  failureClass?: FailureClass
}

export interface ControlActionOutcome<TActionResult> {
  ok: boolean
  result?: TActionResult
  error?: string
  costUsd?: number
  durationMs: number
}

export interface ControlRuntimeError {
  phase: 'observe' | 'validate' | 'decide' | 'act' | 'stop-policy' | 'on-step' | 'trace'
  stepIndex: number
  message: string
}

export interface ControlStep<TState, TAction, TActionResult, TEval extends ControlEvalResult = ControlEvalResult> {
  index: number
  decision: ControlDecision<TAction>
  beforeState: TState
  afterState: TState
  evalsBefore: TEval[]
  evalsAfter: TEval[]
  actionOutcome?: ControlActionOutcome<TActionResult>
  startedAt: string
  endedAt: string
}

export interface ControlRunResult<TState, TAction, TActionResult, TEval extends ControlEvalResult = ControlEvalResult> {
  intent: string
  pass: boolean
  completed: boolean
  reason: string
  score?: number
  steps: ControlStep<TState, TAction, TActionResult, TEval>[]
  finalState: TState | undefined
  finalEvals: TEval[]
  wallMs: number
  spentCostUsd: number
  runId: string | null
  failureClass?: FailureClass
  runtimeErrors: ControlRuntimeError[]
  stoppedBy: 'policy' | 'stop-policy' | 'budget' | 'abort' | 'runtime-error'
}

export interface ControlRuntimeConfig<TState, TAction, TActionResult, TEval extends ControlEvalResult = ControlEvalResult> {
  intent: string
  budget?: Partial<ControlBudget>
  signal?: AbortSignal
  /** Defaults to `continue`: action failures are recorded, then the policy gets another chance. */
  actionFailure?: ControlActionFailureMode
  /**
   * Extract cost from an action result. Used for `maxCostUsd` budget
   * enforcement and trace budget ledger emission.
   */
  getActionCostUsd?: (ctx: {
    action: TAction
    result: TActionResult
    state: TState
    evals: TEval[]
    history: ControlStep<TState, TAction, TActionResult, TEval>[]
  }) => number | undefined

  /** Read typed task/product state. Prefer structured state over transcript-only context. */
  observe: (ctx: {
    history: ControlStep<TState, TAction, TActionResult, TEval>[]
    abortSignal: AbortSignal
  }) => Promise<TState> | TState

  /** Objective validators first, subjective judges only where objective state is insufficient. */
  validate: (ctx: {
    intent: string
    state: TState
    history: ControlStep<TState, TAction, TActionResult, TEval>[]
    abortSignal: AbortSignal
  }) => Promise<TEval[]> | TEval[]

  /** Choose the next control action. Can call a worker, ask user, run critic, inspect state, or stop. */
  decide: (ctx: ControlContext<TState, TAction, TActionResult, TEval>) => Promise<ControlDecision<TAction>> | ControlDecision<TAction>

  /** Execute the action selected by the policy. */
  act: (action: TAction, ctx: ControlContext<TState, TAction, TActionResult, TEval>) => Promise<TActionResult> | TActionResult

  /** Final stopping policy. Called before decide and after each action. */
  shouldStop?: (ctx: ControlContext<TState, TAction, TActionResult, TEval>) => Promise<StopDecision> | StopDecision

  /** Optional hook for tracing or live progress updates. */
  onStep?: (step: ControlStep<TState, TAction, TActionResult, TEval>) => Promise<void> | void

  /** Optional generic stuck-loop policies. Custom `shouldStop` still runs first. */
  stopPolicies?: ControlStopPolicies<TState, TAction>

  /** Optional trace sink. Emits one run plus one span per control step. */
  store?: TraceStore
  scenarioId?: string
  projectId?: string
  variantId?: string
}

const DEFAULT_BUDGET: ControlBudget = {
  maxSteps: 8,
  maxWallMs: 5 * 60 * 1000,
}

export async function runAgentControlLoop<TState, TAction, TActionResult, TEval extends ControlEvalResult = ControlEvalResult>(
  config: ControlRuntimeConfig<TState, TAction, TActionResult, TEval>,
): Promise<ControlRunResult<TState, TAction, TActionResult, TEval>> {
  const budget: ControlBudget = { ...DEFAULT_BUDGET, ...config.budget }
  const actionFailure = config.actionFailure ?? 'continue'
  const controller = new AbortController()
  const upstreamAbort = () => controller.abort(config.signal?.reason)
  if (config.signal) {
    if (config.signal.aborted) controller.abort(config.signal.reason)
    else config.signal.addEventListener('abort', upstreamAbort, { once: true })
  }

  const started = Date.now()
  const wallTimer = budget.maxWallMs
    ? setTimeout(() => controller.abort(new Error('control runtime wall timeout')), budget.maxWallMs)
    : undefined
  const history: ControlStep<TState, TAction, TActionResult, TEval>[] = []
  const emitter = config.store ? new TraceEmitter(config.store) : undefined
  let spentCostUsd = 0
  const runtimeErrors: ControlRuntimeError[] = []
  let lastStateFingerprint: string | undefined
  let lastActionFingerprint: string | undefined
  let noProgressStreak = 0
  let repeatedActionStreak = 0

  try {
    if (emitter) {
      await runTrace(runtimeErrors, 0, () => emitter.startRun({
        scenarioId: config.scenarioId ?? 'agent-control-loop',
        projectId: config.projectId,
        variantId: config.variantId,
        layer: 'meta',
        tags: {
          intent: config.intent.slice(0, 120),
          maxSteps: String(budget.maxSteps),
          ...(budget.maxCostUsd !== undefined ? { maxCostUsd: String(budget.maxCostUsd) } : {}),
        },
      }))
    }

    let state: TState
    let evals: TEval[]
    try {
      state = await config.observe({ history, abortSignal: controller.signal })
    } catch (err) {
      runtimeErrors.push(runtimeError('observe', 0, err))
      return finish(emitter, {
        intent: config.intent,
        pass: false,
        completed: false,
        reason: runtimeErrors[0].message,
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
      evals = await config.validate({ intent: config.intent, state, history, abortSignal: controller.signal })
      await recordEvalSpans(emitter, evals, 'initial', runtimeErrors, 0)
    } catch (err) {
      runtimeErrors.push(runtimeError('validate', 0, err))
      return finish(emitter, {
        intent: config.intent,
        pass: false,
        completed: false,
        reason: runtimeErrors[0].message,
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
    lastStateFingerprint = fingerprintState(state, config.stopPolicies)

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

      const ctx = makeContext(config.intent, state, evals, history, budget, stepIndex, started, spentCostUsd, controller.signal, emitter)
      let stop: StopDecision
      try {
        stop = config.shouldStop ? await config.shouldStop(ctx) : defaultStopDecision(evals)
      } catch (err) {
        runtimeErrors.push(runtimeError('stop-policy', stepIndex, err))
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: runtimeErrors[runtimeErrors.length - 1].message,
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
          reason: runtimeErrors[runtimeErrors.length - 1].message,
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
        return finish(emitter, {
          intent: config.intent,
          pass: decision.pass ?? false,
          completed: true,
          reason: decision.reason,
          score: decision.score,
          steps: history,
          finalState: state,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: decision.pass === false ? 'unknown' : undefined,
          runtimeErrors,
          stoppedBy: 'policy',
        })
      }

      const actionFingerprint = fingerprintAction(decision.action, config.stopPolicies)
      repeatedActionStreak = actionFingerprint === lastActionFingerprint ? repeatedActionStreak + 1 : 1
      lastActionFingerprint = actionFingerprint
      const repeatedActionStop = repeatedActionStopDecision(config.stopPolicies, repeatedActionStreak)
      if (repeatedActionStop.stop) {
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: true,
          reason: repeatedActionStop.reason,
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
        ? await runTrace(runtimeErrors, stepIndex, () => emitter.tool({
            name: `control-step-${stepIndex}`,
            toolName: 'agent-control-action',
            args: decision.action,
            attributes: {
              decision: decision.reason ?? 'continue',
              repeatedActionStreak,
            },
          }))
        : undefined
      let actionOutcome: ControlActionOutcome<TActionResult>
      try {
        const result = await config.act(decision.action, ctx)
        const costUsd = config.getActionCostUsd?.({
          action: decision.action,
          result,
          state,
          evals,
          history,
        })
        if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd > 0) {
          spentCostUsd += costUsd
          await recordCostBudget(emitter, budget, spentCostUsd, stepHandle, runtimeErrors, stepIndex)
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
          error: runtimeErrors[runtimeErrors.length - 1].message,
          durationMs: Date.now() - actionStarted,
        }
        if (actionFailure === 'stop') {
          await runTrace(runtimeErrors, stepIndex, () => stepHandle?.fail(actionOutcome.error ?? 'action failed'))
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

      try {
        state = await config.observe({ history, abortSignal: controller.signal })
      } catch (err) {
        runtimeErrors.push(runtimeError('observe', stepIndex, err))
        const step: ControlStep<TState, TAction, TActionResult, TEval> = {
          index: stepIndex,
          decision,
          beforeState,
          afterState: beforeState,
          evalsBefore,
          evalsAfter: evals,
          actionOutcome,
          startedAt: new Date(actionStarted).toISOString(),
          endedAt: new Date().toISOString(),
        }
        history.push(step)
        await runTrace(runtimeErrors, stepIndex, () => stepHandle?.fail(runtimeErrors[runtimeErrors.length - 1].message))
        await runOnStep(config.onStep, step, runtimeErrors)
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: runtimeErrors[runtimeErrors.length - 1].message,
          score: averageScore(evals),
          steps: history,
          finalState: beforeState,
          finalEvals: evals,
          wallMs: Date.now() - started,
          spentCostUsd,
          runId: emitter?.runId ?? null,
          failureClass: 'unknown',
          runtimeErrors,
          stoppedBy: 'runtime-error',
        })
      }
      try {
        evals = await config.validate({ intent: config.intent, state, history, abortSignal: controller.signal })
        await recordEvalSpans(emitter, evals, `step-${stepIndex}`, runtimeErrors, stepIndex, stepHandle?.span.spanId)
      } catch (err) {
        runtimeErrors.push(runtimeError('validate', stepIndex, err))
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
        await runTrace(runtimeErrors, stepIndex, () => stepHandle?.fail(runtimeErrors[runtimeErrors.length - 1].message))
        await runOnStep(config.onStep, step, runtimeErrors)
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: runtimeErrors[runtimeErrors.length - 1].message,
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
      const scoreAfter = averageScore(evals)
      const stateFingerprint = fingerprintState(state, config.stopPolicies)
      const noProgressStop = noProgressStopDecision({
        policies: config.stopPolicies,
        lastStateFingerprint,
        stateFingerprint,
        scoreBefore,
        scoreAfter,
        currentStreak: noProgressStreak,
      })
      noProgressStreak = noProgressStop.streak
      lastStateFingerprint = stateFingerprint

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
        await runTrace(runtimeErrors, stepIndex, () => stepHandle?.end({
          attributes: {
            actionCostUsd: actionOutcome.costUsd ?? null,
            spentCostUsd,
            scoreBefore: scoreBefore ?? null,
            scoreAfter: scoreAfter ?? null,
            noProgressStreak,
          },
        }))
      } else {
        await runTrace(runtimeErrors, stepIndex, () => stepHandle?.fail(actionOutcome.error ?? 'action failed', {
          attributes: {
            spentCostUsd,
            noProgressStreak,
          },
        }))
      }
      await runOnStep(config.onStep, step, runtimeErrors)

      if (noProgressStop.stop) {
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: true,
          reason: noProgressStop.reason,
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

      const postStepCtx = makeContext(config.intent, state, evals, history, budget, stepIndex + 1, started, spentCostUsd, controller.signal, emitter)
      let postStepStop: StopDecision
      try {
        postStepStop = config.shouldStop ? await config.shouldStop(postStepCtx) : defaultStopDecision(evals)
      } catch (err) {
        runtimeErrors.push(runtimeError('stop-policy', stepIndex + 1, err))
        return finish(emitter, {
          intent: config.intent,
          pass: false,
          completed: false,
          reason: runtimeErrors[runtimeErrors.length - 1].message,
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
      reason: runtimeErrors[runtimeErrors.length - 1].message,
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

export function stopOnNoProgress<TState, TAction>(maxNoProgressSteps: number, options: Omit<ControlStopPolicies<TState, TAction>, 'maxNoProgressSteps'> = {}): ControlStopPolicies<TState, TAction> {
  return { ...options, maxNoProgressSteps }
}

export function stopOnRepeatedAction<TState, TAction>(maxRepeatedActions: number, options: Omit<ControlStopPolicies<TState, TAction>, 'maxRepeatedActions'> = {}): ControlStopPolicies<TState, TAction> {
  return { ...options, maxRepeatedActions }
}

export function objectiveEval(input: Omit<ControlEvalResult, 'objective'>): ControlEvalResult {
  return { ...input, objective: true }
}

export function subjectiveEval(input: Omit<ControlEvalResult, 'objective'>): ControlEvalResult {
  return { ...input, objective: false }
}

export function allCriticalPassed(evals: ControlEvalResult[]): boolean {
  return evals.every((result) => result.passed || (result.severity !== 'critical' && result.severity !== 'error'))
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
    remainingCostUsd: budget.maxCostUsd === undefined ? undefined : Math.max(0, budget.maxCostUsd - spentCostUsd),
    abortSignal,
    emitter,
  }
}

function defaultStopDecision(evals: ControlEvalResult[]): StopDecision {
  if (!evals.length) return { stop: false, pass: false, reason: 'no evals yet' }
  const pass = allCriticalPassed(evals)
  return pass
    ? { stop: true, pass: true, reason: 'all critical evals passed', score: averageScore(evals) }
    : { stop: false, pass: false, reason: 'critical evals still failing', score: averageScore(evals) }
}

function averageScore(evals: ControlEvalResult[]): number | undefined {
  const scored = evals.map((result) => result.score).filter((score): score is number => typeof score === 'number')
  if (!scored.length) return undefined
  return Math.round((scored.reduce((sum, score) => sum + score, 0) / scored.length) * 1000) / 1000
}

function budgetStopDecision(budget: ControlBudget, spentCostUsd: number): { stop: boolean; reason: string } {
  if (budget.maxCostUsd !== undefined && spentCostUsd >= budget.maxCostUsd) {
    return {
      stop: true,
      reason: `budget exhausted: maxCostUsd=${budget.maxCostUsd}`,
    }
  }
  return { stop: false, reason: '' }
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
  await runTrace(runtimeErrors, stepIndex, () => emitter.recordBudget({
    dimension: 'usd',
    limit: maxCostUsd,
    consumed: spentCostUsd,
    remaining: Math.max(0, maxCostUsd - spentCostUsd),
    breached: spentCostUsd >= maxCostUsd,
    spanId: handle?.span.spanId,
  }))
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
    await runTrace(runtimeErrors, stepIndex, () => emitter.recordJudge({
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
    }))
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

async function runTrace<T>(
  runtimeErrors: ControlRuntimeError[],
  stepIndex: number,
  write: () => Promise<T | undefined> | T | undefined,
): Promise<T | undefined> {
  try {
    return await write()
  } catch (err) {
    runtimeErrors.push(runtimeError('trace', stepIndex, err))
    return undefined
  }
}

function noProgressStopDecision<TState, TAction>(args: {
  policies: ControlStopPolicies<TState, TAction> | undefined
  lastStateFingerprint: string | undefined
  stateFingerprint: string
  scoreBefore: number | undefined
  scoreAfter: number | undefined
  currentStreak: number
}): { stop: boolean; reason: string; streak: number } {
  const max = args.policies?.maxNoProgressSteps
  if (!max || max <= 0) return { stop: false, reason: '', streak: 0 }
  const minScoreDelta = args.policies?.minScoreDelta ?? 0.001
  const scoreDelta = Math.abs((args.scoreAfter ?? 0) - (args.scoreBefore ?? 0))
  const stateUnchanged = args.lastStateFingerprint !== undefined
    && args.lastStateFingerprint === args.stateFingerprint
  const scoreFlat = scoreDelta < minScoreDelta
  const streak = stateUnchanged && scoreFlat ? args.currentStreak + 1 : 0
  return streak >= max
    ? { stop: true, reason: `stuck: no state/score progress for ${streak} step(s)`, streak }
    : { stop: false, reason: '', streak }
}

function repeatedActionStopDecision<TState, TAction>(
  policies: ControlStopPolicies<TState, TAction> | undefined,
  streak: number,
): { stop: boolean; reason: string } {
  const max = policies?.maxRepeatedActions
  if (!max || max <= 0 || streak < max) return { stop: false, reason: '' }
  return {
    stop: true,
    reason: `stuck: repeated same action for ${streak} step(s)`,
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

function stableFingerprint(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value)
  try {
    return JSON.stringify(sortForFingerprint(value))
  } catch {
    return String(value)
  }
}

function sortForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForFingerprint)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortForFingerprint(record[key])
  }
  return sorted
}

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason
  if (reason instanceof Error) return reason.message
  return reason ? String(reason) : 'aborted'
}

function runtimeError(phase: ControlRuntimeError['phase'], stepIndex: number, err: unknown): ControlRuntimeError {
  const message = err instanceof Error ? err.message : String(err)
  return { phase, stepIndex, message }
}

async function finish<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  emitter: TraceEmitter | undefined,
  result: ControlRunResult<TState, TAction, TActionResult, TEval>,
): Promise<ControlRunResult<TState, TAction, TActionResult, TEval>> {
  await runTrace(result.runtimeErrors, result.steps.length, () => emitter?.endRun({
    pass: result.pass,
    score: result.score ?? averageScore(result.finalEvals),
    failureClass: result.failureClass,
    notes: result.reason,
  }))
  return result
}
