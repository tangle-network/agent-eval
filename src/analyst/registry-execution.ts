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

export async function* executePlanStream(
  plan: AnalystExecutionPlan,
): AsyncGenerator<AnalystRunEvent, void, void> {
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
