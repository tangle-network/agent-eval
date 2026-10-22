/** Execute one prepared plan with serial analyst isolation, lifecycle hooks, and accounting. */
import { randomUUID } from 'node:crypto'
import { combineAbortSignals } from '../abort-signal'
import { snapshotExactAnalystRunReceipt } from '../feedback-trajectory-review'
import { deepFreezeCanonicalJson } from '../ledger-core/deep-freeze'
import type { ExactAnalystRunResult } from './exact-types'
import type { AnalystExecution } from './registry-accounting'
import {
  allocateBudget,
  analystWeight,
  budgetDebit,
  exactPlannedAllocation,
  executionCost,
  knownCostUsd,
  logUncapturedBudgetWarning,
  resolveUsage,
  validateEffectiveBudget,
  zeroUsage,
} from './registry-accounting'
import type { AnalystExecutionPlan, RegistryRunOpts } from './registry-plan'
import {
  snapshotAfterHookValues,
  snapshotExecutionEvent,
  snapshotExecutionFindings,
  snapshotUsageReceiptOnce,
} from './registry-snapshot'
import type {
  Analyst,
  AnalystContext,
  AnalystFinding,
  AnalystRunEvent,
  AnalystRunResult,
  AnalystRunSummary,
  AnalystUsageReceipt,
} from './types'
import { assertValidAnalystUsageReceipt, validateUsageSettlementTimeout } from './usage-receipt'

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

/** What every analyst step of one plan execution shares and updates. */
interface PlanRun {
  readonly plan: AnalystExecutionPlan
  readonly exact: boolean
  readonly correlationId: string
  readonly startedAt: string
  readonly deadlineMs: number | undefined
  readonly runSignal: AbortSignal | undefined
  readonly runnableCount: number
  readonly totalWeight: number | undefined
  remainingUsd: number | undefined
  readonly upstreamFindings: AnalystFinding[]
  readonly executions: AnalystExecution[]
  executionFailure: unknown
}

/** 'stop' ends the analyst loop (an exact run's failure, recorded on the run); 'next' goes on. */
type StepOutcome = 'next' | 'stop'

function startPlanRun(plan: AnalystExecutionPlan): PlanRun {
  const exact = plan.executionSnapshot !== undefined
  if (exact && plan.signal?.aborted) throw abortReason(plan.signal)

  const started = Date.now()
  const timeoutSignal =
    plan.totalTimeoutMs === null ? undefined : AbortSignal.timeout(plan.totalTimeoutMs)
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
  return {
    plan,
    exact,
    correlationId: `ar_${randomUUID().slice(0, 12)}`,
    startedAt: new Date(started).toISOString(),
    deadlineMs: plan.totalTimeoutMs === null ? undefined : started + plan.totalTimeoutMs,
    runSignal: combineAbortSignals(plan.signal ?? undefined, timeoutSignal),
    runnableCount: runnable.length,
    totalWeight,
    remainingUsd: plan.budget.kind === 'dynamic' ? plan.budget.policy.totalUsd : undefined,
    upstreamFindings: [],
    executions: [],
    executionFailure: undefined,
  }
}

export async function* executePlanStream(
  plan: AnalystExecutionPlan,
): AsyncGenerator<AnalystRunEvent, void, void> {
  const st = startPlanRun(plan)
  yield snapshotExecutionEvent(
    {
      type: 'run-started',
      run_id: plan.runId,
      correlation_id: st.correlationId,
      started_at: st.startedAt,
      analyst_ids: plan.prepared.map(({ analyst }) => analyst.id),
      ...(plan.executionSnapshot === undefined ? {} : { execution_plan: plan.executionSnapshot }),
    },
    st.exact,
  )
  for (const { analyst, input } of plan.prepared) {
    const outcome = yield* runAnalyst(st, analyst, input)
    if (outcome === 'stop') break
  }
  yield* finishRun(st)
}

/** Record an analyst skipped because the run was aborted; an exact run fails on it. */
async function* skipAborted(
  st: PlanRun,
  analyst: Analyst,
  runSignal: AbortSignal,
  latencyMs?: number,
): AsyncGenerator<AnalystRunEvent, StepOutcome, void> {
  const { plan, exact } = st
  const summary = abortedBeforeStartSummary(analyst, runSignal, latencyMs)
  st.executions.push({ summary, findings: [], budgetDebitUsd: 0 })
  if (latencyMs === undefined) {
    plan.log(`[analyst] skip ${analyst.id} — run aborted`, {
      runId: plan.runId,
      reason: summary.reason,
    })
  }
  yield snapshotExecutionEvent({ type: 'analyst-skipped', summary }, exact)
  if (exact) {
    st.executionFailure = abortReason(runSignal)
    return 'stop'
  }
  return 'next'
}

/** An analyst whose input never arrived is skipped; its after-hook still runs. */
async function* skipMissingInput(
  st: PlanRun,
  analyst: Analyst,
): AsyncGenerator<AnalystRunEvent, StepOutcome, void> {
  const { plan, exact, runSignal } = st
  const summary: AnalystRunSummary = {
    analyst_id: analyst.id,
    status: 'skipped',
    reason: `missing input of kind '${analyst.inputKind}'`,
    findings_count: 0,
    latency_ms: 0,
    usage: zeroUsage(),
  }
  st.executions.push({ summary, findings: [], budgetDebitUsd: 0 } satisfies AnalystExecution)
  plan.log(`[analyst] skip ${analyst.id} — missing input`, {
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
    st.executionFailure = error
  }
  yield snapshotExecutionEvent({ type: 'analyst-skipped', summary }, exact)
  return st.executionFailure !== undefined ? 'stop' : 'next'
}

/** The context handed to one analyst, with the usage receipts it will record into. */
function buildAnalystContext(st: PlanRun, analyst: Analyst) {
  const { plan, exact } = st
  const allocatedUsd =
    plan.executionSnapshot === undefined
      ? allocateBudget(plan.budget.kind === 'dynamic' ? plan.budget.policy : undefined, {
          analyst,
          remainingUsd: st.remainingUsd,
          runningCount: st.runnableCount,
          totalWeight: st.totalWeight,
        })
      : exactPlannedAllocation(plan.executionSnapshot, analyst.id)
  const budgetCeilingUsd = plan.executionSnapshot === undefined ? st.remainingUsd : allocatedUsd
  const usageReceipts: AnalystUsageReceipt[] = []
  const contextTags = plan.tags === null ? undefined : { ...plan.tags }
  const priorFindings = selectPriorFindings(plan.priorFindings ?? undefined, analyst.id)
  const chainedFindings =
    plan.chainFindings && st.upstreamFindings.length > 0 ? [...st.upstreamFindings] : undefined
  const ctx: AnalystContext = {
    runId: plan.runId,
    correlationId: st.correlationId,
    deadlineMs: st.deadlineMs,
    budgetUsd: allocatedUsd,
    costLedger: plan.costLedger ?? undefined,
    costPhase: plan.costPhase ?? undefined,
    chat: plan.chat,
    tags: contextTags,
    log: (message, fields) =>
      plan.log(`[${analyst.id}] ${message}`, {
        runId: plan.runId,
        correlationId: st.correlationId,
        ...fields,
      }),
    signal: st.runSignal,
    priorFindings,
    upstreamFindings: chainedFindings,
    recordUsage: (receipt) => {
      if (!exact) {
        assertValidAnalystUsageReceipt(receipt)
        usageReceipts.push(receipt)
        return
      }
      usageReceipts.push(
        snapshotUsageReceiptOnce(receipt, `AnalystRegistry.runExact analyst "${analyst.id}" usage`),
      )
    },
  }
  if (exact) {
    if (contextTags) deepFreezeCanonicalJson(contextTags)
    if (priorFindings) deepFreezeCanonicalJson(priorFindings)
    if (chainedFindings) deepFreezeCanonicalJson(chainedFindings)
    Object.freeze(ctx)
  }
  return { ctx, usageReceipts, budgetCeilingUsd }
}

/** Run the analyst's own analysis. A failure is recorded; the on-error hook may still contribute findings. */
async function analyzeOne(
  st: PlanRun,
  analyst: Analyst,
  value: unknown,
  analystContext: AnalystContext,
  executionSignal: AbortSignal | undefined,
) {
  const { plan, exact, runSignal } = st
  let findings: AnalystFinding[]
  let lifecycleFailure: unknown
  let analysisFailure: Error | undefined
  try {
    if (runSignal?.aborted) throw abortReason(runSignal)
    const analyzed = await waitForOperation(
      (analyst as Analyst<unknown>).analyze(value, analystContext),
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
  return { findings, analysisFailure, lifecycleFailure }
}

/** The summary of one finished analyst, logged as ok or failed. */
function summarizeAnalyst(
  st: PlanRun,
  analyst: Analyst,
  analysis: { findings: AnalystFinding[]; analysisFailure: Error | undefined },
  usage: AnalystUsageReceipt,
  t0: number,
  effectiveBudget: number | undefined,
): AnalystRunSummary {
  const { plan, exact } = st
  const { findings, analysisFailure } = analysis
  if (analysisFailure === undefined) {
    const summary: AnalystRunSummary = {
      analyst_id: analyst.id,
      status: 'ok',
      findings_count: findings.length,
      latency_ms: Date.now() - t0,
      usage,
      ...(exact ? { allocated_budget_usd: effectiveBudget ?? null } : {}),
    }
    plan.log(`[analyst] ok ${analyst.id}`, {
      runId: plan.runId,
      findings: findings.length,
      latency_ms: summary.latency_ms,
      cost_usd: knownCostUsd(usage),
      cost_kind: usage.cost.kind,
      input_tokens: usage.tokens?.input ?? null,
      output_tokens: usage.tokens?.output ?? null,
    })
    return summary
  }
  const errorClass = analysisFailure.constructor.name || 'Error'
  const errorMessage =
    exact && analysisFailure.message.length === 0
      ? 'Analyst failed without an error message'
      : analysisFailure.message
  const summary: AnalystRunSummary = {
    analyst_id: analyst.id,
    status: 'failed',
    findings_count: findings.length,
    latency_ms: Date.now() - t0,
    usage,
    ...(exact ? { allocated_budget_usd: effectiveBudget ?? null } : {}),
    error: { class: errorClass, message: errorMessage },
  }
  plan.log(`[analyst] FAIL ${analyst.id}`, {
    runId: plan.runId,
    error_class: errorClass,
    error: errorMessage,
    cost_usd: knownCostUsd(usage),
    cost_kind: usage.cost.kind,
  })
  return summary
}

/** One analyst: allocate, run, summarize, and record it on the run. */
async function* runAnalyst(
  st: PlanRun,
  analyst: Analyst,
  input: AnalystExecutionPlan['prepared'][number]['input'],
): AsyncGenerator<AnalystRunEvent, StepOutcome, void> {
  const { plan, exact, runSignal } = st
  const t0 = Date.now()
  if (runSignal?.aborted) return yield* skipAborted(st, analyst, runSignal)
  if (input.kind === 'missing') return yield* skipMissingInput(st, analyst)

  const { ctx, usageReceipts, budgetCeilingUsd } = buildAnalystContext(st, analyst)
  try {
    await waitForHook(
      plan.hooks.onBeforeAnalyze
        ? () => plan.hooks.onBeforeAnalyze?.({ analyst, ctx, runId: plan.runId })
        : undefined,
      runSignal,
    )
  } catch (error) {
    if (!exact) throw error
    st.executionFailure = error
    return 'stop'
  }
  if (runSignal?.aborted) return yield* skipAborted(st, analyst, runSignal, Date.now() - t0)
  let effectiveBudget: number | undefined
  try {
    effectiveBudget = validateEffectiveBudget(ctx.budgetUsd, budgetCeilingUsd, analyst.id)
  } catch (error) {
    if (!exact) throw error
    st.executionFailure = error
    return 'stop'
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

  const analysis = await analyzeOne(st, analyst, input.value, analystContext, executionSignal)
  const { findings, lifecycleFailure } = analysis
  let usage: AnalystUsageReceipt
  try {
    usage = resolveUsage(analyst, usageReceipts, exact)
  } catch (error) {
    if (!exact) throw error
    st.executionFailure = error
    return 'stop'
  }
  const summary = summarizeAnalyst(st, analyst, analysis, usage, t0, effectiveBudget)
  logUncapturedBudgetWarning({
    analyst,
    runId: plan.runId,
    budgetUsd: effectiveBudget,
    usage,
    log: plan.log,
  })

  const execution = {
    summary,
    findings,
    budgetDebitUsd: budgetDebit(summary.usage, effectiveBudget),
  } satisfies AnalystExecution
  if (exact) {
    try {
      executionCost([...st.executions, execution], true)
    } catch (error) {
      st.executionFailure = error
      return 'stop'
    }
  }
  st.executions.push(execution)
  if (plan.budget.kind === 'dynamic' && st.remainingUsd !== undefined) {
    st.remainingUsd = Math.max(0, st.remainingUsd - execution.budgetDebitUsd)
  }
  if (plan.chainFindings) st.upstreamFindings.push(...findings)
  if (lifecycleFailure !== undefined) {
    if (!exact) throw lifecycleFailure
    st.executionFailure = lifecycleFailure
    return 'stop'
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
    st.executionFailure = error
    return 'stop'
  }
  yield snapshotExecutionEvent({ type: 'analyst-completed', summary, findings }, exact)
  if (exact && runSignal?.aborted) {
    st.executionFailure = abortReason(runSignal)
    return 'stop'
  }
  return 'next'
}

/** Assemble the result, run the completion hook, and yield it. A failed exact run throws with its partial receipt. */
async function* finishRun(st: PlanRun): AsyncGenerator<AnalystRunEvent, void, void> {
  const { plan, runSignal, executions } = st
  const summaries = executions.map(({ summary }) => summary)
  const findings = executions.flatMap((execution) => execution.findings)
  const cost = executionCost(executions, st.exact)
  const baseResult: AnalystRunResult = {
    run_id: plan.runId,
    correlation_id: st.correlationId,
    started_at: st.startedAt,
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
  if (st.executionFailure === undefined) {
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
      st.executionFailure = error
    }
  }
  if (runSignal?.aborted) st.executionFailure ??= abortReason(runSignal)
  if (st.executionFailure === undefined && completeResult) {
    yield snapshotExecutionEvent({ type: 'run-completed', result: completeResult }, true)
    return
  }

  const cause =
    st.executionFailure instanceof Error
      ? st.executionFailure
      : new Error(String(st.executionFailure))
  const errorClass = cause.constructor.name || 'Error'
  const errorMessage =
    cause.message.trim().length === 0 ? 'Exact analyst run failed without a message' : cause.message
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

/** Return the analyst's own history, followed by any broadcast findings. */
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
