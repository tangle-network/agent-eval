import type { TraceEmitter } from '../trace/emitter'
import type { FailureClass } from '../trace/schema'
import type { TraceStore } from '../trace/store'

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

export interface ControlContext<
  TState,
  TAction,
  TActionResult,
  TEval extends ControlEvalResult = ControlEvalResult,
> {
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
      /** Canonical task-failure class when this stop represents a failed task. */
      failureClass?: FailureClass
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

export interface ControlStep<
  TState,
  TAction,
  TActionResult,
  TEval extends ControlEvalResult = ControlEvalResult,
> {
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

export interface ControlRunResult<
  TState,
  TAction,
  TActionResult,
  TEval extends ControlEvalResult = ControlEvalResult,
> {
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
  /** null when the run executed without a TraceEmitter wired (no run record was persisted). */
  runId: string | null
  failureClass?: FailureClass
  runtimeErrors: ControlRuntimeError[]
  stoppedBy: 'policy' | 'stop-policy' | 'budget' | 'abort' | 'runtime-error'
}

export interface ControlRuntimeConfig<
  TState,
  TAction,
  TActionResult,
  TEval extends ControlEvalResult = ControlEvalResult,
> {
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
  decide: (
    ctx: ControlContext<TState, TAction, TActionResult, TEval>,
  ) => Promise<ControlDecision<TAction>> | ControlDecision<TAction>

  /** Execute the action selected by the policy. */
  act: (
    action: TAction,
    ctx: ControlContext<TState, TAction, TActionResult, TEval>,
  ) => Promise<TActionResult> | TActionResult

  /** Final stopping policy. Called before decide and after each action. */
  shouldStop?: (
    ctx: ControlContext<TState, TAction, TActionResult, TEval>,
  ) => Promise<StopDecision> | StopDecision

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
