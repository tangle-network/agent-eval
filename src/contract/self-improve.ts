/**
 * # `selfImprove()` — the LAND-tier one-shot.
 *
 * The cheapest possible call site to run a real closed-loop self-
 * improvement over your agent. Wraps `runImprovementLoop` with smart
 * defaults and a budget-shaped options API; every escape hatch the
 * substrate exposes is reachable from here without losing the
 * one-function feel.
 *
 * Defaults picked to match the LAND-tier story:
 *   - In-memory storage (no filesystem touch).
 *   - `gepaDriver` reflective mutation with copywriting-flavored primitives
 *     (override `driver` or `mutationPrimitives` for any domain).
 *   - `defaultProductionGate` with `deltaThreshold: 0.05`.
 *   - Held-out split = 25% of scenarios, deterministic by id hash.
 *   - 3 generations × population 2 (raise via `budget` for more search).
 *   - `autoOnPromote: 'none'` (we don't open PRs unless you ask).
 *
 * Want one-click? Provide `agent` + `scenarios` + `judge`. Done.
 * Want distributed? Pass `cellPlacement` + an `httpDispatch`-backed
 * agent. Want a code-tier surface? Pass a `MutableSurface` + your own
 * `driver`. Same function.
 */

import { gepaDriver } from '../campaign/drivers/gepa'
import { defaultProductionGate } from '../campaign/gates/default-production-gate'
import {
  type RunImprovementLoopResult,
  runImprovementLoop,
} from '../campaign/presets/run-improvement-loop'
import { type CampaignStorage, inMemoryCampaignStorage } from '../campaign/storage'
import type {
  DispatchContext,
  Gate,
  ImprovementDriver,
  JudgeConfig,
  MutableSurface,
  Scenario,
} from '../campaign/types'

export interface SelfImproveBudget {
  /** Hard $ ceiling across all cells in baseline + every generation. Cells
   *  beyond the ceiling are skipped (cost-aware, not aborted). */
  dollars?: number
  /** How many improvement generations to explore. Default 3. Set 0 to
   *  skip improvement entirely (selfImprove becomes a baseline-only run). */
  generations?: number
  /** Candidates the driver proposes per generation. Default 2. */
  populationSize?: number
  /** Max concurrent cells across the loop. Default 2. */
  maxConcurrency?: number
  /** Fraction of `scenarios` held out from training, used for the gate.
   *  Default 0.25. Ignored when `holdoutScenarios` is set explicitly. */
  holdoutFraction?: number
  /** Explicit held-out scenarios; overrides `holdoutFraction`. */
  holdoutScenarios?: Scenario[]
}

export interface SelfImproveLlm {
  /** Endpoint base URL. Default Tangle Router. */
  baseUrl?: string
  /** Bearer token. Default `process.env.OPENAI_API_KEY`. */
  apiKey?: string
  /** Model id used by `gepaDriver` reflection. Default
   *  `anthropic/claude-sonnet-4.6`. */
  model?: string
}

export type SelfImproveProgressEvent =
  | { kind: 'baseline.started'; scenarios: number }
  | { kind: 'baseline.completed'; compositeMean: number; durationMs: number }
  | { kind: 'generation.started'; index: number; populationSize: number }
  | { kind: 'generation.completed'; index: number; bestComposite: number; durationMs: number }
  | { kind: 'gate.decided'; decision: string; lift: number }

export interface SelfImproveOptions<TScenario extends Scenario, TArtifact> {
  /**
   * Your agent — a function that takes the current `MutableSurface`
   * (typically a system prompt the loop is optimizing) plus the
   * scenario + cell ctx, and returns the artifact your judge scores.
   *
   * Same shape as `RunOptimizationOptions.dispatchWithSurface`. Wrap a
   * plain `Dispatch` if you don't have a surface seam:
   *
   *   agent: (_surface, scenario, ctx) => yourPlainDispatch(scenario, ctx)
   *
   * That mode evaluates without mutating any surface — useful as a
   * baseline-only run (set `budget.generations = 0`).
   */
  agent: (surface: MutableSurface, scenario: TScenario, ctx: DispatchContext) => Promise<TArtifact>

  /** Scenarios to evaluate against. Train/holdout split is computed from
   *  these unless `budget.holdoutScenarios` is set explicitly. */
  scenarios: TScenario[]

  /** Judge that scores artifacts. Bring your own; use `langchainJudge`
   *  from `/adapters/langchain` for a Runnable-shaped one. */
  judge: JudgeConfig<TArtifact, TScenario>

  /** Starting surface — system prompt, JSON config, anything `MutableSurface`
   *  accepts. The driver mutates this each generation. */
  baselineSurface: MutableSurface

  /** Budget + loop shape. All fields optional; defaults pick the LAND-tier
   *  story. */
  budget?: SelfImproveBudget

  /** Custom driver. Default is `gepaDriver` configured from `llm` +
   *  `mutationPrimitives`. */
  driver?: ImprovementDriver

  /** Default-driver overrides — used when `driver` is unset. */
  mutationPrimitives?: string[]
  driverTarget?: string

  /** Custom gate. Default is `defaultProductionGate` with
   *  `deltaThreshold: 0.05` on the held-out split. */
  gate?: Gate<TArtifact, TScenario>

  /** LLM config consumed by the default `gepaDriver`. Ignored if you pass
   *  your own `driver`. */
  llm?: SelfImproveLlm

  /** Storage backend. Default `inMemoryCampaignStorage()` — nothing
   *  persists past the call. Pass `fsCampaignStorage()` to write to disk. */
  storage?: CampaignStorage

  /** Run directory (logical for in-memory storage, real path for fs).
   *  Default `mem://selfImprove-<timestamp>`. */
  runDir?: string

  /** Distributed-driver seam — same as `RunCampaignOptions.cellPlacement`.
   *  Returns an opaque placement key the substrate forwards to your agent
   *  as `ctx.placement`. Combined with `httpDispatch` from
   *  `/adapters/http`, fans cells across regions. */
  cellPlacement?: (input: {
    scenario: TScenario
    rep: number
    generation?: number
  }) => string | undefined

  /** Streaming hook — fires on baseline + each generation + gate decision.
   *  Consumer routes events wherever (UI, dashboard, logs). */
  onProgress?: (event: SelfImproveProgressEvent) => void

  /** Auto-promotion behavior on a ship decision. Default `'none'` — we
   *  return the winner; you ship it however you ship. `'pr'` opens a
   *  GitHub PR via `openAutoPr`; requires `ghOwner` + `ghRepo`. */
  autoOnPromote?: 'pr' | 'none'
  ghOwner?: string
  ghRepo?: string
}

export interface SelfImproveResult<TScenario extends Scenario, TArtifact> {
  /** Composite mean across all scenarios, baseline run. */
  baseline: {
    compositeMean: number
    perScenario: Record<string, number>
  }
  /** Composite mean on the held-out set, winner run. */
  winner: {
    compositeMean: number
    perScenario: Record<string, number>
    surface: MutableSurface
  }
  /** `winner.compositeMean - baselineOnHoldout.compositeMean`. Positive
   *  means the gate observed improvement. */
  lift: number
  /** `defaultProductionGate.decide()` result. */
  gateDecision: 'ship' | 'hold' | 'need_more_work' | 'model_ceiling' | 'arch_ceiling'
  /** Number of generations actually explored (may be less than the
   *  budget if the driver gave up early). */
  generationsExplored: number
  /** Wall-clock total. */
  durationMs: number
  /** Total cost across baseline + every generation. */
  totalCostUsd: number
  /**
   * Raw substrate result for advanced inspection — full per-generation
   * candidates, full campaign artifacts, all judge scores. Useful for
   * debugging or reporting beyond the summary.
   */
  raw: RunImprovementLoopResult<TArtifact, TScenario>
}

/**
 * Deterministic train/holdout split by a stable hash of `scenario.id`,
 * so the same scenario set always splits the same way across runs.
 */
function splitTrainHoldout<TScenario extends Scenario>(
  scenarios: TScenario[],
  fraction: number,
): { train: TScenario[]; holdout: TScenario[] } {
  // Stable fnv-1a-ish hash of the id for ordering.
  function hash(s: string): number {
    let h = 2166136261 >>> 0
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    return h
  }
  const sorted = [...scenarios].sort((a, b) => hash(a.id) - hash(b.id))
  const nHoldout = Math.max(1, Math.min(sorted.length - 1, Math.round(sorted.length * fraction)))
  return {
    holdout: sorted.slice(0, nHoldout),
    train: sorted.slice(nHoldout),
  }
}

function meanComposite(byScenario: Record<string, { meanComposite: number }>): {
  compositeMean: number
  perScenario: Record<string, number>
} {
  const perScenario: Record<string, number> = {}
  const values: number[] = []
  for (const [id, agg] of Object.entries(byScenario)) {
    perScenario[id] = agg.meanComposite
    values.push(agg.meanComposite)
  }
  return {
    compositeMean: values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length,
    perScenario,
  }
}

const DEFAULT_MUTATION_PRIMITIVES = [
  'Tighten the hook: lead with the specific user outcome.',
  'Replace generic adjectives with specific verbs or proof numbers.',
  "Anchor every claim in something the scenario's brief literally supports.",
  'Honor the surface-shape constraint (length, register, audience vocabulary).',
]

/**
 * One-shot self-improvement loop. See module docstring for defaults +
 * extension points.
 *
 * @example Minimum (LAND tier):
 *
 *   const result = await selfImprove({
 *     agent: (surface, scenario, ctx) => myAgent(surface, scenario, ctx.signal),
 *     scenarios,
 *     judge,
 *     baselineSurface: DEFAULT_PROMPT,
 *   })
 *   console.log(`lift: ${result.lift.toFixed(3)} (${result.gateDecision})`)
 *
 * @example Distributed (workers in three regions):
 *
 *   await selfImprove({
 *     agent: httpDispatch({ resolveUrl: ({ placement }) => REGION_URLS[placement!] }),
 *     scenarios,
 *     judge,
 *     baselineSurface: DEFAULT_PROMPT,
 *     cellPlacement: ({ scenario }) => scenario.region,
 *     budget: { maxConcurrency: 12 },
 *   })
 */
export async function selfImprove<TScenario extends Scenario, TArtifact>(
  opts: SelfImproveOptions<TScenario, TArtifact>,
): Promise<SelfImproveResult<TScenario, TArtifact>> {
  const startedAt = Date.now()

  const budget = opts.budget ?? {}
  const generations = budget.generations ?? 3
  const populationSize = budget.populationSize ?? 2
  const maxConcurrency = budget.maxConcurrency ?? 2
  const holdoutFraction = budget.holdoutFraction ?? 0.25
  const costCeiling = budget.dollars

  const explicitHoldout = budget.holdoutScenarios
  const { train, holdout } = explicitHoldout
    ? {
        train: opts.scenarios.filter((s) => !explicitHoldout.some((h) => h.id === s.id)),
        holdout: explicitHoldout as TScenario[],
      }
    : splitTrainHoldout(opts.scenarios, holdoutFraction)

  if (train.length === 0) {
    throw new Error(
      'selfImprove: train split is empty. Reduce holdoutFraction or pass more scenarios.',
    )
  }
  if (holdout.length === 0) {
    throw new Error('selfImprove: holdout split is empty. Pass more scenarios.')
  }

  const driver: ImprovementDriver =
    opts.driver ??
    gepaDriver({
      llm: {
        baseUrl: opts.llm?.baseUrl ?? 'https://router.tangle.tools/v1',
        apiKey: opts.llm?.apiKey ?? process.env.OPENAI_API_KEY ?? '',
      },
      model: opts.llm?.model ?? 'anthropic/claude-sonnet-4.6',
      target:
        opts.driverTarget ??
        'agent surface (system prompt or config) being optimized by selfImprove',
      mutationPrimitives: opts.mutationPrimitives ?? DEFAULT_MUTATION_PRIMITIVES,
    })

  const gate: Gate<TArtifact, TScenario> =
    opts.gate ??
    defaultProductionGate<TArtifact, TScenario>({
      holdoutScenarios: holdout,
      deltaThreshold: 0.05,
    })

  const storage = opts.storage ?? inMemoryCampaignStorage()
  const runDir = opts.runDir ?? `mem://selfImprove-${startedAt}`

  if (opts.onProgress) {
    opts.onProgress({ kind: 'baseline.started', scenarios: opts.scenarios.length })
  }

  const result = await runImprovementLoop<TScenario, TArtifact>({
    scenarios: train,
    baselineSurface: opts.baselineSurface,
    dispatchWithSurface: opts.agent,
    driver,
    judges: [opts.judge],
    populationSize,
    maxGenerations: generations,
    holdoutScenarios: holdout,
    gate,
    autoOnPromote: opts.autoOnPromote ?? 'none',
    ghOwner: opts.ghOwner,
    ghRepo: opts.ghRepo,
    storage,
    runDir,
    maxConcurrency,
    cellPlacement: opts.cellPlacement,
    costCeiling,
  })

  const baseline = meanComposite(result.baselineOnHoldout.aggregates.byScenario)
  const winnerStats = meanComposite(result.winnerOnHoldout.aggregates.byScenario)

  if (opts.onProgress) {
    opts.onProgress({
      kind: 'baseline.completed',
      compositeMean: baseline.compositeMean,
      durationMs: Date.now() - startedAt,
    })
    opts.onProgress({
      kind: 'gate.decided',
      decision: result.gateResult.decision,
      lift: winnerStats.compositeMean - baseline.compositeMean,
    })
  }

  const totalCost =
    result.baselineCampaign.aggregates.totalCostUsd +
    result.generations.reduce(
      (sum, gen) =>
        sum + gen.surfaces.reduce((s, sf) => s + sf.campaign.aggregates.totalCostUsd, 0),
      0,
    )

  return {
    baseline,
    winner: {
      ...winnerStats,
      surface: result.winnerSurface,
    },
    lift: winnerStats.compositeMean - baseline.compositeMean,
    gateDecision: result.gateResult.decision,
    generationsExplored: result.generations.length,
    durationMs: Date.now() - startedAt,
    totalCostUsd: totalCost,
    raw: result,
  }
}
