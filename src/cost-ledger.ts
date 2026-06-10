/**
 * CostLedger — per-run token + USD accounting with an explicit `costUnknown`
 * axis, folded over the substrate's pricing resolver.
 *
 * `estimateCost` already resolves a model id to a price (exact table, then
 * family regex) and warns-once on a miss, but it returns 0 for an unpriced
 * model — indistinguishable downstream from a genuinely free run. Four
 * consumers re-wrap it to surface that distinction (physim's `costForUsage` /
 * `modelPriceKey` is the cleanest), and to bucket spend by "channel" (the
 * logical role of the call: agent / judge / verifier / …) so a dashboard can
 * answer "how much did judging cost vs the agent itself?".
 *
 * This is the canonical version. `modelPriceKey` exposes the resolver's verdict
 * as a stable key (or null). `CostLedger` folds usage records into per-channel
 * and total rollups, tracks `unpricedModels` so a $0 is never mistaken for a
 * measured zero, and computes cost-per-completed-task.
 */

import { ValidationError } from './errors'
import { estimateCost, isModelPriced, resolveModelPricing } from './metrics'

/** Logical role of an LLM call. Free-form union — consumers add their own
 *  channels; the rollup keys on whatever string is supplied. */
export type CostChannel = 'agent' | 'judge' | 'verifier' | 'analyst' | 'driver' | (string & {})

export interface CostUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
}

/**
 * Resolve a model id to the stable pricing key the substrate's `MODEL_PRICING`
 * / family resolver would use, or null when the id is unpriced. A non-null
 * return means `estimateCost` will produce a real number for this id; null
 * means any cost computed is `costUnknown` and the 0 must not aggregate as a
 * measured cost.
 */
export function modelPriceKey(model: string): string | null {
  return isModelPriced(model) ? model : null
}

export interface CostResult {
  costUsd: number
  /** True when `model` has no pricing — the 0 is "not priced", NOT "free". */
  costUnknown: boolean
}

/**
 * Cost for one usage record. Resolves pricing via the substrate resolver and
 * flags `costUnknown` when the model is unpriced so the 0 is observable rather
 * than silently emitted as a measured cost. Cached tokens are billed at the
 * model's input rate when present (no separate cache-discount table — callers
 * that need provider-specific cache pricing supply `actualCostUsd` upstream).
 */
export function costForUsage(model: string, usage: CostUsage): CostResult {
  assertNonNegative(usage.inputTokens, 'inputTokens')
  assertNonNegative(usage.outputTokens, 'outputTokens')
  if (usage.cachedTokens !== undefined) assertNonNegative(usage.cachedTokens, 'cachedTokens')
  const pricing = resolveModelPricing(model)
  if (!pricing) return { costUsd: 0, costUnknown: true }
  const billedInput = usage.inputTokens + (usage.cachedTokens ?? 0)
  return { costUsd: estimateCost(billedInput, usage.outputTokens, model), costUnknown: false }
}

export interface CostLedgerEntry extends CostUsage {
  model: string
  channel: CostChannel
  costUsd: number
  costUnknown: boolean
  /** Override the estimate with an observed provider cost. */
  actualCostUsd?: number
  /** Free-form tags (scenario id, variant id, round, …). */
  tags?: Record<string, string>
  timestamp: number
}

export interface ChannelRollup {
  channel: CostChannel
  calls: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUsd: number
  /** Calls whose model was unpriced (their costUsd is 0-but-unknown). */
  unpricedCalls: number
}

export interface CostLedgerSummary {
  totalCalls: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalCostUsd: number
  /** Per-channel breakdown, sorted by channel name. */
  byChannel: ChannelRollup[]
  /** Distinct unpriced model ids seen — non-empty means totalCostUsd is a
   *  lower bound (some calls priced to an unknown 0). */
  unpricedModels: string[]
  /** True when no unpriced model was charged — totalCostUsd is then exact. */
  fullyPriced: boolean
}

/**
 * Append-only ledger of LLM spend for a single run. Record each call with its
 * channel; read per-channel and total rollups plus the unpriced-model set.
 * Pure accounting — no I/O. The `markCompleted` / `costPerCompletedTask` pair
 * answers "dollars per finished task", the metric every optimizer's
 * quality-vs-cost tradeoff needs.
 */
export class CostLedger {
  private readonly entries: CostLedgerEntry[] = []
  private completedTasks = 0

  /**
   * Record one LLM call. The cost is computed from pricing unless
   * `actualCostUsd` is supplied (a finite observed cost from the provider
   * response), in which case `costUnknown` is false regardless of pricing.
   */
  record(input: {
    model: string
    channel: CostChannel
    usage: CostUsage
    actualCostUsd?: number
    tags?: Record<string, string>
    timestamp?: number
  }): CostLedgerEntry {
    const { costUsd, costUnknown } = costForUsage(input.model, input.usage)
    const hasActual =
      typeof input.actualCostUsd === 'number' && Number.isFinite(input.actualCostUsd)
    if (hasActual) assertNonNegative(input.actualCostUsd as number, 'actualCostUsd')
    const entry: CostLedgerEntry = {
      model: input.model,
      channel: input.channel,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cachedTokens: input.usage.cachedTokens,
      costUsd: hasActual ? (input.actualCostUsd as number) : costUsd,
      costUnknown: hasActual ? false : costUnknown,
      actualCostUsd: hasActual ? (input.actualCostUsd as number) : undefined,
      tags: input.tags,
      timestamp: input.timestamp ?? Date.now(),
    }
    this.entries.push(entry)
    return entry
  }

  /** Increment the completed-task counter (used for cost-per-completed-task). */
  markCompleted(count = 1): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new ValidationError(
        `CostLedger.markCompleted: count must be a non-negative integer, got ${count}`,
      )
    }
    this.completedTasks += count
  }

  list(): CostLedgerEntry[] {
    return [...this.entries]
  }

  summary(): CostLedgerSummary {
    const byChannel = new Map<string, ChannelRollup>()
    const unpriced = new Set<string>()
    let totalCost = 0
    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens = 0
    for (const e of this.entries) {
      totalCost += e.costUsd
      inputTokens += e.inputTokens
      outputTokens += e.outputTokens
      cachedTokens += e.cachedTokens ?? 0
      if (e.costUnknown) unpriced.add(e.model)
      const roll = byChannel.get(e.channel) ?? {
        channel: e.channel,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
      }
      roll.calls += 1
      roll.inputTokens += e.inputTokens
      roll.outputTokens += e.outputTokens
      roll.cachedTokens += e.cachedTokens ?? 0
      roll.costUsd += e.costUsd
      if (e.costUnknown) roll.unpricedCalls += 1
      byChannel.set(e.channel, roll)
    }
    return {
      totalCalls: this.entries.length,
      inputTokens,
      outputTokens,
      cachedTokens,
      totalCostUsd: totalCost,
      byChannel: [...byChannel.values()].sort((a, b) => a.channel.localeCompare(b.channel)),
      unpricedModels: [...unpriced].sort(),
      fullyPriced: unpriced.size === 0,
    }
  }

  /** Total spend divided by completed tasks; null when nothing completed. */
  costPerCompletedTask(): number | null {
    if (this.completedTasks === 0) return null
    return this.summary().totalCostUsd / this.completedTasks
  }
}

function assertNonNegative(n: number, name: string): void {
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(`CostLedger: ${name} must be a non-negative finite number, got ${n}`)
  }
}
