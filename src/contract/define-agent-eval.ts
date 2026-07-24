import type { RunEvalOptions } from '../campaign/presets/run-eval'
import { runEval } from '../campaign/presets/run-eval'
import { inMemoryCampaignStorage } from '../campaign/storage'
import type {
  CampaignResult,
  DispatchContext,
  JudgeConfig,
  MutableSurface,
  Scenario,
} from '../campaign/types'
import type { HostedTenant } from '../hosted/client'
import {
  type SelfImproveBudget,
  type SelfImproveOptions,
  type SelfImproveResult,
  selfImprove,
} from './self-improve'

export type AgentEvalAgent<TScenario extends Scenario, TArtifact> = (
  surface: MutableSurface,
  scenario: TScenario,
  ctx: DispatchContext,
) => Promise<TArtifact>

export type DefineAgentEvalOptions<TScenario extends Scenario, TArtifact> = SelfImproveOptions<
  TScenario,
  TArtifact
>

export interface AgentEvalEvaluateOptions<TScenario extends Scenario, TArtifact>
  extends Omit<
    RunEvalOptions<TScenario, TArtifact>,
    'dispatch' | 'judges' | 'runDir' | 'scenarios'
  > {
  /** Scenario set to evaluate. Defaults to the scenarios passed to `defineAgentEval`. */
  scenarios?: TScenario[]
  /** Surface to evaluate. Defaults to the baseline surface passed to `defineAgentEval`. */
  surface?: MutableSurface
  /** Agent to evaluate. Defaults to the agent passed to `defineAgentEval`. */
  agent?: AgentEvalAgent<TScenario, TArtifact>
  /** Single judge override. Ignored when `judges` is set. */
  judge?: JudgeConfig<TArtifact, TScenario>
  /** Full judge list override. Defaults to the single judge passed to `defineAgentEval`. */
  judges?: JudgeConfig<TArtifact, TScenario>[]
  /** Logical or filesystem run directory. Defaults to an in-memory run. */
  runDir?: string
}

export type AgentEvalImproveOptions<TScenario extends Scenario, TArtifact> = Omit<
  Partial<SelfImproveOptions<TScenario, TArtifact>>,
  'budget' | 'hostedTenant'
> & {
  budget?: Partial<SelfImproveBudget>
  hostedTenant?: Partial<HostedTenant>
}

export interface DefinedAgentEval<TScenario extends Scenario, TArtifact> {
  /** The default scenarios used by `evaluate()` and `improve()`. */
  readonly scenarios: readonly TScenario[]
  /** The default baseline surface used by `evaluate()` and `improve()`. */
  readonly baselineSurface: MutableSurface
  /**
   * Run one scored evaluation. Use this for a baseline score or to score one
   * candidate surface without running an improvement loop.
   */
  evaluate(
    opts?: AgentEvalEvaluateOptions<TScenario, TArtifact>,
  ): Promise<CampaignResult<TArtifact, TScenario>>
  /**
   * Run the closed improvement loop. Per-call overrides replace the definition
   * except for nested config objects (`budget`, `hostedTenant`), which
   * are merged field-by-field so callers can override one knob without
   * repeating secrets or budget defaults.
   */
  improve(
    opts?: AgentEvalImproveOptions<TScenario, TArtifact>,
  ): Promise<SelfImproveResult<TScenario, TArtifact>>
}

/**
 * Define an agent eval once, then either score a surface with `evaluate()` or
 * run the closed loop with `improve()`.
 *
 * This is a DX wrapper only: it delegates to `runEval()` and `selfImprove()` and
 * returns their native result shapes.
 */
export function defineAgentEval<TScenario extends Scenario, TArtifact>(
  defaults: DefineAgentEvalOptions<TScenario, TArtifact>,
): DefinedAgentEval<TScenario, TArtifact> {
  const defaultEvaluateOptions = evaluateDefaults(defaults)

  return {
    scenarios: defaults.scenarios,
    baselineSurface: defaults.baselineSurface,

    async evaluate(opts = {}) {
      const { agent, judge, judges, runDir, scenarios, surface, ...campaignOpts } = opts
      const selectedAgent = agent ?? defaults.agent
      const selectedSurface = surface ?? defaults.baselineSurface
      const selectedRunDir = runDir ?? defaults.runDir ?? `mem://defineAgentEval-${Date.now()}`
      const selectedStorage =
        campaignOpts.storage ??
        defaultEvaluateOptions.storage ??
        (selectedRunDir.startsWith('mem://') ? inMemoryCampaignStorage() : undefined)
      const evalOptions: RunEvalOptions<TScenario, TArtifact> = {
        ...defaultEvaluateOptions,
        ...campaignOpts,
        ...(selectedStorage ? { storage: selectedStorage } : {}),
        runDir: selectedRunDir,
        scenarios: scenarios ?? defaults.scenarios,
        dispatch: (scenario, ctx) => selectedAgent(selectedSurface, scenario, ctx),
        judges: evaluateJudges(judges, judge ?? defaults.judge),
      }
      if (evalOptions.reps !== undefined)
        evalOptions.reps = requirePositiveInteger(evalOptions.reps, 'reps')
      return runEval<TScenario, TArtifact>(evalOptions)
    },

    async improve(opts = {}) {
      const {
        budget: budgetOverride,
        hostedTenant: hostedTenantOverride,
        ...topLevelOverrides
      } = opts
      const merged = mergeDefined(defaults, topLevelOverrides)
      const budget = mergeBudget(defaults.budget, budgetOverride)
      const hostedTenant = mergeHostedTenant(defaults.hostedTenant, hostedTenantOverride)
      return selfImprove<TScenario, TArtifact>({
        ...merged,
        ...(budget ? { budget } : {}),
        ...(hostedTenant ? { hostedTenant } : {}),
      })
    },
  }
}

type SharedEvaluateDefaults<TScenario extends Scenario, TArtifact> = Omit<
  RunEvalOptions<TScenario, TArtifact>,
  'dispatch' | 'judges' | 'runDir' | 'scenarios'
>

function evaluateDefaults<TScenario extends Scenario, TArtifact>(
  defaults: DefineAgentEvalOptions<TScenario, TArtifact>,
): SharedEvaluateDefaults<TScenario, TArtifact> {
  const out: SharedEvaluateDefaults<TScenario, TArtifact> = {}
  if (defaults.storage) out.storage = defaults.storage
  if (defaults.labeledStore) out.labeledStore = defaults.labeledStore
  if (defaults.captureSource) out.captureSource = defaults.captureSource
  if (defaults.cellPlacement) out.cellPlacement = defaults.cellPlacement
  if (defaults.expectUsage) out.expectUsage = defaults.expectUsage
  if (defaults.budget?.dollars !== undefined) out.costCeiling = defaults.budget.dollars
  if (defaults.budget?.maxConcurrency !== undefined)
    out.maxConcurrency = defaults.budget.maxConcurrency
  if (defaults.budget?.reps !== undefined)
    out.reps = requirePositiveInteger(defaults.budget.reps, 'budget.reps')
  return out
}

function mergeBudget(
  defaults: SelfImproveBudget | undefined,
  overrides: Partial<SelfImproveBudget> | undefined,
): SelfImproveBudget | undefined {
  const merged = mergeOptionalObject(defaults, overrides)
  if (merged?.reps !== undefined) merged.reps = requirePositiveInteger(merged.reps, 'budget.reps')
  return merged
}

function mergeHostedTenant(
  defaults: HostedTenant | undefined,
  overrides: Partial<HostedTenant> | undefined,
): HostedTenant | undefined {
  const merged = mergeOptionalObject(defaults, overrides)
  if (!merged) return undefined
  if (!merged.endpoint?.trim() || !merged.apiKey?.trim() || !merged.tenantId?.trim()) {
    throw new Error(
      'defineAgentEval.improve: hostedTenant requires endpoint, apiKey, and tenantId after merging defaults and overrides',
    )
  }
  return merged
}

function mergeDefined<T extends object>(defaults: T, overrides: Partial<T> | undefined): T {
  if (!overrides) return defaults
  const merged = { ...defaults } as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value
  }
  return merged as T
}

function mergeOptionalObject<T extends object>(
  defaults: T | undefined,
  overrides: Partial<T> | undefined,
): T | undefined {
  if (!defaults && !overrides) return undefined
  return mergeDefined(defaults ?? ({} as T), overrides)
}

function evaluateJudges<TArtifact, TScenario extends Scenario>(
  judges: JudgeConfig<TArtifact, TScenario>[] | undefined,
  defaultJudge: JudgeConfig<TArtifact, TScenario>,
): JudgeConfig<TArtifact, TScenario>[] {
  if (judges !== undefined) {
    if (judges.length === 0) {
      throw new Error('defineAgentEval.evaluate: judges must not be empty')
    }
    return judges
  }
  return [defaultJudge]
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`defineAgentEval: ${field} must be a positive integer`)
  }
  return value
}
