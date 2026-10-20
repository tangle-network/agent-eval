/** Registry policy contracts and preparation of the legacy execution plan. */
import type { CostLedgerHandle } from '../cost-ledger'
import type { ChatClient } from './chat-client'
import type {
  ExactAnalystExecutionPlanSnapshot,
  ExactExecutionComponentIdentity,
} from './exact-types'
import { validateBudgetPolicy } from './registry-accounting'
import type {
  Analyst,
  AnalystContext,
  AnalystFinding,
  AnalystRunInputs,
  AnalystRunResult,
  AnalystRunSummary,
} from './types'

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

export type NormalizedBudgetPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'dynamic'; readonly policy: BudgetPolicy }

export interface PreparedAnalyst {
  readonly analyst: Analyst
  readonly input:
    | { readonly kind: 'present'; readonly value: unknown }
    | { readonly kind: 'missing' }
}

export interface AnalystExecutionPlan {
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

export function normalizeLegacyPlan(
  runId: string,
  inputs: AnalystRunInputs,
  runOpts: RegistryRunOpts,
  analysts: ReadonlyMap<string, Analyst>,
  options: AnalystRegistryOptions,
): AnalystExecutionPlan {
  const timeoutMs = validateTimeout(runOpts.timeoutMs) ?? null
  const budget = runOpts.budget ?? options.defaultBudget
  validateBudgetPolicy(budget)
  const selected = selectAnalysts(analysts, runOpts)
  return {
    runId,
    prepared: selected.map((analyst) => ({
      analyst,
      input: routeInput(analyst, inputs),
    })),
    budget: budget ? { kind: 'dynamic', policy: budget } : { kind: 'none' },
    totalTimeoutMs: timeoutMs,
    signal: runOpts.signal ?? null,
    costLedger: runOpts.costLedger ?? null,
    costPhase: runOpts.costPhase ?? null,
    tags: runOpts.tags ?? null,
    priorFindings: runOpts.priorFindings ?? null,
    chainFindings: runOpts.chainFindings ?? false,
    hooks: options.hooks ?? {},
    chat: options.chat,
    log: options.log ?? (() => {}),
    executionSnapshot: undefined,
  }
}

export function routeInput(
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

function selectAnalysts(analysts: ReadonlyMap<string, Analyst>, opts: RegistryRunOpts): Analyst[] {
  let candidates = Array.from(analysts.values())
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

function validateTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError(
      'RegistryRunOpts.timeoutMs must be a positive safe integer no greater than 2147483647',
    )
  }
  return timeoutMs
}
