/**
 * BudgetGuard — enforces token / wall-clock / call / $ caps, records
 * a ledger entry on every decrement, emits `budget_breach` + throws
 * `BudgetBreachError` when a cap is hit.
 *
 * Wraps a TraceEmitter. The emitter persists ledger entries + breach
 * events so the classifier, pipelines, and reports can all read
 * budget state from the trace corpus — no separate accounting.
 */

import type { TraceEmitter } from './trace/emitter'
import type { BudgetSpec } from './trace/schema'

export class BudgetBreachError extends Error {
  constructor(
    public dimension: keyof BudgetSpec,
    public limit: number,
    public attempted: number,
  ) {
    super(`budget breach on ${dimension}: attempted ${attempted} vs limit ${limit}`)
    this.name = 'BudgetBreachError'
  }
}

export class BudgetGuard {
  private consumed: Record<keyof BudgetSpec, number> = { tokens: 0, wallMs: 0, calls: 0, usd: 0 }
  private emitter: TraceEmitter
  private budget: BudgetSpec
  private startedAt: number

  constructor(emitter: TraceEmitter, budget: BudgetSpec, now: () => number = () => Date.now()) {
    this.emitter = emitter
    this.budget = budget
    this.startedAt = now()
  }

  /** Record consumption. Throws `BudgetBreachError` if any dimension exceeds its cap. */
  async charge(delta: Partial<Record<keyof BudgetSpec, number>>, spanId?: string): Promise<void> {
    for (const [dim, value] of Object.entries(delta) as Array<[keyof BudgetSpec, number]>) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`BudgetGuard.charge: non-finite or negative ${dim}=${value}`)
      }
      this.consumed[dim] += value
      const limit = this.budget[dim]
      const consumed = this.consumed[dim]
      const remaining = limit === undefined ? Infinity : limit - consumed
      const breached = limit !== undefined && consumed > limit
      if (limit !== undefined) {
        await this.emitter.recordBudget({
          dimension: dim,
          limit,
          consumed,
          remaining,
          breached,
          spanId,
        })
      }
      if (breached) {
        throw new BudgetBreachError(dim, limit!, consumed)
      }
    }
  }

  /** Convenience: advance wall-clock budget based on elapsed wall time. */
  async tickWall(nowMs: number, spanId?: string): Promise<void> {
    const elapsed = nowMs - this.startedAt
    const already = this.consumed.wallMs
    const delta = Math.max(0, elapsed - already)
    if (delta > 0) await this.charge({ wallMs: delta }, spanId)
  }

  get state(): Record<keyof BudgetSpec, number> {
    return { ...this.consumed }
  }
}
