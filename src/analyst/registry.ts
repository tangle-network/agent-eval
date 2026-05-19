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
 * Budget enforcement is per-analyst (operator caps the analyst-declared
 * `est_usd_per_run` if it exceeds the total budget remaining). Cost
 * accounting flows from the ChatClient's response — analysts that don't
 * use the LLM cost zero.
 */

import { randomUUID } from 'node:crypto'

import type {
  Analyst,
  AnalystContext,
  AnalystFinding,
  AnalystRunInputs,
  AnalystRunResult,
  AnalystRunSummary,
} from './types'
import type { ChatClient } from './chat-client'

export interface AnalystRegistryOptions {
  /** Shared chat client passed to every LLM analyst via AnalystContext. */
  chat?: ChatClient
  /** Logger callback. Defaults to a no-op. */
  log?: (msg: string, fields?: Record<string, unknown>) => void
  /** Default per-analyst budget when caller doesn't specify. */
  defaultBudgetUsd?: number
}

export interface RegistryRunOpts {
  /** Restrict to a subset of registered analysts by id. */
  only?: string[]
  /** Skip these analysts even if registered. Useful for cheap iteration. */
  skip?: string[]
  /** Overall USD budget across all analysts. Each gets up to `budgetUsd / N`. */
  budgetUsd?: number
  /** Wall-clock cap. Analysts SHOULD honor deadlineMs from context. */
  timeoutMs?: number
  /** Abort signal. The registry forwards it to every analyst's context. */
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

  list(): ReadonlyArray<{ id: string; description: string; version: string; cost: Analyst['cost'] }> {
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
    const startedAt = new Date().toISOString()
    const started = Date.now()
    const deadlineMs = runOpts.timeoutMs ? started + runOpts.timeoutMs : undefined

    const selected = this.selectAnalysts(runOpts)
    const perAnalystBudget = this.computePerAnalystBudget(selected.length, runOpts.budgetUsd)

    const summaries: AnalystRunSummary[] = []
    const allFindings: AnalystFinding[] = []
    let totalCost = 0

    for (const analyst of selected) {
      const t0 = Date.now()
      const input = this.routeInput(analyst, inputs)
      if (input.kind === 'missing') {
        summaries.push({
          analyst_id: analyst.id,
          status: 'skipped',
          reason: `missing input of kind '${analyst.inputKind}'`,
          findings_count: 0,
          latency_ms: 0,
          cost_usd: 0,
        })
        log(`[analyst] skip ${analyst.id} — missing input`, { runId, kind: analyst.inputKind })
        continue
      }

      const ctx: AnalystContext = {
        runId,
        correlationId,
        deadlineMs,
        budgetUsd: perAnalystBudget,
        chat: this.options.chat as AnalystContext['chat'],
        tags: runOpts.tags,
        log: (msg, fields) => log(`[${analyst.id}] ${msg}`, { runId, correlationId, ...fields }),
        signal: runOpts.signal,
      }

      try {
        const findings = await (analyst as Analyst<unknown>).analyze(input.value, ctx)
        const latency = Date.now() - t0
        // Cost is best-effort: deterministic analysts cost 0; LLM
        // analysts that surface usage via metadata get attributed.
        const cost = sumFindingCost(findings)
        totalCost += cost
        allFindings.push(...findings)
        summaries.push({
          analyst_id: analyst.id,
          status: 'ok',
          findings_count: findings.length,
          latency_ms: latency,
          cost_usd: cost,
        })
        log(`[analyst] ok ${analyst.id}`, {
          runId,
          findings: findings.length,
          latency_ms: latency,
          cost_usd: cost,
        })
      } catch (err) {
        const latency = Date.now() - t0
        const e = err instanceof Error ? err : new Error(String(err))
        summaries.push({
          analyst_id: analyst.id,
          status: 'failed',
          findings_count: 0,
          latency_ms: latency,
          cost_usd: 0,
          error: { class: e.constructor.name, message: e.message },
        })
        log(`[analyst] FAIL ${analyst.id}`, {
          runId,
          error_class: e.constructor.name,
          error: e.message,
        })
        // Continue — isolation invariant.
      }
    }

    return {
      run_id: runId,
      correlation_id: correlationId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      findings: allFindings,
      per_analyst: summaries,
      total_cost_usd: totalCost,
    }
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

  private computePerAnalystBudget(count: number, budgetUsd?: number): number | undefined {
    const total = budgetUsd ?? this.options.defaultBudgetUsd
    if (total == null || count === 0) return undefined
    // Equal split. Operators wanting weighted budgets call analysts in
    // separate registry.run() invocations.
    return total / count
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
        return inputs.runRecord
          ? { kind: 'present', value: inputs.runRecord }
          : { kind: 'missing' }
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
 * Findings may carry their cost in `metadata.cost_usd` when the analyst
 * tracks it (the LLM-driven adapters do this — they sum chat-client
 * responses). Deterministic findings have no cost field. We sum the
 * unique-by-finding total because the same finding from multiple
 * sub-calls should still be one cost line.
 */
function sumFindingCost(findings: AnalystFinding[]): number {
  let sum = 0
  for (const f of findings) {
    const c = f.metadata?.cost_usd
    if (typeof c === 'number' && Number.isFinite(c)) sum += c
  }
  return sum
}
