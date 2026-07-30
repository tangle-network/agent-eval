import { z } from 'zod'
import { canonicalString, deepFreezeCanonicalJson, hashCanonical } from '../ledger-core/canonical'
import type { Analyst, AnalystRunEvent, AnalystRunResult, AnalystRunSummary } from './types'

/** Analyst metadata required before the exact registry path will execute it. */
export interface ExactCapableAnalyst<TInput = unknown> extends Analyst<TInput> {
  /** Canonical JSON for every effective behavior knob not already bound by `version`. */
  readonly executionConfig: Readonly<Record<string, unknown>>
}

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T

export type ExactAnalystSnapshot = DeepReadonly<z.infer<typeof analystSnapshotSchema>>
export type ExactAnalystBudgetSnapshot = DeepReadonly<z.infer<typeof budgetSnapshotSchema>>

/** Caller-provided identity for a component used by an exact run. */
export interface ExactExecutionComponentIdentity {
  id: string
  version: string
  config: Readonly<Record<string, unknown>>
}

/** Persisted identity; configuration is bound by digest and never stored raw. */
export interface ExactExecutionComponentSnapshot {
  id: string
  version: string
  config_digest: string
}

/** Canonical identity for any live component admitted to an exact run. */
export function snapshotExactExecutionComponentIdentity(
  value: ExactExecutionComponentIdentity,
  context: string,
): ExactExecutionComponentSnapshot {
  let detached: unknown
  try {
    detached = JSON.parse(canonicalString(value)) as unknown
  } catch (cause) {
    throw new TypeError(`${context} must have a canonical JSON representation`, { cause })
  }
  const parsed = componentIdentitySchema.safeParse(detached)
  if (!parsed.success) {
    throw new TypeError(`${context} requires non-empty id/version and object config`)
  }
  return deepFreezeCanonicalJson({
    id: parsed.data.id,
    version: parsed.data.version,
    config_digest: hashCanonical(parsed.data.config),
  })
}

export type ExactAnalystRunPolicySnapshot = DeepReadonly<z.infer<typeof exactRunPolicySchema>>
export type ExactAnalystExecutionPlanSnapshot = DeepReadonly<
  z.infer<typeof exactExecutionPlanSchema>
>

export type ExactAnalystRunSummary = AnalystRunSummary & {
  /** Effective caller-owned budget; null means uncapped. Skipped work has no allocation. */
  allocated_budget_usd?: number | null
}

export type ExactAnalystRunCompletion =
  | { status: 'complete' }
  | {
      status: 'failed'
      error: { class: string; message: string }
    }

export interface ExactAnalystRunResult extends AnalystRunResult {
  per_analyst: ExactAnalystRunSummary[]
  execution_plan: ExactAnalystExecutionPlanSnapshot
  completion: ExactAnalystRunCompletion
}

/** Exact events are detached immutable snapshots of the shared serial execution stream. */
export type ExactAnalystRunEvent =
  | (Extract<AnalystRunEvent, { type: 'run-started' }> & {
      execution_plan: ExactAnalystExecutionPlanSnapshot
    })
  | (Omit<Extract<AnalystRunEvent, { type: 'analyst-skipped' }>, 'summary'> & {
      summary: ExactAnalystRunSummary
    })
  | Extract<AnalystRunEvent, { type: 'analyst-started' }>
  | (Omit<Extract<AnalystRunEvent, { type: 'analyst-completed' }>, 'summary'> & {
      summary: ExactAnalystRunSummary
    })
  | (Omit<Extract<AnalystRunEvent, { type: 'run-completed' }>, 'result'> & {
      result: ExactAnalystRunResult
    })

const nonEmptyString = z.string().min(1)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const finiteNonnegative = z.number().finite().nonnegative()
const nonnegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positiveTimeout = z.number().int().positive().max(2_147_483_647)

const componentSnapshotSchema = z.strictObject({
  id: nonEmptyString,
  version: nonEmptyString,
  config_digest: digest,
})
const componentIdentitySchema = z.strictObject({
  id: nonEmptyString,
  version: nonEmptyString,
  config: z.record(z.string(), z.unknown()),
})

const deterministicCostSchema = z.strictObject({
  kind: z.literal('deterministic'),
  est_usd_per_run: finiteNonnegative.optional(),
  models: z.array(nonEmptyString).optional(),
})

const llmCostSchema = z.strictObject({
  kind: z.literal('llm'),
  est_usd_per_run: finiteNonnegative.optional(),
  models: z.array(nonEmptyString).optional(),
  settlement_timeout_ms: nonnegativeSafeInteger.optional(),
})

const requirementsSchema = z
  .strictObject({
    min_shots: nonnegativeSafeInteger.optional(),
    capabilities: z.array(nonEmptyString).optional(),
  })
  .nullable()

const analystSnapshotSchema = z.strictObject({
  id: nonEmptyString,
  version: nonEmptyString,
  input_kind: z.enum(['trace-store', 'artifact-dir', 'run-record', 'judge-input', 'custom']),
  cost: z.discriminatedUnion('kind', [deterministicCostSchema, llmCostSchema]),
  requirements: requirementsSchema,
  execution_config_digest: digest,
})

const allocationsSchema = z.record(nonEmptyString, z.union([finiteNonnegative, z.null()]))
const weightsSchema = z.record(nonEmptyString, finiteNonnegative)
const budgetSnapshotSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('equal'),
    total_usd: finiteNonnegative,
    allocations_usd: allocationsSchema,
  }),
  z.strictObject({
    kind: z.literal('weighted'),
    total_usd: finiteNonnegative,
    weights: weightsSchema,
    allocations_usd: allocationsSchema,
  }),
])

const priorFindingsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('ordered'),
    count: nonnegativeSafeInteger,
    digest,
  }),
  z.strictObject({
    kind: z.literal('by_analyst'),
    keys: z.array(nonEmptyString),
    count: nonnegativeSafeInteger,
    digest,
  }),
])

const exactRunPolicySchema = z.strictObject({
  budget: budgetSnapshotSchema,
  total_timeout_ms: positiveTimeout.nullable(),
  signal_provided: z.boolean(),
  cost_ledger: componentSnapshotSchema.nullable(),
  cost_phase: nonEmptyString.nullable(),
  tags: z.record(z.string(), z.string()).nullable(),
  prior_findings: priorFindingsSchema,
  chain_findings: z.boolean(),
  missing_input_mode: z.enum(['skip', 'abort']),
  registry_hooks: componentSnapshotSchema.nullable(),
  registry_chat: componentSnapshotSchema.nullable(),
})

const exactExecutionPlanSchema = z
  .strictObject({
    schema_version: z.literal('1.0.0'),
    analysts: z.array(analystSnapshotSchema).min(1),
    policy: exactRunPolicySchema,
    digest,
  })
  .superRefine((plan, context) => {
    const issue = (path: PropertyKey[], message: string): void =>
      context.addIssue({ code: 'custom', path, message })
    const analystIds = plan.analysts.map((analyst) => analyst.id)
    if (new Set(analystIds).size !== analystIds.length) {
      issue(['analysts'], 'analyst ids must be unique')
    }
    if (plan.policy.cost_ledger === null && plan.policy.cost_phase !== null) {
      issue(['policy', 'cost_phase'], 'cost phase requires a cost ledger')
    }
    if (
      plan.policy.prior_findings.kind === 'by_analyst' &&
      plan.policy.prior_findings.keys.some(
        (key, index, keys) => index > 0 && key <= keys[index - 1]!,
      )
    ) {
      issue(['policy', 'prior_findings', 'keys'], 'keys must be sorted and unique')
    }

    const budget = plan.policy.budget
    if (budget.kind === 'none') return
    const allocationIds = Object.keys(budget.allocations_usd).sort()
    const selectedIds = [...analystIds].sort()
    if (
      allocationIds.length !== selectedIds.length ||
      allocationIds.some((id, index) => id !== selectedIds[index])
    ) {
      issue(
        ['policy', 'budget', 'allocations_usd'],
        'allocations must name every analyst and no others',
      )
      return
    }
    const runnableIds = analystIds.filter((id) => budget.allocations_usd[id] !== null)
    const epsilon = Math.max(1, budget.total_usd) * Number.EPSILON * 8
    if (runnableIds.length === 0) return

    if (budget.kind === 'weighted') {
      const weightIds = Object.keys(budget.weights).sort()
      if (
        weightIds.length !== selectedIds.length ||
        weightIds.some((id, index) => id !== selectedIds[index])
      ) {
        issue(['policy', 'budget', 'weights'], 'weights must name every analyst and no others')
        return
      }
      const totalWeight = runnableIds.reduce((sum, id) => sum + (budget.weights[id] ?? 0), 0)
      if (totalWeight === 0) {
        issue(['policy', 'budget', 'weights'], 'runnable analysts must have positive total weight')
        return
      }
      for (const id of runnableIds) {
        const expected = (budget.total_usd * (budget.weights[id] ?? 0)) / totalWeight
        if (Math.abs((budget.allocations_usd[id] ?? 0) - expected) > epsilon) {
          issue(
            ['policy', 'budget', 'allocations_usd', id],
            'allocation does not match the weighted policy',
          )
        }
      }
      return
    }

    const expected = budget.total_usd / runnableIds.length
    for (const id of runnableIds) {
      if (Math.abs((budget.allocations_usd[id] ?? 0) - expected) > epsilon) {
        issue(
          ['policy', 'budget', 'allocations_usd', id],
          'allocation does not match the equal policy',
        )
      }
    }
  })

/**
 * Canonicalize and validate the one exact-plan representation shared by execution and archival.
 * Unknown fields fail at every level; the returned graph is detached and deeply frozen.
 */
export function snapshotExactExecutionPlan(
  value: unknown,
  context = 'exact analyst execution plan',
): ExactAnalystExecutionPlanSnapshot {
  let detached: unknown
  try {
    detached = JSON.parse(canonicalString(value)) as unknown
  } catch (cause) {
    throw new TypeError(`${context} must have a canonical JSON representation`, { cause })
  }
  const parsed = exactExecutionPlanSchema.safeParse(detached)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? ` ${issue.path.join('.')}` : ''
    throw new TypeError(`${context}${path}: ${issue?.message ?? 'is invalid'}`)
  }
  const expectedDigest = hashCanonical({
    schema_version: parsed.data.schema_version,
    analysts: parsed.data.analysts,
    policy: parsed.data.policy,
  })
  if (parsed.data.digest !== expectedDigest) {
    throw new TypeError(`${context} digest does not match its content`)
  }
  return deepFreezeCanonicalJson(parsed.data as ExactAnalystExecutionPlanSnapshot)
}
