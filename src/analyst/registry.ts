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
import type { ChatClient } from './chat-client'
import type {
  Analyst,
  AnalystContext,
  AnalystFinding,
  AnalystRunInputs,
  AnalystRunResult,
  AnalystRunSummary,
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
  }): AnalystFinding[] | void | Promise<AnalystFinding[] | void>
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
    const correlationId = `ar_${randomUUID().slice(0, 12)}`
    const log = this.options.log ?? (() => {})
    const hooks = this.options.hooks ?? {}
    const startedAt = new Date().toISOString()
    const started = Date.now()
    const deadlineMs = runOpts.timeoutMs ? started + runOpts.timeoutMs : undefined

    const selected = this.selectAnalysts(runOpts)
    const budget = runOpts.budget ?? this.options.defaultBudget

    const summaries: AnalystRunSummary[] = []
    const allFindings: AnalystFinding[] = []
    let totalCost = 0
    let remainingUsd = budget?.totalUsd

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
        }
        summaries.push(summary)
        log(`[analyst] skip ${analyst.id} — missing input`, { runId, kind: analyst.inputKind })
        await hooks.onAfterAnalyze?.({ analyst, summary, findings: [], runId })
        continue
      }

      const perBudget = allocateBudget(budget, {
        analyst,
        remainingUsd,
        runningCount: selected.length,
      })

      const ctx: AnalystContext = {
        runId,
        correlationId,
        deadlineMs,
        budgetUsd: perBudget,
        chat: this.options.chat,
        tags: runOpts.tags,
        log: (msg, fields) => log(`[${analyst.id}] ${msg}`, { runId, correlationId, ...fields }),
        signal: runOpts.signal,
      }

      await hooks.onBeforeAnalyze?.({ analyst, ctx, runId })

      try {
        const findings = await (analyst as Analyst<unknown>).analyze(input.value, ctx)
        const latency = Date.now() - t0
        const cost = sumFindingCost(findings)
        totalCost += cost
        if (typeof remainingUsd === 'number') remainingUsd = Math.max(0, remainingUsd - cost)
        allFindings.push(...findings)
        const summary: AnalystRunSummary = {
          analyst_id: analyst.id,
          status: 'ok',
          findings_count: findings.length,
          latency_ms: latency,
          cost_usd: cost,
        }
        summaries.push(summary)
        log(`[analyst] ok ${analyst.id}`, {
          runId,
          findings: findings.length,
          latency_ms: latency,
          cost_usd: cost,
        })
        await hooks.onAfterAnalyze?.({ analyst, summary, findings, runId })
      } catch (err) {
        const latency = Date.now() - t0
        const e = err instanceof Error ? err : new Error(String(err))
        // Hook gets first chance to convert the error into findings.
        const hookFindings = (await hooks.onError?.({ analyst, error: e, runId })) ?? []
        if (hookFindings.length) allFindings.push(...hookFindings)
        const summary: AnalystRunSummary = {
          analyst_id: analyst.id,
          status: 'failed',
          findings_count: hookFindings.length,
          latency_ms: latency,
          cost_usd: 0,
          error: { class: e.constructor.name, message: e.message },
        }
        summaries.push(summary)
        log(`[analyst] FAIL ${analyst.id}`, {
          runId,
          error_class: e.constructor.name,
          error: e.message,
        })
        await hooks.onAfterAnalyze?.({ analyst, summary, findings: hookFindings, runId })
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
    }
    await hooks.onComplete?.({ result })
    return result
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
  args: { analyst: Analyst; remainingUsd: number | undefined; runningCount: number },
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
    // Weighted split: caller-supplied weights, default 1 for missing ids.
    // We can only normalize against the analysts in this run, but the
    // registry doesn't know all ids at allocator-time without passing
    // them. We approximate by treating `runningCount` as the count of
    // weight=1 analysts when the weight map omits ids. The exact split
    // is left to consumers that need precision via `allocate`.
    const w = policy.weights[args.analyst.id] ?? 1
    const totalWeight = Math.max(1, args.runningCount) // see note above
    return (policy.totalUsd * w) / totalWeight
  }
  return policy.totalUsd / Math.max(1, args.runningCount)
}

/**
 * Findings may carry their cost in `metadata.cost_usd` when the analyst
 * tracks it (the LLM-driven adapters do this — they sum chat-client
 * responses). Deterministic findings have no cost field.
 */
function sumFindingCost(findings: AnalystFinding[]): number {
  let sum = 0
  for (const f of findings) {
    const c = f.metadata?.cost_usd
    if (typeof c === 'number' && Number.isFinite(c)) sum += c
  }
  return sum
}
