/**
 * AnalystRegistry — orchestrate N analysts against one run.
 *
 * Owns three responsibilities and only three:
 *   1. Registration — ids must be unique; bad registrations fail loudly
 *      at register-time, not run-time.
 *   2. Routing — each analyst declares its `inputKind`; the registry
 *      picks the matching field from AnalystRunInputs and skips the
 *      analyst with a logged reason if it's missing.
 *   3. Isolation — one analyst's exception MUST NOT stop other analysts.
 *      Failed analysts produce zero findings + a 'failed' summary row.
 *
 * Cross-cutting concerns (telemetry, error → finding conversion, cost
 * ingestion, storage rotation) live in `AnalystHooks`. Budget shaping
 * (equal split vs weighted vs custom) lives in `BudgetPolicy`. Both
 * have sensible defaults; consumers override only what they need.
 */

import { randomUUID } from 'node:crypto'
import type { RunCostProvenance, RunTokenUsage } from '../run-record'
import type { ChatClient } from './chat-client'
import type {
  Analyst,
  AnalystContext,
  AnalystFinding,
  AnalystRunEvent,
  AnalystRunInputs,
  AnalystRunResult,
  AnalystRunSummary,
  AnalystUsageReceipt,
} from './types'

// ── Hook + policy surfaces ─────────────────────────────────────────

export interface AnalystHooks {
  /** Before analyze() — last chance to mutate ctx (e.g. inject tags, override budget). */
  onBeforeAnalyze?(args: {
    analyst: Analyst
    ctx: AnalystContext
    runId: string
  }): void | Promise<void>
  /** After every analyst (ok | failed | skipped). Use for telemetry, ingestion, rotation. */
  onAfterAnalyze?(args: {
    analyst: Analyst
    summary: AnalystRunSummary
    findings: AnalystFinding[]
    runId: string
  }): void | Promise<void>
  /**
   * On analyst exception. Hook MAY return findings to convert the
   * error into structured findings; the summary still reports 'failed'.
   * Return void to keep the default empty-findings behavior.
   */
  onError?(args: {
    analyst: Analyst
    error: Error
    runId: string
  }): AnalystFinding[] | undefined | Promise<AnalystFinding[] | undefined>
  /** Once after registry.run() completes. Use for final aggregation, persistence. */
  onComplete?(args: { result: AnalystRunResult }): void | Promise<void>
}

export interface BudgetPolicy {
  /** Overall USD cap across the registry.run(). */
  totalUsd?: number
  /** Per-analyst weight for the default allocator. Missing ids get weight 1. */
  weights?: Record<string, number>
  /**
   * Custom allocator — receives the analyst, remaining/total budget, and
   * the count of analysts that will run. Returns the per-analyst budget
   * (or undefined to leave it uncapped). Overrides weights when set.
   */
  allocate?: (args: {
    analyst: Analyst
    totalUsd: number | undefined
    remainingUsd: number | undefined
    runningCount: number
  }) => number | undefined
}

export interface AnalystRegistryOptions {
  /** Shared chat client passed to every LLM analyst via AnalystContext. */
  chat?: ChatClient
  /** Logger callback. Defaults to a no-op. */
  log?: (msg: string, fields?: Record<string, unknown>) => void
  /** Hooks invoked around analyze() — observability + customization seam. */
  hooks?: AnalystHooks
  /** Default budget when run() doesn't override. */
  defaultBudget?: BudgetPolicy
}

export interface RegistryRunOpts {
  /** Restrict to a subset of registered analysts by id. */
  only?: string[]
  /** Skip these analysts even if registered. Useful for cheap iteration. */
  skip?: string[]
  /** Budget policy — totalUsd + optional weights/allocator. Falls back to options.defaultBudget. */
  budget?: BudgetPolicy
  /** Wall-clock cap. Analysts SHOULD honor `ctx.deadlineMs`. */
  timeoutMs?: number
  /** Abort signal — forwarded into every analyst's context. */
  signal?: AbortSignal
  /** Tags echoed into AnalystContext.tags — useful for tracking environment/version in findings. */
  tags?: Record<string, string>
  /**
   * Prior-run findings made available as retrieval context to every
   * analyst via `ctx.priorFindings`. The registry forwards the slice
   * whose `analyst_id` matches each registered analyst so a kind sees
   * only its own history. Pass `{ '*': findings }` to broadcast to
   * every analyst (useful when several kinds share the same historical
   * context). For findings from this run, use `chainFindings` instead.
   */
  priorFindings?: ReadonlyArray<AnalystFinding> | Record<string, ReadonlyArray<AnalystFinding>>
  /**
   * Pass findings produced earlier in this registry run to each later analyst
   * via `ctx.upstreamFindings`. Registration order is dependency order.
   * Disabled by default because independent analyst suites must opt in.
   */
  chainFindings?: boolean
}

export class AnalystRegistry {
  private readonly analysts = new Map<string, Analyst>()
  private readonly options: AnalystRegistryOptions

  constructor(options: AnalystRegistryOptions = {}) {
    this.options = options
  }

  register(analyst: Analyst): void {
    if (!analyst.id) throw new Error('AnalystRegistry.register: analyst.id is required')
    if (this.analysts.has(analyst.id)) {
      throw new Error(`AnalystRegistry.register: duplicate analyst id "${analyst.id}"`)
    }
    if (!analyst.version) {
      throw new Error(`AnalystRegistry.register: analyst "${analyst.id}" must declare a version`)
    }
    this.analysts.set(analyst.id, analyst)
  }

  list(): ReadonlyArray<{
    id: string
    description: string
    version: string
    cost: Analyst['cost']
  }> {
    return Array.from(this.analysts.values()).map((a) => ({
      id: a.id,
      description: a.description,
      version: a.version,
      cost: a.cost,
    }))
  }

  async run(
    runId: string,
    inputs: AnalystRunInputs,
    runOpts: RegistryRunOpts = {},
  ): Promise<AnalystRunResult> {
    // Thin collector over `runStream`. Both surfaces share the same
    // loop body so they cannot drift on isolation / hook order / cost.
    for await (const ev of this.runStream(runId, inputs, runOpts)) {
      if (ev.type === 'run-completed') return ev.result
    }
    throw new Error('AnalystRegistry.run: stream completed without run-completed event')
  }

  /**
   * Streaming counterpart to `run()`. Emits `AnalystRunEvent` values
   * in real time — `run-started`, then per-analyst `skipped` /
   * `started` / `completed`, then a terminal `run-completed` whose
   * payload is the full `AnalystRunResult`. UIs use this to render
   * progress; persistence consumers use `run()` and read the result.
   *
   * Hooks (`onBeforeAnalyze` / `onAfterAnalyze` / `onError` /
   * `onComplete`) fire as before — streaming is additive, not a hook
   * replacement.
   */
  async *runStream(
    runId: string,
    inputs: AnalystRunInputs,
    runOpts: RegistryRunOpts = {},
  ): AsyncGenerator<AnalystRunEvent, void, void> {
    const correlationId = `ar_${randomUUID().slice(0, 12)}`
    const log = this.options.log ?? (() => {})
    const hooks = this.options.hooks ?? {}
    const startedAt = new Date().toISOString()
    const started = Date.now()
    const deadlineMs = runOpts.timeoutMs ? started + runOpts.timeoutMs : undefined

    const selected = this.selectAnalysts(runOpts)
    const budget = runOpts.budget ?? this.options.defaultBudget

    yield {
      type: 'run-started',
      run_id: runId,
      correlation_id: correlationId,
      started_at: startedAt,
      analyst_ids: selected.map((a) => a.id),
    }

    const summaries: AnalystRunSummary[] = []
    const allFindings: AnalystFinding[] = []
    let totalCost = 0
    let remainingUsd = budget?.totalUsd

    // Budget is split only across analysts that actually run. Analysts skipped
    // for missing input never spend, so counting them would under-budget the
    // ones that do. routeInput is pure, so the pre-count is safe.
    const runnableAnalysts = selected.filter((a) => this.routeInput(a, inputs).kind !== 'missing')
    const runnableCount = runnableAnalysts.length
    const weights = budget?.weights
    const totalWeight =
      weights && budget?.totalUsd != null && !budget.allocate && runnableCount > 0
        ? runnableAnalysts.reduce((sum, analyst) => sum + analystWeight(weights, analyst.id), 0)
        : undefined
    if (totalWeight === 0) {
      throw new Error('BudgetPolicy.weights must allocate positive weight to a runnable analyst')
    }

    for (const analyst of selected) {
      const t0 = Date.now()
      const input = this.routeInput(analyst, inputs)
      if (input.kind === 'missing') {
        const summary: AnalystRunSummary = {
          analyst_id: analyst.id,
          status: 'skipped',
          reason: `missing input of kind '${analyst.inputKind}'`,
          findings_count: 0,
          latency_ms: 0,
          cost_usd: 0,
          usage: zeroUsage(),
        }
        summaries.push(summary)
        log(`[analyst] skip ${analyst.id} — missing input`, { runId, kind: analyst.inputKind })
        await hooks.onAfterAnalyze?.({ analyst, summary, findings: [], runId })
        yield { type: 'analyst-skipped', summary }
        continue
      }

      const perBudget = allocateBudget(budget, {
        analyst,
        remainingUsd,
        runningCount: runnableCount,
        totalWeight,
      })
      const usageReceipts: AnalystUsageReceipt[] = []

      const ctx: AnalystContext = {
        runId,
        correlationId,
        deadlineMs,
        budgetUsd: perBudget,
        chat: this.options.chat,
        tags: runOpts.tags,
        log: (msg, fields) => log(`[${analyst.id}] ${msg}`, { runId, correlationId, ...fields }),
        signal: runOpts.signal,
        priorFindings: selectPriorFindings(runOpts.priorFindings, analyst.id),
        upstreamFindings:
          runOpts.chainFindings && allFindings.length > 0 ? [...allFindings] : undefined,
        recordUsage: (receipt) => {
          assertValidUsageReceipt(receipt)
          usageReceipts.push(receipt)
        },
      }

      await hooks.onBeforeAnalyze?.({ analyst, ctx, runId })
      yield {
        type: 'analyst-started',
        analyst_id: analyst.id,
        started_at: new Date(t0).toISOString(),
      }

      try {
        const findings = await (analyst as Analyst<unknown>).analyze(input.value, ctx)
        const latency = Date.now() - t0
        const usage = resolveUsage(analyst, findings, usageReceipts)
        const cost = knownCostUsd(usage)
        totalCost += cost
        if (typeof remainingUsd === 'number') remainingUsd = Math.max(0, remainingUsd - cost)
        allFindings.push(...findings)
        const summary: AnalystRunSummary = {
          analyst_id: analyst.id,
          status: 'ok',
          findings_count: findings.length,
          latency_ms: latency,
          cost_usd: cost,
          usage,
        }
        summaries.push(summary)
        log(`[analyst] ok ${analyst.id}`, {
          runId,
          findings: findings.length,
          latency_ms: latency,
          cost_usd: cost,
          cost_kind: usage.cost.kind,
          input_tokens: usage.tokens?.input ?? null,
          output_tokens: usage.tokens?.output ?? null,
        })
        if (perBudget !== undefined && usage.cost.kind === 'uncaptured') {
          log(`[analyst] WARN ${analyst.id} — USD cost uncaptured; budget not reconciled`, {
            runId,
            budget_usd: perBudget,
            cost_captured: false,
          })
        }
        await hooks.onAfterAnalyze?.({ analyst, summary, findings, runId })
        yield { type: 'analyst-completed', summary, findings }
      } catch (err) {
        const latency = Date.now() - t0
        const e = err instanceof Error ? err : new Error(String(err))
        // Hook gets first chance to convert the error into findings.
        const hookFindings = (await hooks.onError?.({ analyst, error: e, runId })) ?? []
        if (hookFindings.length) allFindings.push(...hookFindings)
        const usage = resolveUsage(analyst, hookFindings, usageReceipts)
        const cost = knownCostUsd(usage)
        totalCost += cost
        if (typeof remainingUsd === 'number') remainingUsd = Math.max(0, remainingUsd - cost)
        const summary: AnalystRunSummary = {
          analyst_id: analyst.id,
          status: 'failed',
          findings_count: hookFindings.length,
          latency_ms: latency,
          cost_usd: cost,
          usage,
          error: { class: e.constructor.name, message: e.message },
        }
        summaries.push(summary)
        log(`[analyst] FAIL ${analyst.id}`, {
          runId,
          error_class: e.constructor.name,
          error: e.message,
          cost_usd: cost,
          cost_kind: usage.cost.kind,
        })
        if (perBudget !== undefined && usage.cost.kind === 'uncaptured') {
          log(`[analyst] WARN ${analyst.id} — USD cost uncaptured; budget not reconciled`, {
            runId,
            budget_usd: perBudget,
            cost_captured: false,
          })
        }
        await hooks.onAfterAnalyze?.({ analyst, summary, findings: hookFindings, runId })
        yield { type: 'analyst-completed', summary, findings: hookFindings }
        // Continue — isolation invariant.
      }
    }

    const result: AnalystRunResult = {
      run_id: runId,
      correlation_id: correlationId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      findings: allFindings,
      per_analyst: summaries,
      total_cost_usd: totalCost,
      total_cost_provenance: aggregateCostProvenance(
        summaries.map((summary) => summary.usage?.cost ?? { kind: 'uncaptured', usd: null }),
      ),
    }
    await hooks.onComplete?.({ result })
    yield { type: 'run-completed', result }
  }

  private selectAnalysts(opts: RegistryRunOpts): Analyst[] {
    let candidates = Array.from(this.analysts.values())
    if (opts.only?.length) {
      const only = new Set(opts.only)
      candidates = candidates.filter((a) => only.has(a.id))
    }
    if (opts.skip?.length) {
      const skip = new Set(opts.skip)
      candidates = candidates.filter((a) => !skip.has(a.id))
    }
    return candidates
  }

  private routeInput(
    analyst: Analyst,
    inputs: AnalystRunInputs,
  ): { kind: 'present'; value: unknown } | { kind: 'missing' } {
    switch (analyst.inputKind) {
      case 'trace-store':
        return inputs.traceStore
          ? { kind: 'present', value: inputs.traceStore }
          : { kind: 'missing' }
      case 'artifact-dir':
        return inputs.artifactDir
          ? { kind: 'present', value: inputs.artifactDir }
          : { kind: 'missing' }
      case 'run-record':
        return inputs.runRecord ? { kind: 'present', value: inputs.runRecord } : { kind: 'missing' }
      case 'judge-input':
        return inputs.judgeInput
          ? { kind: 'present', value: inputs.judgeInput }
          : { kind: 'missing' }
      case 'custom': {
        const v = inputs.custom?.[analyst.id]
        return v !== undefined ? { kind: 'present', value: v } : { kind: 'missing' }
      }
    }
  }
}

/**
 * Default budget allocator: prefer the custom `allocate` callback if
 * provided; else weighted split when weights are set; else equal split
 * across `runningCount`. Returns undefined when no totalUsd is known.
 */
function allocateBudget(
  policy: BudgetPolicy | undefined,
  args: {
    analyst: Analyst
    remainingUsd: number | undefined
    runningCount: number
    totalWeight: number | undefined
  },
): number | undefined {
  if (!policy) return undefined
  if (policy.allocate) {
    return policy.allocate({
      analyst: args.analyst,
      totalUsd: policy.totalUsd,
      remainingUsd: args.remainingUsd,
      runningCount: args.runningCount,
    })
  }
  if (policy.totalUsd == null) return undefined
  if (policy.weights) {
    return (policy.totalUsd * analystWeight(policy.weights, args.analyst.id)) / args.totalWeight!
  }
  return policy.totalUsd / Math.max(1, args.runningCount)
}

function analystWeight(weights: Record<string, number>, analystId: string): number {
  const weight = weights[analystId] ?? 1
  if (!Number.isFinite(weight) || weight < 0) {
    throw new Error(`BudgetPolicy.weights['${analystId}'] must be a non-negative finite number`)
  }
  return weight
}

function zeroUsage(): AnalystUsageReceipt {
  return {
    calls: 0,
    tokens: { input: 0, output: 0 },
    cost: { kind: 'observed', usd: 0 },
  }
}

/**
 * Prefer receipts reported independently of findings. Legacy analysts that
 * annotate `metadata.cost_usd` retain their existing accounting, while an LLM
 * analyst with neither source is explicitly uncaptured rather than observed $0.
 */
function resolveUsage(
  analyst: Analyst,
  findings: AnalystFinding[],
  receipts: ReadonlyArray<AnalystUsageReceipt>,
): AnalystUsageReceipt {
  const legacyCost = sumFindingCost(findings)
  if (receipts.length > 0) {
    const merged = mergeUsageReceipts(receipts)
    return merged.cost.kind === 'uncaptured' && legacyCost.captured
      ? { ...merged, knownCostUsd: Math.max(merged.knownCostUsd ?? 0, legacyCost.usd) }
      : merged
  }

  if (legacyCost.captured) {
    return {
      calls: null,
      tokens: null,
      cost: { kind: 'observed', usd: legacyCost.usd },
    }
  }
  if (analyst.cost.kind === 'deterministic') return zeroUsage()
  return { calls: null, tokens: null, cost: { kind: 'uncaptured', usd: null } }
}

function mergeUsageReceipts(receipts: ReadonlyArray<AnalystUsageReceipt>): AnalystUsageReceipt {
  const calls = receipts.every((receipt) => receipt.calls !== null)
    ? receipts.reduce((sum, receipt) => sum + (receipt.calls ?? 0), 0)
    : null
  const tokens = receipts.every((receipt) => receipt.tokens !== null)
    ? receipts.reduce<RunTokenUsage>(
        (sum, receipt) => ({
          input: sum.input + (receipt.tokens?.input ?? 0),
          output: sum.output + (receipt.tokens?.output ?? 0),
          ...(sum.cached !== undefined || receipt.tokens?.cached !== undefined
            ? { cached: (sum.cached ?? 0) + (receipt.tokens?.cached ?? 0) }
            : {}),
        }),
        { input: 0, output: 0 },
      )
    : null
  const cost = aggregateCostProvenance(receipts.map((receipt) => receipt.cost))
  return {
    calls,
    tokens,
    cost,
    ...(cost.kind === 'uncaptured'
      ? {
          knownCostUsd: receipts.reduce((sum, receipt) => sum + knownCostUsd(receipt), 0),
        }
      : {}),
  }
}

function knownCostUsd(receipt: AnalystUsageReceipt): number {
  return receipt.cost.kind === 'uncaptured' ? (receipt.knownCostUsd ?? 0) : receipt.cost.usd
}

function aggregateCostProvenance(costs: ReadonlyArray<RunCostProvenance>): RunCostProvenance {
  if (costs.some((cost) => cost.kind === 'uncaptured')) {
    return { kind: 'uncaptured', usd: null }
  }
  const usd = costs.reduce((sum, cost) => sum + (cost.usd ?? 0), 0)
  return costs.some((cost) => cost.kind === 'estimated')
    ? { kind: 'estimated', usd }
    : { kind: 'observed', usd }
}

function assertValidUsageReceipt(receipt: AnalystUsageReceipt): void {
  if (receipt.calls !== null && (!Number.isInteger(receipt.calls) || receipt.calls < 0)) {
    throw new Error('AnalystContext.recordUsage: calls must be a non-negative integer or null')
  }
  if (receipt.tokens) {
    assertNonNegativeFinite(receipt.tokens.input, 'tokens.input')
    assertNonNegativeFinite(receipt.tokens.output, 'tokens.output')
    if (receipt.tokens.cached !== undefined) {
      assertNonNegativeFinite(receipt.tokens.cached, 'tokens.cached')
    }
  }
  if (receipt.cost.kind !== 'uncaptured') {
    assertNonNegativeFinite(receipt.cost.usd, 'cost.usd')
  } else if (receipt.cost.usd !== null) {
    throw new Error('AnalystContext.recordUsage: uncaptured cost.usd must be null')
  }
  if (receipt.knownCostUsd !== undefined) {
    assertNonNegativeFinite(receipt.knownCostUsd, 'knownCostUsd')
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`AnalystContext.recordUsage: ${field} must be a non-negative finite number`)
  }
}

/**
 * Findings may carry their cost in `metadata.cost_usd` when the analyst
 * tracks it (the LLM-driven adapters do this — they sum chat-client
 * responses). Deterministic findings have no cost field.
 */
function sumFindingCost(findings: AnalystFinding[]): { usd: number; captured: boolean } {
  let sum = 0
  let captured = false
  for (const f of findings) {
    const c = f.metadata?.cost_usd
    if (typeof c === 'number' && Number.isFinite(c)) {
      sum += c
      captured = true
    }
  }
  return { usd: sum, captured }
}

/**
 * Resolve the `priorFindings` slice an analyst sees.
 *
 *   - Array form  → the analyst sees only findings whose `analyst_id`
 *                   matches its own id, so a kind never reads
 *                   another kind's history by accident.
 *   - Record form → the analyst gets the entry keyed by its id, with
 *                   the `'*'` wildcard appended (in that order). Use
 *                   the wildcard when several kinds should see the same
 *                   historical findings.
 */
function selectPriorFindings(
  source: RegistryRunOpts['priorFindings'],
  analystId: string,
): ReadonlyArray<AnalystFinding> | undefined {
  if (!source) return undefined
  if (Array.isArray(source)) {
    const own = source.filter((f) => f.analyst_id === analystId)
    return own.length > 0 ? own : undefined
  }
  const record = source as Record<string, ReadonlyArray<AnalystFinding>>
  const own = record[analystId] ?? []
  const wildcard = record['*'] ?? []
  const merged = [...own, ...wildcard]
  return merged.length > 0 ? merged : undefined
}
