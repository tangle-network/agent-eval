import { mean } from '../statistics/mean'
import { runtimeError } from './context'
import type {
  ControlBudget,
  ControlEvalResult,
  ControlRuntimeError,
  StopDecision,
} from './contract'

const DEFAULT_BUDGET: ControlBudget = {
  maxSteps: 8,
  maxWallMs: 5 * 60 * 1000,
}

export function objectiveEval(input: Omit<ControlEvalResult, 'objective'>): ControlEvalResult {
  return { ...input, objective: true }
}

export function subjectiveEval(input: Omit<ControlEvalResult, 'objective'>): ControlEvalResult {
  return { ...input, objective: false }
}

export function normalizeBudget(input: Partial<ControlBudget> | undefined): ControlBudget {
  const raw = { ...DEFAULT_BUDGET, ...input } as Record<string, unknown>
  if (!Number.isInteger(raw.maxSteps) || (raw.maxSteps as number) < 1) {
    throw new RangeError(
      `ControlRuntime budget.maxSteps must be an integer >= 1, got ${String(raw.maxSteps)}`,
    )
  }
  const budget: ControlBudget = { maxSteps: raw.maxSteps as number }
  if (raw.maxWallMs !== undefined) {
    if (
      typeof raw.maxWallMs !== 'number' ||
      !Number.isFinite(raw.maxWallMs) ||
      raw.maxWallMs <= 0
    ) {
      throw new RangeError(
        `ControlRuntime budget.maxWallMs must be a positive finite number, got ${String(raw.maxWallMs)}`,
      )
    }
    budget.maxWallMs = raw.maxWallMs
  }
  if (raw.maxCostUsd !== undefined) {
    if (
      typeof raw.maxCostUsd !== 'number' ||
      !Number.isFinite(raw.maxCostUsd) ||
      raw.maxCostUsd < 0
    ) {
      throw new RangeError(
        `ControlRuntime budget.maxCostUsd must be a nonnegative finite number, got ${String(raw.maxCostUsd)}`,
      )
    }
    budget.maxCostUsd = raw.maxCostUsd
  }
  return budget
}

export function normalizeActionCostUsd(
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

export function allCriticalPassed(evals: ControlEvalResult[]): boolean {
  return evals.every(
    (result) => result.passed || (result.severity !== 'critical' && result.severity !== 'error'),
  )
}

export function defaultStopDecision(evals: ControlEvalResult[]): StopDecision {
  if (!evals.length) return { stop: false, pass: false, reason: 'no evals yet' }
  const pass = allCriticalPassed(evals)
  return pass
    ? { stop: true, pass: true, reason: 'all critical evals passed', score: averageScore(evals) }
    : {
        stop: false,
        pass: false,
        reason: 'critical evals still failing',
        score: averageScore(evals),
      }
}

export function averageScore(evals: ControlEvalResult[]): number | undefined {
  const scored = evals
    .map((result) => result.score)
    .filter((score): score is number => typeof score === 'number')
  if (!scored.length) return undefined
  return Math.round(mean(scored) * 1000) / 1000
}

export function budgetStopDecision(
  budget: ControlBudget,
  spentCostUsd: number,
): { stop: boolean; reason: string } {
  if (budget.maxCostUsd !== undefined && spentCostUsd >= budget.maxCostUsd) {
    return {
      stop: true,
      reason: `budget exhausted: maxCostUsd=${budget.maxCostUsd}`,
    }
  }
  return { stop: false, reason: '' }
}
