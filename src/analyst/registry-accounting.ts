/** Registry budget allocation, usage settlement, and cost provenance aggregation. */
import type { CostProvenance } from '../cost-ledger'
import type { RunTokenUsage } from '../run-record'
import type { ExactAnalystExecutionPlanSnapshot } from './exact-types'
import type { BudgetPolicy } from './registry-plan'
import type { Analyst, AnalystFinding, AnalystRunSummary, AnalystUsageReceipt } from './types'

export interface AnalystExecution {
  readonly summary: AnalystRunSummary
  readonly findings: AnalystFinding[]
  readonly budgetDebitUsd: number
}

export function exactPlannedAllocation(
  plan: ExactAnalystExecutionPlanSnapshot,
  analystId: string,
): number | undefined {
  const budget = plan.policy.budget
  if (budget.kind === 'none') return undefined
  const allocated = budget.allocations_usd[analystId]
  return allocated === null ? undefined : allocated
}

export function logUncapturedBudgetWarning(args: {
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

/**
 * Custom allocation takes priority, then weights, then equal shares.
 * Each allocation stays within the unspent overall budget.
 */
export function allocateBudget(
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

export function validateBudgetPolicy(policy: BudgetPolicy | undefined): void {
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

export function validateEffectiveBudget(
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

export function analystWeight(weights: Record<string, number>, analystId: string): number {
  const weight = weights[analystId] ?? 1
  assertBudgetAmount(weight, `BudgetPolicy.weights['${analystId}']`)
  return weight
}

export function zeroUsage(): AnalystUsageReceipt {
  return {
    calls: 0,
    tokens: { input: 0, output: 0 },
    cost: { kind: 'observed', usd: 0 },
  }
}

export function resolveUsage(
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

export function knownCostUsd(receipt: AnalystUsageReceipt): number {
  return receipt.cost.kind === 'uncaptured' ? (receipt.knownCostUsd ?? 0) : receipt.cost.usd
}

export function budgetDebit(
  receipt: AnalystUsageReceipt,
  allocatedUsd: number | undefined,
): number {
  const known = knownCostUsd(receipt)
  return receipt.cost.kind === 'uncaptured' && allocatedUsd !== undefined
    ? Math.max(known, allocatedUsd)
    : known
}

function aggregateCostProvenance(
  costs: ReadonlyArray<CostProvenance>,
  exact = false,
): CostProvenance {
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

export function executionCost(
  executions: ReadonlyArray<AnalystExecution>,
  exact: boolean,
): { known: number; provenance: CostProvenance } {
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
