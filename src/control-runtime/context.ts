import { canonicalString } from '../ledger-core/canonical'
import type { TraceEmitter } from '../trace/emitter'
import type {
  ControlBudget,
  ControlContext,
  ControlEvalResult,
  ControlRuntimeError,
  ControlStep,
  ControlStopPolicies,
} from './contract'

export function makeContext<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
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

export function fingerprintState<TState, TAction>(
  state: TState,
  policies?: ControlStopPolicies<TState, TAction>,
): string {
  if (policies?.stateFingerprint) return policies.stateFingerprint(state)
  return stableFingerprint(state)
}

export function fingerprintAction<TState, TAction>(
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

export function abortReason(signal: AbortSignal): string {
  const reason = signal.reason
  if (reason instanceof Error) return reason.message
  return reason ? String(reason) : 'aborted'
}

export function runtimeError(
  phase: ControlRuntimeError['phase'],
  stepIndex: number,
  err: unknown,
): ControlRuntimeError {
  const message = err instanceof Error ? err.message : String(err)
  return { phase, stepIndex, message }
}
