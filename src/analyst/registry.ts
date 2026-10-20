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

import type { ExactAnalystRunEvent, ExactAnalystRunResult } from './exact-types'
import { normalizeExactPlan } from './registry-exact-plan'
import { executePlanStream } from './registry-execution'
import type { AnalystRegistryOptions, ExactRegistryRunOpts, RegistryRunOpts } from './registry-plan'
import { normalizeLegacyPlan } from './registry-plan'
import type { Analyst, AnalystRunEvent, AnalystRunInputs, AnalystRunResult } from './types'
import { validateUsageSettlementTimeout } from './usage-receipt'

export { ExactAnalystRunExecutionError } from './registry-execution'
export type {
  AnalystHooks,
  AnalystRegistryOptions,
  BudgetPolicy,
  ExactAnalystBudgetPolicy,
  ExactRegistryRunOpts,
  RegistryRunOpts,
} from './registry-plan'

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
    for await (const event of executePlanStream(
      normalizeExactPlan(runId, inputs, runOpts, this.analysts, this.options),
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
    yield* executePlanStream(
      normalizeLegacyPlan(runId, inputs, runOpts, this.analysts, this.options),
    )
  }
}
