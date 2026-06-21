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

export type AgentEvalImproveOptions<TScenario extends Scenario, TArtifact> = Partial<
  SelfImproveOptions<TScenario, TArtifact>
>

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
   * Run the closed improvement loop. Per-call overrides are shallow-merged with
   * the definition; `budget` is merged field-by-field so callers can override
   * one budget knob without repeating the rest.
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
        judges: judges ?? [judge ?? defaults.judge],
      }
      return runEval<TScenario, TArtifact>(evalOptions)
    },

    async improve(opts) {
      const merged = mergeDefined(defaults, opts)
      const budget = mergeBudget(defaults.budget, opts?.budget)
      return selfImprove<TScenario, TArtifact>({
        ...merged,
        ...(budget ? { budget } : {}),
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
  if (defaults.budget?.reps !== undefined) out.reps = defaults.budget.reps
  return out
}

function mergeBudget(
  defaults: SelfImproveBudget | undefined,
  overrides: SelfImproveBudget | undefined,
): SelfImproveBudget | undefined {
  if (!defaults && !overrides) return undefined
  return mergeDefined(defaults ?? {}, overrides)
}

function mergeDefined<T extends object>(defaults: T, overrides: Partial<T> | undefined): T {
  if (!overrides) return defaults
  const merged = { ...defaults } as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value
  }
  return merged as T
}
