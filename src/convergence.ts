import type { CompletionCriterion, DriverState } from './types'

/**
 * ConvergenceTracker — tracks completion percentage over turns.
 *
 * Produces convergence curves showing how quickly the agent reaches
 * completion criteria.
 */
export class ConvergenceTracker {
  private criteria: CompletionCriterion[]
  private history: {
    turn: number
    completionPercent: number
    criteriaStatus: Record<string, boolean | number>
  }[] = []

  constructor(criteria: CompletionCriterion[]) {
    this.criteria = criteria
  }

  /** Evaluate criteria against current state, record result */
  record(
    turn: number,
    state: DriverState,
  ): {
    completionPercent: number
    complete: boolean
    criteriaStatus: Record<string, boolean | number>
  } {
    const criteriaStatus: Record<string, boolean | number> = {}
    let totalCredit = 0

    for (const criterion of this.criteria) {
      if (criterion.progress) {
        const credit = Math.min(1, Math.max(0, criterion.progress(state)))
        criteriaStatus[criterion.name] = credit
        totalCredit += credit
      } else {
        const passed = criterion.check(state)
        criteriaStatus[criterion.name] = passed
        totalCredit += passed ? 1 : 0
      }
    }

    const completionPercent =
      this.criteria.length > 0 ? (totalCredit / this.criteria.length) * 100 : 100

    this.history.push({ turn, completionPercent, criteriaStatus })

    return {
      completionPercent,
      complete: totalCredit >= this.criteria.length,
      criteriaStatus,
    }
  }

  /** Get convergence curve */
  getCurve(): number[] {
    return this.history.map((h) => h.completionPercent)
  }

  /** Get full history with per-criterion status */
  getHistory() {
    return [...this.history]
  }

  /** Find the turn where completion first reached 100% (or null) */
  getTurnToCompletion(): number | null {
    const entry = this.history.find((h) => h.completionPercent === 100)
    return entry?.turn ?? null
  }
}
