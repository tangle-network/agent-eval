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
import { z } from 'zod'
import { combineAbortSignals } from '../abort-signal'
import type { CostLedgerHandle } from '../cost-ledger'
import {
  snapshotAnalystFindings,
  snapshotExactAnalystRunReceipt,
} from '../feedback-trajectory-review'
import { canonicalString, deepFreezeCanonicalJson, hashCanonical } from '../ledger-core/canonical'
import type { RunCostProvenance, RunTokenUsage } from '../run-record'
import type { ChatClient } from './chat-client'
import type {
  ExactAnalystExecutionPlanSnapshot,
  ExactAnalystRunEvent,
  ExactAnalystRunResult,
  ExactCapableAnalyst,
  ExactExecutionComponentIdentity,
  ExactExecutionComponentSnapshot,
} from './exact-types'
import { snapshotExactExecutionComponentIdentity, snapshotExactExecutionPlan } from './exact-types'
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
import { assertValidAnalystUsageReceipt, validateUsageSettlementTimeout } from './usage-receipt'

// ── Hook + policy surfaces ─────────────────────────────────────────

export interface AnalystHooks {
  /** Legacy runs may mutate ctx; exact runs provide a frozen observational context. */
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
   * (or undefined only when the run has no overall cap). Overrides weights
   * when set.
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
  /** Required identity/config when `runExact` applies `hooks`. */
  hooksIdentity?: ExactExecutionComponentIdentity
  /** Default budget when run() doesn't override. */
  defaultBudget?: BudgetPolicy
  /** Required identity/config when `runExact` provides `chat`. */
  chatIdentity?: ExactExecutionComponentIdentity
}

export interface RegistryRunOpts {
  /** Restrict to a subset of registered analysts by id. */
  only?: string[]
  /** Skip these analysts even if registered. Useful for cheap iteration. */
  skip?: string[]
  /** Budget policy — totalUsd + optional weights/allocator. Falls back to options.defaultBudget. */
  budget?: BudgetPolicy
  /** Active-work cap for the complete registry run. Model receipt settlement may follow. */
  timeoutMs?: number
  /** Abort signal — forwarded into every analyst's context. */
  signal?: AbortSignal
  /** Shared paid-call account forwarded to every analyst. */
  costLedger?: CostLedgerHandle
  /** Attribution phase for calls written to `costLedger`. */
  costPhase?: string
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

/** A caller-selected allocation rule for an exact analyst run. */
export type ExactAnalystBudgetPolicy =
  | {
      readonly kind: 'equal'
      readonly totalUsd: number
    }
  | {
      readonly kind: 'weighted'
      readonly totalUsd: number
      /** One explicit weight for every selected analyst id. */
      readonly weights: Readonly<Record<string, number>>
    }

/**
 * Complete per-run analyst policy.
 *
 * Every field is required. `null` explicitly disables an optional resource or context channel.
 * `analystIds` is execution order; it is not filtered through registry insertion order.
 * Missing-input behavior is explicit so callers cannot accidentally inherit it by omission.
 * Exact runs are serial; more elaborate scheduling belongs in the caller's runtime.
 */
export interface ExactRegistryRunOpts {
  readonly analystIds: readonly string[]
  readonly budget: ExactAnalystBudgetPolicy | null
  readonly totalTimeoutMs: number | null
  readonly signal: AbortSignal | null
  readonly costLedger: CostLedgerHandle | null
  readonly costLedgerIdentity: ExactExecutionComponentIdentity | null
  readonly costPhase: string | null
  readonly tags: Readonly<Record<string, string>> | null
  readonly priorFindings:
    | ReadonlyArray<AnalystFinding>
    | Readonly<Record<string, ReadonlyArray<AnalystFinding>>>
    | null
  readonly chainFindings: boolean
  readonly missingInputMode: 'skip' | 'abort'
  readonly applyRegistryHooks: boolean
  readonly useRegistryChat: boolean
}

type NormalizedBudgetPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'dynamic'; readonly policy: BudgetPolicy }

interface PreparedAnalyst {
  readonly analyst: Analyst
  readonly input:
    | { readonly kind: 'present'; readonly value: unknown }
    | { readonly kind: 'missing' }
}

interface AnalystExecutionPlan {
  readonly runId: string
  readonly prepared: readonly PreparedAnalyst[]
  readonly budget: NormalizedBudgetPlan
  readonly totalTimeoutMs: number | null
  readonly signal: AbortSignal | null
  readonly costLedger: CostLedgerHandle | null
  readonly costPhase: string | null
  readonly tags: Readonly<Record<string, string>> | null
  readonly priorFindings:
    | ReadonlyArray<AnalystFinding>
    | Readonly<Record<string, ReadonlyArray<AnalystFinding>>>
    | null
  readonly chainFindings: boolean
  readonly hooks: AnalystHooks
  readonly chat: ChatClient | undefined
  readonly log: (msg: string, fields?: Record<string, unknown>) => void
  readonly executionSnapshot: ExactAnalystExecutionPlanSnapshot | undefined
}

type InternalAnalystRunEvent = AnalystRunEvent

/** A post-start exact-run failure; completed work remains attached for accounting and review. */
export class ExactAnalystRunExecutionError extends Error {
  readonly name: string = 'ExactAnalystRunExecutionError'
  readonly result: ExactAnalystRunResult

  constructor(message: string, result: ExactAnalystRunResult, options?: ErrorOptions) {
    super(message, options)
    const snapshot = snapshotExactAnalystRunReceipt(result, 'ExactAnalystRunExecutionError result')
    if (snapshot.completion.status !== 'failed') {
      throw new TypeError('ExactAnalystRunExecutionError result must be a failed receipt')
    }
    this.result = snapshot
  }
}

export class AnalystRegistry {
  private readonly analysts = new Map<string, Analyst>()
  private readonly options: AnalystRegistryOptions

  constructor(options: AnalystRegistryOptions = {}) {
    this.options = options
  }

  register(analyst: Analyst): void {
    const id = analyst.id
    const version = analyst.version
    const cost = analyst.cost
    if (!id) throw new Error('AnalystRegistry.register: analyst.id is required')
    if (this.analysts.has(id)) {
      throw new Error(`AnalystRegistry.register: duplicate analyst id "${id}"`)
    }
    if (!version) {
      throw new Error(`AnalystRegistry.register: analyst "${id}" must declare a version`)
    }
    if (cost.kind === 'deterministic' && cost.settlement_timeout_ms !== undefined) {
      throw new TypeError(
        `AnalystRegistry.register: deterministic analyst "${id}" cannot declare settlement_timeout_ms`,
      )
    }
    if (cost.settlement_timeout_ms !== undefined) {
      validateUsageSettlementTimeout(cost.settlement_timeout_ms)
    }
    this.analysts.set(id, analyst)
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

  /** Run exactly the ordered analysts and complete policy supplied by the caller. */
  async runExact(
    runId: string,
    inputs: AnalystRunInputs,
    runOpts: ExactRegistryRunOpts,
  ): Promise<ExactAnalystRunResult> {
    for await (const ev of this.runExactStream(runId, inputs, runOpts)) {
      if (ev.type === 'run-completed') return ev.result
    }
    throw new Error('AnalystRegistry.runExact: stream completed without run-completed event')
  }

  /** Streaming counterpart to {@link runExact}. */
  async *runExactStream(
    runId: string,
    inputs: AnalystRunInputs,
    runOpts: ExactRegistryRunOpts,
  ): AsyncGenerator<ExactAnalystRunEvent, void, void> {
    for await (const event of this.executePlanStream(
      this.normalizeExactPlan(runId, inputs, runOpts),
    )) {
      yield event as ExactAnalystRunEvent
    }
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
    yield* this.executePlanStream(this.normalizeLegacyPlan(runId, inputs, runOpts))
  }

  private normalizeLegacyPlan(
    runId: string,
    inputs: AnalystRunInputs,
    runOpts: RegistryRunOpts,
  ): AnalystExecutionPlan {
    const timeoutMs = validateTimeout(runOpts.timeoutMs) ?? null
    const budget = runOpts.budget ?? this.options.defaultBudget
    validateBudgetPolicy(budget)
    const selected = this.selectAnalysts(runOpts)
    return {
      runId,
      prepared: selected.map((analyst) => ({
        analyst,
        input: this.routeInput(analyst, inputs),
      })),
      budget: budget ? { kind: 'dynamic', policy: budget } : { kind: 'none' },
      totalTimeoutMs: timeoutMs,
      signal: runOpts.signal ?? null,
      costLedger: runOpts.costLedger ?? null,
      costPhase: runOpts.costPhase ?? null,
      tags: runOpts.tags ?? null,
      priorFindings: runOpts.priorFindings ?? null,
      chainFindings: runOpts.chainFindings ?? false,
      hooks: this.options.hooks ?? {},
      chat: this.options.chat,
      log: this.options.log ?? (() => {}),
      executionSnapshot: undefined,
    }
  }

  private normalizeExactPlan(
    runId: string,
    inputs: AnalystRunInputs,
    runOpts: ExactRegistryRunOpts,
  ): AnalystExecutionPlan {
    const exactRunId = snapshotExactRunId(runId)
    const exact = snapshotExactRegistryRunOpts(runOpts)
    const selected = normalizeExactAnalysts(this.selectExactAnalysts(exact.analystIds))
    const registryChat = this.options.chat
    const registryChatIdentity = this.options.chatIdentity
    const registryHooks = this.options.hooks
    const registryHooksIdentity = this.options.hooksIdentity
    if (exact.useRegistryChat && registryChat === undefined) {
      throw new TypeError(
        'ExactRegistryRunOpts.useRegistryChat is true but the registry has no chat client',
      )
    }
    if (exact.applyRegistryHooks && !hasRegistryHooks(registryHooks)) {
      throw new TypeError(
        'ExactRegistryRunOpts.applyRegistryHooks is true but the registry has no lifecycle hooks',
      )
    }
    const inputSnapshot = snapshotAnalystRunInputChannels(inputs)
    const prepared = selected.map((analyst) => ({
      analyst,
      input: this.routeInput(analyst, inputSnapshot),
    }))
    if (exact.missingInputMode === 'abort') {
      const missing = prepared.find((candidate) => candidate.input.kind === 'missing')?.analyst
      if (missing) {
        throw new TypeError(
          `ExactRegistryRunOpts.missingInputMode abort preflight found no "${missing.inputKind}" input for "${missing.id}"`,
        )
      }
    }
    const hooksIdentity =
      exact.applyRegistryHooks && registryHooks
        ? requireExactComponentIdentity(registryHooksIdentity, 'registry hooks')
        : null
    const chatIdentity = exact.useRegistryChat
      ? requireExactComponentIdentity(registryChatIdentity, 'registry chat')
      : null
    const costLedgerIdentity =
      exact.costLedger === null
        ? null
        : requireExactComponentIdentity(exact.costLedgerIdentity ?? undefined, 'cost ledger')
    const allocations = exactFixedBudgets(
      exact.budget,
      prepared
        .filter(
          (
            candidate,
          ): candidate is {
            analyst: ExactCapableAnalyst
            input: { kind: 'present'; value: unknown }
          } => candidate.input.kind === 'present',
        )
        .map((candidate) => candidate.analyst),
      selected,
    )
    const executionSnapshot = exactExecutionSnapshot(
      selected,
      exact,
      allocations,
      costLedgerIdentity,
      hooksIdentity,
      chatIdentity,
    )
    return {
      runId: exactRunId,
      prepared,
      budget: { kind: 'none' },
      totalTimeoutMs: exact.totalTimeoutMs,
      signal: exact.signal,
      costLedger: exact.costLedger,
      costPhase: exact.costPhase,
      tags: exact.tags,
      priorFindings: exact.priorFindings,
      chainFindings: exact.chainFindings,
      hooks: exact.applyRegistryHooks && registryHooks ? snapshotHooks(registryHooks) : {},
      chat: exact.useRegistryChat && registryChat ? snapshotChat(registryChat) : undefined,
      // Exact runs expose live events and versioned hooks. An inherited logger is intentionally
      // excluded because an anonymous callback can throw, block, or mutate shared state.
      log: () => {},
      executionSnapshot,
    }
  }

  private async *executePlanStream(
    plan: AnalystExecutionPlan,
  ): AsyncGenerator<InternalAnalystRunEvent, void, void> {
    const exact = plan.executionSnapshot !== undefined
    if (exact && plan.signal?.aborted) throw abortReason(plan.signal)

    const correlationId = `ar_${randomUUID().slice(0, 12)}`
    const log = plan.log
    const startedAt = new Date().toISOString()
    const started = Date.now()
    const timeoutSignal =
      plan.totalTimeoutMs === null ? undefined : AbortSignal.timeout(plan.totalTimeoutMs)
    const runSignal = combineAbortSignals(plan.signal ?? undefined, timeoutSignal)
    const deadlineMs = plan.totalTimeoutMs === null ? undefined : started + plan.totalTimeoutMs
    const runnable = plan.prepared
      .filter(
        (
          candidate,
        ): candidate is {
          analyst: Analyst
          input: { kind: 'present'; value: unknown }
        } => candidate.input.kind === 'present',
      )
      .map((candidate) => candidate.analyst)
    let remainingUsd = plan.budget.kind === 'dynamic' ? plan.budget.policy.totalUsd : undefined
    const weights = plan.budget.kind === 'dynamic' ? plan.budget.policy.weights : undefined
    const totalWeight =
      weights &&
      plan.budget.kind === 'dynamic' &&
      plan.budget.policy.totalUsd != null &&
      !plan.budget.policy.allocate &&
      runnable.length > 0
        ? runnable.reduce((sum, analyst) => sum + analystWeight(weights, analyst.id), 0)
        : undefined
    if (totalWeight === 0) {
      throw new Error('BudgetPolicy.weights must allocate positive weight to a runnable analyst')
    }
    const upstreamFindings: AnalystFinding[] = []

    yield snapshotExecutionEvent(
      {
        type: 'run-started',
        run_id: plan.runId,
        correlation_id: correlationId,
        started_at: startedAt,
        analyst_ids: plan.prepared.map(({ analyst }) => analyst.id),
        ...(plan.executionSnapshot === undefined ? {} : { execution_plan: plan.executionSnapshot }),
      },
      exact,
    )

    const executions: AnalystExecution[] = []
    let executionFailure: unknown

    for (const { analyst, input } of plan.prepared) {
      const t0 = Date.now()
      if (runSignal?.aborted) {
        const summary = abortedBeforeStartSummary(analyst, runSignal)
        executions.push({ summary, findings: [], budgetDebitUsd: 0 })
        log(`[analyst] skip ${analyst.id} — run aborted`, {
          runId: plan.runId,
          reason: summary.reason,
        })
        yield snapshotExecutionEvent({ type: 'analyst-skipped', summary }, exact)
        if (exact) {
          executionFailure = abortReason(runSignal)
          break
        }
        continue
      }

      if (input.kind === 'missing') {
        const summary: AnalystRunSummary = {
          analyst_id: analyst.id,
          status: 'skipped',
          reason: `missing input of kind '${analyst.inputKind}'`,
          findings_count: 0,
          latency_ms: 0,
          usage: zeroUsage(),
        }
        const execution = { summary, findings: [], budgetDebitUsd: 0 } satisfies AnalystExecution
        executions.push(execution)
        log(`[analyst] skip ${analyst.id} — missing input`, {
          runId: plan.runId,
          kind: analyst.inputKind,
        })
        const hookValues = snapshotAfterHookValues(summary, [], exact)
        try {
          await waitForHook(
            plan.hooks.onAfterAnalyze
              ? () =>
                  plan.hooks.onAfterAnalyze?.({
                    analyst,
                    summary: hookValues.summary,
                    findings: hookValues.findings,
                    runId: plan.runId,
                  })
              : undefined,
            runSignal,
          )
        } catch (error) {
          if (!exact) throw error
          executionFailure = error
        }
        yield snapshotExecutionEvent({ type: 'analyst-skipped', summary }, exact)
        if (executionFailure !== undefined) break
        continue
      }

      const allocatedUsd =
        plan.executionSnapshot === undefined
          ? allocateBudget(plan.budget.kind === 'dynamic' ? plan.budget.policy : undefined, {
              analyst,
              remainingUsd,
              runningCount: runnable.length,
              totalWeight,
            })
          : exactPlannedAllocation(plan.executionSnapshot, analyst.id)
      const budgetCeilingUsd = plan.executionSnapshot === undefined ? remainingUsd : allocatedUsd
      const usageReceipts: AnalystUsageReceipt[] = []
      const contextTags = plan.tags === null ? undefined : { ...plan.tags }
      const priorFindings = selectPriorFindings(plan.priorFindings ?? undefined, analyst.id)
      const chainedFindings =
        plan.chainFindings && upstreamFindings.length > 0 ? [...upstreamFindings] : undefined
      const ctx: AnalystContext = {
        runId: plan.runId,
        correlationId,
        deadlineMs,
        budgetUsd: allocatedUsd,
        costLedger: plan.costLedger ?? undefined,
        costPhase: plan.costPhase ?? undefined,
        chat: plan.chat,
        tags: contextTags,
        log: (message, fields) =>
          log(`[${analyst.id}] ${message}`, {
            runId: plan.runId,
            correlationId,
            ...fields,
          }),
        signal: runSignal,
        priorFindings,
        upstreamFindings: chainedFindings,
        recordUsage: (receipt) => {
          if (!exact) {
            assertValidAnalystUsageReceipt(receipt)
            usageReceipts.push(receipt)
            return
          }
          usageReceipts.push(
            snapshotUsageReceiptOnce(
              receipt,
              `AnalystRegistry.runExact analyst "${analyst.id}" usage`,
            ),
          )
        },
      }
      if (exact) {
        if (contextTags) deepFreezeCanonicalJson(contextTags)
        if (priorFindings) deepFreezeCanonicalJson(priorFindings)
        if (chainedFindings) deepFreezeCanonicalJson(chainedFindings)
        Object.freeze(ctx)
      }

      try {
        await waitForHook(
          plan.hooks.onBeforeAnalyze
            ? () => plan.hooks.onBeforeAnalyze?.({ analyst, ctx, runId: plan.runId })
            : undefined,
          runSignal,
        )
      } catch (error) {
        if (!exact) throw error
        executionFailure = error
        break
      }
      if (runSignal?.aborted) {
        const summary = abortedBeforeStartSummary(analyst, runSignal, Date.now() - t0)
        executions.push({ summary, findings: [], budgetDebitUsd: 0 })
        yield snapshotExecutionEvent({ type: 'analyst-skipped', summary }, exact)
        if (exact) {
          executionFailure = abortReason(runSignal)
          break
        }
        continue
      }
      let effectiveBudget: number | undefined
      try {
        effectiveBudget = validateEffectiveBudget(ctx.budgetUsd, budgetCeilingUsd, analyst.id)
      } catch (error) {
        if (!exact) throw error
        executionFailure = error
        break
      }
      const analystContext: AnalystContext = exact ? ctx : { ...ctx }
      const executionSignal = exact ? ctx.signal : runSignal
      yield snapshotExecutionEvent(
        {
          type: 'analyst-started',
          analyst_id: analyst.id,
          started_at: new Date(t0).toISOString(),
        },
        exact,
      )

      let findings: AnalystFinding[]
      let summary: AnalystRunSummary
      let lifecycleFailure: unknown
      let analysisFailure: Error | undefined
      try {
        if (runSignal?.aborted) throw abortReason(runSignal)
        const analyzed = await waitForOperation(
          (analyst as Analyst<unknown>).analyze(input.value, analystContext),
          executionSignal,
          analystAbortGraceMs(analyst),
        )
        findings = snapshotExecutionFindings(
          analyzed,
          exact,
          `AnalystRegistry.runExact analyst "${analyst.id}" findings`,
        )
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error))
        analysisFailure = cause
        let hookFindings: AnalystFinding[] = []
        if (!executionSignal?.aborted) {
          try {
            const rawHookFindings =
              (await waitForHook(
                plan.hooks.onError
                  ? () =>
                      plan.hooks.onError?.({
                        analyst,
                        error: cause,
                        runId: plan.runId,
                      })
                  : undefined,
                executionSignal,
              )) ?? []
            hookFindings = snapshotExecutionFindings(
              rawHookFindings,
              exact,
              `AnalystRegistry.runExact analyst "${analyst.id}" onError findings`,
            )
          } catch (error) {
            lifecycleFailure = error
          }
        }
        findings = hookFindings
      }

      let usage: AnalystUsageReceipt
      try {
        usage = resolveUsage(analyst, usageReceipts, exact)
      } catch (error) {
        if (!exact) throw error
        executionFailure = error
        break
      }
      if (analysisFailure === undefined) {
        summary = {
          analyst_id: analyst.id,
          status: 'ok',
          findings_count: findings.length,
          latency_ms: Date.now() - t0,
          usage,
          ...(exact ? { allocated_budget_usd: effectiveBudget ?? null } : {}),
        }
        log(`[analyst] ok ${analyst.id}`, {
          runId: plan.runId,
          findings: findings.length,
          latency_ms: summary.latency_ms,
          cost_usd: knownCostUsd(usage),
          cost_kind: usage.cost.kind,
          input_tokens: usage.tokens?.input ?? null,
          output_tokens: usage.tokens?.output ?? null,
        })
      } else {
        const errorClass = analysisFailure.constructor.name || 'Error'
        const errorMessage =
          exact && analysisFailure.message.length === 0
            ? 'Analyst failed without an error message'
            : analysisFailure.message
        summary = {
          analyst_id: analyst.id,
          status: 'failed',
          findings_count: findings.length,
          latency_ms: Date.now() - t0,
          usage,
          ...(exact ? { allocated_budget_usd: effectiveBudget ?? null } : {}),
          error: { class: errorClass, message: errorMessage },
        }
        log(`[analyst] FAIL ${analyst.id}`, {
          runId: plan.runId,
          error_class: errorClass,
          error: errorMessage,
          cost_usd: knownCostUsd(usage),
          cost_kind: usage.cost.kind,
        })
      }
      logUncapturedBudgetWarning({
        analyst,
        runId: plan.runId,
        budgetUsd: effectiveBudget,
        usage,
        log,
      })

      const execution = {
        summary,
        findings,
        budgetDebitUsd: budgetDebit(summary.usage, effectiveBudget),
      } satisfies AnalystExecution
      if (exact) {
        try {
          executionCost([...executions, execution], true)
        } catch (error) {
          executionFailure = error
          break
        }
      }
      executions.push(execution)
      if (plan.budget.kind === 'dynamic' && remainingUsd !== undefined) {
        remainingUsd = Math.max(0, remainingUsd - execution.budgetDebitUsd)
      }
      if (plan.chainFindings) upstreamFindings.push(...findings)
      if (lifecycleFailure !== undefined) {
        if (!exact) throw lifecycleFailure
        executionFailure = lifecycleFailure
        break
      }

      const hookValues = snapshotAfterHookValues(summary, findings, exact)
      try {
        await waitForHook(
          plan.hooks.onAfterAnalyze
            ? () =>
                plan.hooks.onAfterAnalyze?.({
                  analyst,
                  summary: hookValues.summary,
                  findings: hookValues.findings,
                  runId: plan.runId,
                })
            : undefined,
          executionSignal,
        )
      } catch (error) {
        if (!exact) throw error
        executionFailure = error
        break
      }
      yield snapshotExecutionEvent({ type: 'analyst-completed', summary, findings }, exact)
      if (exact && runSignal?.aborted) {
        executionFailure = abortReason(runSignal)
        break
      }
    }

    const summaries = executions.map(({ summary }) => summary)
    const findings = executions.flatMap((execution) => execution.findings)
    const cost = executionCost(executions, exact)
    const baseResult: AnalystRunResult = {
      run_id: plan.runId,
      correlation_id: correlationId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      findings,
      per_analyst: summaries,
      total_cost_usd: cost.known,
      total_cost_provenance: cost.provenance,
    }
    if (plan.executionSnapshot === undefined) {
      await waitForHook(
        plan.hooks.onComplete ? () => plan.hooks.onComplete?.({ result: baseResult }) : undefined,
        runSignal,
      )
      yield { type: 'run-completed', result: baseResult }
      return
    }

    let completeResult: ExactAnalystRunResult | undefined
    if (executionFailure === undefined) {
      try {
        completeResult = snapshotExactAnalystRunReceipt(
          {
            ...baseResult,
            execution_plan: plan.executionSnapshot,
            completion: { status: 'complete' },
          },
          'AnalystRegistry.runExact result',
        )
        await waitForHook(
          plan.hooks.onComplete
            ? () => plan.hooks.onComplete?.({ result: completeResult! })
            : undefined,
          runSignal,
        )
      } catch (error) {
        executionFailure = error
      }
    }
    if (runSignal?.aborted) executionFailure ??= abortReason(runSignal)
    if (executionFailure === undefined && completeResult) {
      yield snapshotExecutionEvent({ type: 'run-completed', result: completeResult }, true)
      return
    }

    const cause =
      executionFailure instanceof Error ? executionFailure : new Error(String(executionFailure))
    const errorClass = cause.constructor.name || 'Error'
    const errorMessage =
      cause.message.trim().length === 0
        ? 'Exact analyst run failed without a message'
        : cause.message
    throw new ExactAnalystRunExecutionError(
      `exact analyst run failed after starting: ${errorMessage}; partial result is attached`,
      {
        ...baseResult,
        execution_plan: plan.executionSnapshot,
        completion: {
          status: 'failed',
          error: { class: errorClass, message: errorMessage },
        },
      },
      { cause },
    )
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

  private selectExactAnalysts(
    ids: readonly string[],
  ): ReadonlyArray<{ readonly registeredId: string; readonly analyst: Analyst }> {
    return ids.map((id) => {
      const analyst = this.analysts.get(id)
      if (!analyst) throw new Error(`ExactRegistryRunOpts.analystIds names unknown analyst "${id}"`)
      return { registeredId: id, analyst }
    })
  }

  private routeInput(
    analyst: Analyst,
    inputs: AnalystRunInputs,
  ): { kind: 'present'; value: unknown } | { kind: 'missing' } {
    switch (analyst.inputKind) {
      case 'trace-store': {
        const value = inputs.traceStore
        return value ? { kind: 'present', value } : { kind: 'missing' }
      }
      case 'artifact-dir': {
        const value = inputs.artifactDir
        return value ? { kind: 'present', value } : { kind: 'missing' }
      }
      case 'run-record': {
        const value = inputs.runRecord
        return value ? { kind: 'present', value } : { kind: 'missing' }
      }
      case 'judge-input': {
        const value = inputs.judgeInput
        return value ? { kind: 'present', value } : { kind: 'missing' }
      }
      case 'custom': {
        const custom = inputs.custom
        const value = custom?.[analyst.id]
        return value !== undefined ? { kind: 'present', value } : { kind: 'missing' }
      }
    }
  }
}

const exactRunFields = [
  'analystIds',
  'budget',
  'totalTimeoutMs',
  'signal',
  'costLedger',
  'costLedgerIdentity',
  'costPhase',
  'tags',
  'priorFindings',
  'chainFindings',
  'missingInputMode',
  'applyRegistryHooks',
  'useRegistryChat',
] as const

const exactNonEmptyString = z.string().min(1)
const exactFiniteNonnegative = z.number().finite().nonnegative()
const exactBudgetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('equal'),
    totalUsd: exactFiniteNonnegative,
  }),
  z.strictObject({
    kind: z.literal('weighted'),
    totalUsd: exactFiniteNonnegative,
    weights: z.record(exactNonEmptyString, exactFiniteNonnegative),
  }),
])
const exactRunDataSchema = z
  .strictObject({
    analystIds: z.array(exactNonEmptyString).min(1),
    budget: exactBudgetSchema.nullable(),
    totalTimeoutMs: z.number().int().positive().max(2_147_483_647).nullable(),
    costLedgerIdentity: z.unknown().nullable(),
    costPhase: exactNonEmptyString.nullable(),
    tags: z.record(z.string(), z.string()).nullable(),
    chainFindings: z.boolean(),
    missingInputMode: z.enum(['skip', 'abort']),
    applyRegistryHooks: z.boolean(),
    useRegistryChat: z.boolean(),
  })
  .superRefine((policy, context) => {
    const issue = (path: PropertyKey[], message: string): void =>
      context.addIssue({ code: 'custom', path, message })
    if (new Set(policy.analystIds).size !== policy.analystIds.length) {
      issue(['analystIds'], 'must not contain duplicates')
    }
    if (
      policy.budget?.kind === 'weighted' &&
      Object.values(policy.budget.weights).every((weight) => weight === 0)
    ) {
      issue(['budget', 'weights'], 'must allocate positive weight to at least one analyst')
    }
    if (policy.budget?.kind === 'weighted') {
      const selected = [...policy.analystIds].sort()
      const weighted = Object.keys(policy.budget.weights).sort()
      if (
        selected.length !== weighted.length ||
        selected.some((id, index) => id !== weighted[index])
      ) {
        issue(['budget', 'weights'], 'must name every selected analyst and no others')
      }
    }
  })

/** Validate the canonical exact-run policy before any analyst can start. */
export function assertExactRegistryRunOpts(value: unknown): asserts value is ExactRegistryRunOpts {
  void snapshotExactRegistryRunOpts(value)
}

function snapshotExactRunId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('AnalystRegistry.runExact: runId must be a non-empty string')
  }
  return canonicalJsonSnapshot(value, 'AnalystRegistry.runExact runId')
}

function snapshotAnalystRunInputChannels(inputs: AnalystRunInputs): AnalystRunInputs {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new TypeError('AnalystRegistry.runExact: inputs must be an object')
  }
  const traceStore = inputs.traceStore
  const artifactDir = inputs.artifactDir
  const runRecord = inputs.runRecord
  const judgeInput = inputs.judgeInput
  const custom = inputs.custom
  return Object.freeze({
    traceStore,
    artifactDir,
    runRecord,
    judgeInput,
    custom,
  })
}

/**
 * Read the untrusted caller object once, then validate and execute only this frozen snapshot.
 * Functions and resource handles retain identity; all data fields are copied canonically.
 */
function snapshotExactRegistryRunOpts(value: unknown): ExactRegistryRunOpts {
  const captured = readOwnFields(value, exactRunFields, 'ExactRegistryRunOpts')
  const missing = exactRunFields.find((field) => !Object.hasOwn(captured, field))
  if (missing) {
    throw new TypeError(`ExactRegistryRunOpts.${missing} must be supplied explicitly`)
  }
  const { signal, costLedger, priorFindings, ...rawData } = captured
  const data = canonicalJsonSnapshot(rawData, 'ExactRegistryRunOpts')
  const parsed = exactRunDataSchema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (issue?.code === 'unrecognized_keys' && issue.path.join('.') === 'budget') {
      const required =
        isPlainRecord(data.budget) && data.budget.kind === 'weighted'
          ? 'kind, totalUsd, weights'
          : 'kind, totalUsd'
      throw new TypeError(`ExactRegistryRunOpts.budget must contain exactly ${required}`)
    }
    const path = issue?.path.length ? `.${issue.path.join('.')}` : ''
    throw new TypeError(`ExactRegistryRunOpts${path}: ${issue?.message ?? 'is invalid'}`)
  }
  if (
    signal !== null &&
    (!signal ||
      typeof signal !== 'object' ||
      typeof (signal as AbortSignal).addEventListener !== 'function')
  ) {
    throw new TypeError('ExactRegistryRunOpts.signal must be an AbortSignal or null')
  }
  if (costLedger !== null && (!costLedger || typeof costLedger !== 'object')) {
    throw new TypeError('ExactRegistryRunOpts.costLedger must be a CostLedgerHandle or null')
  }
  if (costLedger === null && parsed.data.costLedgerIdentity !== null) {
    throw new TypeError('ExactRegistryRunOpts.costLedgerIdentity must be null without costLedger')
  }
  if (costLedger !== null && parsed.data.costLedgerIdentity === null) {
    throw new TypeError('ExactRegistryRunOpts.costLedgerIdentity is required with costLedger')
  }
  if (costLedger === null && parsed.data.costPhase !== null) {
    throw new TypeError('ExactRegistryRunOpts.costPhase requires a non-null costLedger')
  }
  return Object.freeze({
    ...deepFreezeCanonicalJson(parsed.data),
    signal: signal as AbortSignal | null,
    costLedger: costLedger as CostLedgerHandle | null,
    priorFindings: snapshotExactPriorFindings(priorFindings),
  }) as ExactRegistryRunOpts
}

function snapshotExactPriorFindings(value: unknown): ExactRegistryRunOpts['priorFindings'] {
  if (value === null) return null
  if (Array.isArray(value)) {
    return snapshotAnalystFindings(value, 'ExactRegistryRunOpts.priorFindings')
  }
  if (!isPlainRecord(value)) {
    throw new TypeError(
      'ExactRegistryRunOpts.priorFindings must be an array, a findings record, or null',
    )
  }
  const result: Record<string, ReadonlyArray<AnalystFinding>> = {}
  for (const [key, findings] of Object.entries(value)) {
    if (!Array.isArray(findings)) {
      throw new TypeError(`ExactRegistryRunOpts.priorFindings.${key} must be an array`)
    }
    result[key] = snapshotAnalystFindings(findings, `ExactRegistryRunOpts.priorFindings.${key}`)
  }
  return deepFreezeCanonicalJson(result)
}

function normalizeExactAnalysts(
  selections: ReadonlyArray<{ readonly registeredId: string; readonly analyst: Analyst }>,
): ExactCapableAnalyst[] {
  return selections.map(({ registeredId, analyst }) => {
    const exactAnalyst = analyst as Analyst & {
      readonly executionConfig?: Readonly<Record<string, unknown>>
    }
    const id = analyst.id
    const description = analyst.description
    const inputKind = analyst.inputKind
    const rawCostValue = analyst.cost
    const requiresValue = analyst.requires
    const version = analyst.version
    const executionConfigValue = exactAnalyst.executionConfig
    const analyzeValue = analyst.analyze
    if (id !== registeredId) {
      throw new TypeError(
        `AnalystRegistry.runExact: registered analyst "${registeredId}" changed id to "${id}"`,
      )
    }
    if (executionConfigValue === undefined) {
      throw new TypeError(`AnalystRegistry.runExact: analyst "${id}" must declare executionConfig`)
    }
    const executionConfig = canonicalJsonSnapshot(
      executionConfigValue,
      `AnalystRegistry.runExact analyst "${id}" executionConfig`,
    )
    if (!isPlainRecord(executionConfig)) {
      throw new TypeError(
        `AnalystRegistry.runExact analyst "${id}" executionConfig must be an object`,
      )
    }
    const rawCost = canonicalJsonSnapshot(
      rawCostValue,
      `AnalystRegistry.runExact analyst "${id}" cost`,
    )
    const cost =
      rawCost.kind === 'llm'
        ? Object.freeze({
            ...rawCost,
            settlement_timeout_ms: validateUsageSettlementTimeout(rawCost.settlement_timeout_ms),
          })
        : rawCost
    const requires =
      requiresValue === undefined
        ? undefined
        : canonicalJsonSnapshot(
            requiresValue,
            `AnalystRegistry.runExact analyst "${id}" requirements`,
          )
    const analyze = analyzeValue.bind(analyst)
    return Object.freeze({
      id,
      description,
      inputKind,
      cost,
      ...(requires === undefined ? {} : { requires }),
      version,
      executionConfig,
      analyze,
    }) satisfies ExactCapableAnalyst
  })
}

function hasRegistryHooks(hooks: AnalystHooks | undefined): hooks is AnalystHooks {
  return Boolean(
    hooks && (hooks.onBeforeAnalyze || hooks.onAfterAnalyze || hooks.onError || hooks.onComplete),
  )
}

function snapshotHooks(hooks: AnalystHooks): AnalystHooks {
  const onBeforeAnalyze = hooks.onBeforeAnalyze
  const onAfterAnalyze = hooks.onAfterAnalyze
  const onError = hooks.onError
  const onComplete = hooks.onComplete
  return Object.freeze({
    ...(onBeforeAnalyze === undefined ? {} : { onBeforeAnalyze: onBeforeAnalyze.bind(hooks) }),
    ...(onAfterAnalyze === undefined ? {} : { onAfterAnalyze: onAfterAnalyze.bind(hooks) }),
    ...(onError === undefined ? {} : { onError: onError.bind(hooks) }),
    ...(onComplete === undefined ? {} : { onComplete: onComplete.bind(hooks) }),
  })
}

function snapshotChat(chat: ChatClient): ChatClient {
  const transport = chat.transport
  const defaultModel = chat.defaultModel
  const maximumAttempts = chat.maximumAttempts
  const call = chat.chat
  return Object.freeze({
    transport,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(maximumAttempts === undefined ? {} : { maximumAttempts }),
    chat: call.bind(chat),
  })
}

function requireExactComponentIdentity(
  value: ExactExecutionComponentIdentity | undefined,
  label: string,
): ExactExecutionComponentSnapshot {
  if (value === undefined) {
    throw new TypeError(`AnalystRegistry.runExact: ${label} requires a versioned identity`)
  }
  return snapshotExactExecutionComponentIdentity(
    value,
    `AnalystRegistry.runExact ${label} identity`,
  )
}

function exactExecutionSnapshot(
  analysts: readonly ExactCapableAnalyst[],
  opts: ExactRegistryRunOpts,
  allocations: Readonly<Record<string, number | null>>,
  costLedger: ExactExecutionComponentSnapshot | null,
  hooks: ExactExecutionComponentSnapshot | null,
  chat: ExactExecutionComponentSnapshot | null,
): ExactAnalystExecutionPlanSnapshot {
  const priorFindings = exactPriorFindingsSnapshot(opts.priorFindings)
  const budget =
    opts.budget === null
      ? ({ kind: 'none' } as const)
      : opts.budget.kind === 'equal'
        ? ({
            kind: 'equal',
            total_usd: opts.budget.totalUsd,
            allocations_usd: { ...allocations },
          } as const)
        : ({
            kind: 'weighted',
            total_usd: opts.budget.totalUsd,
            weights: { ...opts.budget.weights },
            allocations_usd: { ...allocations },
          } as const)
  const material = {
    schema_version: '1.0.0' as const,
    analysts: analysts.map((analyst) => ({
      id: analyst.id,
      version: analyst.version,
      input_kind: analyst.inputKind,
      cost: analyst.cost,
      requirements: analyst.requires ?? null,
      execution_config_digest: hashCanonical(analyst.executionConfig),
    })),
    policy: {
      budget,
      total_timeout_ms: opts.totalTimeoutMs,
      signal_provided: opts.signal !== null,
      cost_ledger: costLedger,
      cost_phase: opts.costPhase,
      tags: opts.tags === null ? null : { ...opts.tags },
      prior_findings: priorFindings,
      chain_findings: opts.chainFindings,
      missing_input_mode: opts.missingInputMode,
      registry_hooks: hooks,
      registry_chat: chat,
    },
  }
  return snapshotExactExecutionPlan(
    { ...material, digest: hashCanonical(material) },
    'AnalystRegistry.runExact execution plan',
  )
}

function exactPriorFindingsSnapshot(
  findings: ExactRegistryRunOpts['priorFindings'],
): ExactAnalystExecutionPlanSnapshot['policy']['prior_findings'] {
  if (findings === null) return { kind: 'none' }
  if (Array.isArray(findings)) {
    return {
      kind: 'ordered',
      count: findings.length,
      digest: hashCanonical(findings),
    }
  }
  const record = findings as Readonly<Record<string, ReadonlyArray<AnalystFinding>>>
  const keys = Object.keys(record).sort()
  return {
    kind: 'by_analyst',
    keys,
    count: keys.reduce((sum, key) => sum + (record[key]?.length ?? 0), 0),
    digest: hashCanonical(record),
  }
}

function canonicalJsonSnapshot<T>(value: T, label: string): T {
  let snapshot: T
  try {
    snapshot = JSON.parse(canonicalString(value)) as T
  } catch (cause) {
    throw new TypeError(`${label} must be canonical JSON`, { cause })
  }
  return deepFreezeCanonicalJson(snapshot)
}

function snapshotUsageReceiptOnce(
  receipt: AnalystUsageReceipt,
  context: string,
): AnalystUsageReceipt {
  const data = readOwnFields(receipt, ['calls', 'tokens', 'cost', 'knownCostUsd'], context)
  data.tokens =
    data.tokens === null
      ? null
      : readOwnFields(
          data.tokens,
          ['input', 'output', 'reasoning', 'cached', 'cacheWrite'],
          `${context} tokens`,
        )
  data.cost = readOwnFields(data.cost, ['kind', 'usd'], `${context} cost`)
  const snapshot = canonicalJsonSnapshot(data as unknown as AnalystUsageReceipt, context)
  assertValidAnalystUsageReceipt(snapshot, context)
  return snapshot
}

function readOwnFields(
  value: unknown,
  fields: readonly string[],
  context: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${context} must be a plain object`)
  const unexpected = Object.keys(value).filter((key) => !fields.includes(key))
  if (unexpected.length > 0) {
    throw new TypeError(`${context} contains unknown fields: ${unexpected.sort().join(', ')}`)
  }
  return Object.fromEntries(
    fields.flatMap((field) => (Object.hasOwn(value, field) ? [[field, value[field]]] : [])),
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactFixedBudgets(
  exact: ExactAnalystBudgetPolicy | null,
  runnable: readonly Analyst[],
  selected: readonly Analyst[],
): Readonly<Record<string, number | null>> {
  if (exact === null) return {}
  const allocations: Record<string, number | null> = Object.fromEntries(
    selected.map((analyst) => [analyst.id, null]),
  )
  if (runnable.length === 0) return deepFreezeCanonicalJson(allocations)
  if (exact.kind === 'equal') {
    const each = exact.totalUsd / runnable.length
    for (const analyst of runnable) allocations[analyst.id] = each
    return deepFreezeCanonicalJson(allocations)
  }
  const totalWeight = runnable.reduce((sum, analyst) => sum + exact.weights[analyst.id]!, 0)
  if (totalWeight === 0) {
    throw new Error(
      'ExactRegistryRunOpts weighted budget must allocate positive weight to a runnable analyst',
    )
  }
  for (const analyst of runnable) {
    allocations[analyst.id] = (exact.totalUsd * exact.weights[analyst.id]!) / totalWeight
  }
  return deepFreezeCanonicalJson(allocations)
}

interface AnalystExecution {
  readonly summary: AnalystRunSummary
  readonly findings: AnalystFinding[]
  readonly budgetDebitUsd: number
}

function snapshotExecutionFindings(
  findings: AnalystFinding[],
  exact: boolean,
  context: string,
): AnalystFinding[] {
  return exact ? deepFreezeCanonicalJson(snapshotAnalystFindings(findings, context)) : findings
}

function snapshotAfterHookValues(
  summary: AnalystRunSummary,
  findings: AnalystFinding[],
  exact: boolean,
): { summary: AnalystRunSummary; findings: AnalystFinding[] } {
  if (!exact) return { summary, findings }
  return {
    summary: canonicalJsonSnapshot(summary, 'AnalystRegistry.runExact onAfterAnalyze summary'),
    findings: deepFreezeCanonicalJson(
      snapshotAnalystFindings(findings, 'AnalystRegistry.runExact onAfterAnalyze findings'),
    ),
  }
}

function exactPlannedAllocation(
  plan: ExactAnalystExecutionPlanSnapshot,
  analystId: string,
): number | undefined {
  const budget = plan.policy.budget
  if (budget.kind === 'none') return undefined
  const allocated = budget.allocations_usd[analystId]
  return allocated === null ? undefined : allocated
}

function snapshotExecutionEvent<T extends InternalAnalystRunEvent>(event: T, exact: boolean): T {
  return exact ? canonicalJsonSnapshot(event, 'AnalystRegistry.runExact event') : event
}

function logUncapturedBudgetWarning(args: {
  analyst: Analyst
  runId: string
  budgetUsd: number | undefined
  usage: AnalystUsageReceipt
  log: (message: string, fields?: Record<string, unknown>) => void
}): void {
  if (args.budgetUsd === undefined || args.usage.cost.kind !== 'uncaptured') return
  args.log(`[analyst] WARN ${args.analyst.id} — USD cost uncaptured; budget not reconciled`, {
    runId: args.runId,
    budget_usd: args.budgetUsd,
    cost_captured: false,
  })
}

function validateTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError(
      'RegistryRunOpts.timeoutMs must be a positive safe integer no greater than 2147483647',
    )
  }
  return timeoutMs
}

async function waitForOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  abortGraceMs: number,
): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) {
    void operation.catch(() => {})
    throw abortReason(signal)
  }
  return new Promise<T>((resolve, reject) => {
    let settlementTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      if (settlementTimer) clearTimeout(settlementTimer)
    }
    const onAbort = (): void => {
      if (abortGraceMs === 0) {
        cleanup()
        reject(abortReason(signal))
        return
      }
      settlementTimer = setTimeout(() => {
        cleanup()
        reject(abortReason(signal))
      }, abortGraceMs)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        cleanup()
        if (signal.aborted) reject(abortReason(signal))
        else resolve(value)
      },
      (error) => {
        cleanup()
        reject(signal.aborted ? abortReason(signal) : error)
      },
    )
  })
}

async function waitForHook<T>(
  operation: (() => T | Promise<T>) | undefined,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (operation === undefined || signal?.aborted) return undefined
  try {
    return await waitForOperation(
      Promise.resolve().then(() => {
        if (signal?.aborted) throw abortReason(signal)
        return operation()
      }),
      signal,
      0,
    )
  } catch (error) {
    if (signal?.aborted) return undefined
    throw error
  }
}

function analystAbortGraceMs(analyst: Analyst): number {
  if (analyst.cost.kind === 'deterministic') return 0
  const settlementMs = validateUsageSettlementTimeout(analyst.cost.settlement_timeout_ms)
  if (settlementMs === 0) return 0
  return Math.min(settlementMs + 100, 2_147_483_647)
}

function abortedBeforeStartSummary(
  analyst: Analyst,
  signal: AbortSignal,
  latencyMs = 0,
): AnalystRunSummary {
  const reason = abortReason(signal)
  return {
    analyst_id: analyst.id,
    status: 'skipped',
    reason: `${reason.name}: ${reason.message}`,
    findings_count: 0,
    latency_ms: latencyMs,
    usage: zeroUsage(),
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
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
    const allocated = policy.allocate({
      analyst: args.analyst,
      totalUsd: policy.totalUsd,
      remainingUsd: args.remainingUsd,
      runningCount: args.runningCount,
    })
    if (allocated === undefined) {
      if (policy.totalUsd !== undefined) {
        throw new Error(
          `BudgetPolicy.allocate('${args.analyst.id}') cannot return undefined when totalUsd is set`,
        )
      }
      return undefined
    }
    assertBudgetAmount(allocated, `BudgetPolicy.allocate('${args.analyst.id}')`)
    return args.remainingUsd === undefined ? allocated : Math.min(allocated, args.remainingUsd)
  }
  if (policy.totalUsd == null) return undefined
  const allocated = policy.weights
    ? (policy.totalUsd * analystWeight(policy.weights, args.analyst.id)) / args.totalWeight!
    : policy.totalUsd / Math.max(1, args.runningCount)
  return args.remainingUsd === undefined ? allocated : Math.min(allocated, args.remainingUsd)
}

function validateBudgetPolicy(policy: BudgetPolicy | undefined): void {
  if (!policy) return
  if (policy.totalUsd !== undefined) assertBudgetAmount(policy.totalUsd, 'BudgetPolicy.totalUsd')
  for (const [analystId, weight] of Object.entries(policy.weights ?? {})) {
    assertBudgetAmount(weight, `BudgetPolicy.weights['${analystId}']`)
  }
}

function assertBudgetAmount(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`)
  }
}

function validateEffectiveBudget(
  budgetUsd: number | undefined,
  remainingUsd: number | undefined,
  analystId: string,
): number | undefined {
  if (budgetUsd !== undefined) {
    assertBudgetAmount(budgetUsd, `AnalystContext.budgetUsd for '${analystId}'`)
  }
  if (remainingUsd === undefined) return budgetUsd
  if (budgetUsd === undefined) {
    throw new Error(
      `AnalystContext.budgetUsd for '${analystId}' cannot be removed while an overall budget remains`,
    )
  }
  if (budgetUsd > remainingUsd) {
    throw new Error(
      `AnalystContext.budgetUsd for '${analystId}' (${budgetUsd}) exceeds the remaining overall budget (${remainingUsd})`,
    )
  }
  return budgetUsd
}

function analystWeight(weights: Record<string, number>, analystId: string): number {
  const weight = weights[analystId] ?? 1
  assertBudgetAmount(weight, `BudgetPolicy.weights['${analystId}']`)
  return weight
}

function zeroUsage(): AnalystUsageReceipt {
  return {
    calls: 0,
    tokens: { input: 0, output: 0 },
    cost: { kind: 'observed', usd: 0 },
  }
}

function resolveUsage(
  analyst: Analyst,
  receipts: ReadonlyArray<AnalystUsageReceipt>,
  exact = false,
): AnalystUsageReceipt {
  if (receipts.length > 0) return mergeUsageReceipts(receipts, exact)
  if (analyst.cost.kind === 'deterministic') return zeroUsage()
  return { calls: null, tokens: null, cost: { kind: 'uncaptured', usd: null } }
}

function mergeUsageReceipts(
  receipts: ReadonlyArray<AnalystUsageReceipt>,
  exact = false,
): AnalystUsageReceipt {
  const calls = receipts.every((receipt) => receipt.calls !== null)
    ? usageSum(
        receipts.map((receipt) => receipt.calls ?? 0),
        exact,
        'calls',
        true,
      )
    : null
  const tokens = receipts.every((receipt) => receipt.tokens !== null)
    ? (Object.fromEntries(
        (['input', 'output', 'reasoning', 'cached', 'cacheWrite'] as const).flatMap((field) =>
          field === 'input' ||
          field === 'output' ||
          receipts.some((receipt) => receipt.tokens?.[field] !== undefined)
            ? [
                [
                  field,
                  usageSum(
                    receipts.map((receipt) => receipt.tokens?.[field] ?? 0),
                    exact,
                    `tokens.${field}`,
                    true,
                  ),
                ],
              ]
            : [],
        ),
      ) as unknown as RunTokenUsage)
    : null
  const cost = aggregateCostProvenance(
    receipts.map((receipt) => receipt.cost),
    exact,
  )
  return {
    calls,
    tokens,
    cost,
    ...(cost.kind === 'uncaptured'
      ? {
          knownCostUsd: usageSum(receipts.map(knownCostUsd), exact, 'known cost'),
        }
      : {}),
  }
}

function knownCostUsd(receipt: AnalystUsageReceipt): number {
  return receipt.cost.kind === 'uncaptured' ? (receipt.knownCostUsd ?? 0) : receipt.cost.usd
}

function budgetDebit(receipt: AnalystUsageReceipt, allocatedUsd: number | undefined): number {
  const known = knownCostUsd(receipt)
  return receipt.cost.kind === 'uncaptured' && allocatedUsd !== undefined
    ? Math.max(known, allocatedUsd)
    : known
}

function aggregateCostProvenance(
  costs: ReadonlyArray<RunCostProvenance>,
  exact = false,
): RunCostProvenance {
  if (costs.some((cost) => cost.kind === 'uncaptured')) {
    return { kind: 'uncaptured', usd: null }
  }
  const usd = usageSum(
    costs.map((cost) => cost.usd ?? 0),
    exact,
    'captured cost',
  )
  return costs.some((cost) => cost.kind === 'estimated')
    ? { kind: 'estimated', usd }
    : { kind: 'observed', usd }
}

function executionCost(
  executions: ReadonlyArray<AnalystExecution>,
  exact: boolean,
): { known: number; provenance: RunCostProvenance } {
  const usages = executions.map((execution) => execution.summary.usage)
  return {
    known: usageSum(usages.map(knownCostUsd), exact, 'run known cost'),
    provenance: aggregateCostProvenance(
      usages.map((usage) => usage.cost),
      exact,
    ),
  }
}

function usageSum(
  values: readonly number[],
  exact: boolean,
  field: string,
  integer = false,
): number {
  const sum = values.reduce((total, value) => total + value, 0)
  if (exact && (integer ? !Number.isSafeInteger(sum) : !Number.isFinite(sum))) {
    throw new RangeError(
      `exact analyst usage ${field} aggregate ${integer ? 'exceeds a safe integer' : 'is not finite'}`,
    )
  }
  return sum
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
