/**
 * `compareProposers` — a head-to-head lift benchmark across surface proposers
 * on ONE corpus. This is the forcing function: optimizer quality (GEPA
 * reflection vs GEPA+Pareto vs SkillOpt) becomes a NUMBER with a confidence
 * interval, so a proposer regression — or shipping a simplified proposer and
 * calling it the real one — turns a build red instead of going
 * measurement-invisible.
 *
 * Every entrant receives the SAME train + selection partitions and is scored
 * the SAME way: each proposer returns the surface accepted on selection, then
 * the benchmark scores the baseline + every winner on the SAME untouched test
 * scenarios with the SAME judges. Apples-to-apples by construction — the
 * comparison never depends on how a proposer measured itself. The
 * per-scenario test composites feed a paired bootstrap (`statistics.ts`) for
 * each proposer's lift CI and for the pairwise "which proposer wins" CI.
 */

import type { LlmClientOptions } from '../../llm-client'
import { pairedBootstrap } from '../../statistics'
import { defaultProductionGate } from '../gates/default-production-gate'
import {
  type FapoProposerOptions,
  fapoProposer,
  type ParameterCandidate,
  parameterSweepProposer,
} from '../proposers/fapo'
import { gepaProposer } from '../proposers/gepa'
import { skillOptProposer } from '../proposers/skill-opt'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { campaignBreakdown } from '../score-utils'
import type {
  CampaignResult,
  DispatchContext,
  JudgeConfig,
  MutableSurface,
  Scenario,
  SurfaceProposer,
} from '../types'
import { type RunImprovementLoopOptions, runImprovementLoop } from './run-improvement-loop'
import { runSkillOpt } from './run-skill-opt'

/** The adaptive data an optimizer may consume. The untouched test partition
 *  is deliberately absent from this object. */
export interface ProposerOptimizationData<TScenario extends Scenario> {
  /** Evidence used to author or fit candidates. */
  readonly trainScenarios: readonly TScenario[]
  /** Data used for candidate acceptance, early stopping, and model selection. */
  readonly selectionScenarios: readonly TScenario[]
}

/** What an optimizer produced: the surface accepted on selection + what it
 *  cost to get there. The comparison does the untouched test scoring itself. */
export interface ProposerEntry<TScenario extends Scenario = Scenario> {
  name: string
  optimize: (
    data: ProposerOptimizationData<TScenario>,
  ) => Promise<{ winnerSurface: MutableSurface; costUsd: number; durationMs?: number }>
}

export interface ProposerScore {
  name: string
  /** Mean untouched-test composite of the baseline (identical across proposers). */
  baselineComposite: number
  /** Mean untouched-test composite of this proposer's selected surface. */
  winnerComposite: number
  /** Mean per-scenario untouched-test lift (winner − baseline). */
  lift: number
  /** Paired-bootstrap CI of the per-scenario lift. `low > 0` ⇒ a real gain. */
  liftCi: { low: number; high: number }
  costUsd: number
  durationMs?: number
  winnerSurface: MutableSurface
  /** 1-based, by descending lift. */
  rank: number
}

export interface ProposerPairwise {
  /** Higher-ranked proposer. */
  a: string
  b: string
  /** Mean per-scenario untouched-test delta (a − b). */
  deltaMean: number
  low: number
  high: number
  /** `a` if the CI clears 0, `b` if it is entirely negative, else `'tie'`. */
  favored: string
}

export interface ProposerComparison {
  /** Sorted by descending lift; `rank` set accordingly. */
  scores: ProposerScore[]
  best: ProposerScore
  /** Best vs each other proposer, paired-bootstrap on the test winners. */
  pairwise: ProposerPairwise[]
  testScenarioIds: string[]
}

export interface CompareProposersOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch' | 'scenarios'> {
  proposers: ProposerEntry<TScenario>[]
  baselineSurface: MutableSurface
  /** Evidence used by every optimizer to author or fit candidates. */
  trainScenarios: TScenario[]
  /** Candidate acceptance, early-stopping, and optimizer-selection data. */
  selectionScenarios: TScenario[]
  /** Untouched final comparison data. Never passed to a proposer entry. */
  testScenarios: TScenario[]
  /** Scores a surface on a scenario — the same dispatcher the proposers used. */
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: DispatchContext,
  ) => Promise<TArtifact>
  /** Bootstrap resamples for the lift CIs. Default 2000. */
  resamples?: number
  /** CI confidence. Default 0.95. */
  confidence?: number
}

/**
 * Run a head-to-head lift benchmark with disjoint train, selection, and untouched test partitions, returning per-proposer test lift CIs and pairwise "who wins" verdicts.
 */
export async function compareProposers<TScenario extends Scenario, TArtifact>(
  opts: CompareProposersOptions<TScenario, TArtifact>,
): Promise<ProposerComparison> {
  if (opts.proposers.length === 0) throw new Error('compareProposers: no proposers to compare')
  assertComparisonPartitions(opts)
  const seed = opts.seed ?? 42
  const resamples = opts.resamples ?? 2000
  const confidence = opts.confidence ?? 0.95

  const scoreOnTest = async (
    surface: MutableSurface,
    tag: string,
  ): Promise<Record<string, number>> => {
    const campaign: CampaignResult<TArtifact, TScenario> = await runCampaign<TScenario, TArtifact>({
      ...opts,
      scenarios: opts.testScenarios,
      dispatch: (scenario, ctx) => opts.dispatchWithSurface(surface, scenario, ctx),
      runDir: `${opts.runDir}/${tag}`,
    })
    const byScenario: Record<string, number> = {}
    for (const { scenarioId, composite } of campaignBreakdown(campaign).scenarios) {
      byScenario[scenarioId] = composite
    }
    return byScenario
  }

  // The comparison axis is the DESIGNED untouched test set, not whatever a campaign
  // happened to score. Align every score vector to it and FAIL LOUD if a
  // surface is missing any scenario (an errored cell / a judge that returned no
  // score). Fabricating a 0 there would silently penalize that surface and
  // corrupt the paired-bootstrap lift CI — the exact "no silent zeros" trap.
  const scenarioIds = opts.testScenarios.map((s) => s.id).sort()
  const align = (byScenario: Record<string, number>, label: string): number[] => {
    const missing = scenarioIds.filter((id) => !(id in byScenario))
    if (missing.length > 0) {
      throw new Error(
        `compareProposers: ${label} produced no test score for scenario(s) [${missing.join(
          ', ',
        )}] — a cell errored or its judges returned nothing. Refusing to fabricate a 0 (it would corrupt the lift comparison). Fix the dispatch/judge or drop the scenario.`,
      )
    }
    return scenarioIds.map((id) => byScenario[id]!)
  }

  // Entries receive only train + selection. Finish EVERY optimization before
  // the first test dispatch so a later entry cannot observe test-side effects
  // through a shared transport, trace sink, or cache.
  const optimizationData: ProposerOptimizationData<TScenario> = Object.freeze({
    trainScenarios: Object.freeze([...opts.trainScenarios]),
    selectionScenarios: Object.freeze([...opts.selectionScenarios]),
  })
  const optimized: Array<{
    name: string
    winnerSurface: MutableSurface
    costUsd: number
    durationMs?: number
  }> = []
  for (const proposer of opts.proposers) {
    const out = await proposer.optimize(optimizationData)
    optimized.push({
      name: proposer.name,
      winnerSurface: out.winnerSurface,
      costUsd: out.costUsd,
      durationMs: out.durationMs,
    })
  }

  // Only after candidate selection is closed do we open the untouched test
  // partition and uniformly score baseline + every selected winner.
  const baselineArr = align(await scoreOnTest(opts.baselineSurface, 'compare-baseline'), 'baseline')
  const winners: Array<(typeof optimized)[number] & { arr: number[] }> = []
  for (const winner of optimized) {
    const byScenario = await scoreOnTest(winner.winnerSurface, `compare-${slug(winner.name)}`)
    winners.push({
      ...winner,
      arr: align(byScenario, `proposer "${winner.name}"`),
    })
  }

  const scores: ProposerScore[] = winners.map((w) => {
    const boot = pairedBootstrap(baselineArr, w.arr, {
      seed,
      resamples,
      confidence,
      statistic: 'mean',
    })
    const score: ProposerScore = {
      name: w.name,
      baselineComposite: mean(baselineArr),
      winnerComposite: mean(w.arr),
      lift: boot.mean,
      liftCi: { low: boot.low, high: boot.high },
      costUsd: w.costUsd,
      winnerSurface: w.winnerSurface,
      rank: 0,
    }
    if (w.durationMs !== undefined) score.durationMs = w.durationMs
    return score
  })
  // Sort by lift; tie-break by lower cost (cheaper wins a tie).
  scores.sort((a, b) => b.lift - a.lift || a.costUsd - b.costUsd)
  scores.forEach((s, i) => {
    s.rank = i + 1
  })
  const best = scores[0]!

  const byName = new Map(winners.map((w) => [w.name, w]))
  const bestArr = byName.get(best.name)!.arr
  const pairwise: ProposerPairwise[] = scores.slice(1).map((other) => {
    const otherArr = byName.get(other.name)!.arr
    // before = other, after = best ⇒ delta = best − other on the test set.
    const boot = pairedBootstrap(otherArr, bestArr, {
      seed,
      resamples,
      confidence,
      statistic: 'mean',
    })
    const favored = boot.low > 0 ? best.name : boot.high < 0 ? other.name : 'tie'
    return {
      a: best.name,
      b: other.name,
      deltaMean: boot.mean,
      low: boot.low,
      high: boot.high,
      favored,
    }
  })

  return { scores, best, pairwise, testScenarioIds: scenarioIds }
}

function assertComparisonPartitions<TScenario extends Scenario>(
  opts: CompareProposersOptions<TScenario, unknown>,
): void {
  const legacy = opts as CompareProposersOptions<TScenario, unknown> & {
    holdoutScenarios?: unknown
  }
  if (legacy.holdoutScenarios !== undefined) {
    throw new Error(
      'compareProposers: holdoutScenarios is ambiguous and no longer accepted. Provide disjoint trainScenarios, selectionScenarios, and testScenarios; selection may be reused adaptively, test must remain untouched.',
    )
  }

  const partitions: Array<{
    name: 'trainScenarios' | 'selectionScenarios' | 'testScenarios'
    scenarios: TScenario[] | undefined
  }> = [
    { name: 'trainScenarios', scenarios: opts.trainScenarios },
    { name: 'selectionScenarios', scenarios: opts.selectionScenarios },
    { name: 'testScenarios', scenarios: opts.testScenarios },
  ]

  const owner = new Map<string, string>()
  for (const partition of partitions) {
    if (!Array.isArray(partition.scenarios) || partition.scenarios.length === 0) {
      throw new Error(`compareProposers: ${partition.name} is empty`)
    }
    const local = new Set<string>()
    const duplicates = new Set<string>()
    const overlaps = new Map<string, string>()
    for (const scenario of partition.scenarios) {
      if (local.has(scenario.id)) duplicates.add(scenario.id)
      local.add(scenario.id)
      const prior = owner.get(scenario.id)
      if (prior !== undefined && prior !== partition.name) overlaps.set(scenario.id, prior)
    }
    if (duplicates.size > 0) {
      throw new Error(
        `compareProposers: ${partition.name} contains duplicate scenario id(s) [${[
          ...duplicates,
        ].join(', ')}]`,
      )
    }
    if (overlaps.size > 0) {
      const detail = [...overlaps]
        .map(([id, prior]) => `${id} (${prior} ∩ ${partition.name})`)
        .join(', ')
      throw new Error(
        `compareProposers: trainScenarios, selectionScenarios, and testScenarios must be pairwise disjoint; overlap: [${detail}]`,
      )
    }
    for (const id of local) owner.set(id, partition.name)
  }
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

// ── Built-in entries — wire the real optimizers for a live comparison ───────

/** Shared transport and optimizer settings for the built-in entries. Scenario
 *  partitions are owned by `compareProposers` and passed to `optimize()` so a
 *  built-in can never receive the untouched test set. */
export interface BuiltinProposerEntryConfig<TScenario extends Scenario, TArtifact> {
  baselineSurface: string
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: DispatchContext,
  ) => Promise<TArtifact>
  judges: JudgeConfig<TArtifact, TScenario>[]
  llm: LlmClientOptions
  model: string
  target: string
  runDir: string
  seed?: number
  /** GEPA population per generation. Default 2. */
  populationSize?: number
  /** GEPA generations. Default 3. */
  maxGenerations?: number
  /** SkillOpt epochs. Default 6. */
  maxEpochs?: number
  mutationPrimitives?: string[]
  /** Static findings seed forwarded to each GEPA proposer's `propose()` as
   *  `ctx.findings`. Forwarded by `gepaReflectionEntry` / `gepaParetoEntry`;
   *  `skillOptEntry` runs without findings (see its doc). */
  findings?: unknown[]
  /** Per-generation findings producer: after each generation scores, this
   *  re-diagnoses and REPLACES `ctx.findings` for the
   *  next generation's `propose()`. Reuses the `runOptimization` field type so
   *  it cannot drift. GEPA entries only. */
  analyzeGeneration?: RunImprovementLoopOptions<TScenario, TArtifact>['analyzeGeneration']
  /** Optional analysis report forwarded to `propose()` as `ctx.report`. */
  report?: unknown
}

/** @deprecated Use `BuiltinProposerEntryConfig`. */
export type OptimizerEntryConfig<
  TScenario extends Scenario,
  TArtifact,
> = BuiltinProposerEntryConfig<TScenario, TArtifact>

/** GEPA, reflection-only (single-parent, no Pareto combine). */
export function gepaReflectionEntry<TScenario extends Scenario, TArtifact>(
  config: BuiltinProposerEntryConfig<TScenario, TArtifact>,
  name = 'gepa-reflection',
): ProposerEntry<TScenario> {
  return gepaEntry(config, false, name)
}

/** GEPA with the Pareto frontier + combine-complementary-lessons. */
export function gepaParetoEntry<TScenario extends Scenario, TArtifact>(
  config: BuiltinProposerEntryConfig<TScenario, TArtifact>,
  name = 'gepa-pareto',
): ProposerEntry<TScenario> {
  return gepaEntry(config, true, name)
}

function gepaEntry<TScenario extends Scenario, TArtifact>(
  config: BuiltinProposerEntryConfig<TScenario, TArtifact>,
  combineParents: boolean,
  name: string,
): ProposerEntry<TScenario> {
  return {
    name,
    async optimize(data) {
      const started = Date.now()
      const trainScenarios = [...data.trainScenarios]
      const selectionScenarios = [...data.selectionScenarios]
      const proposer = gepaProposer({
        llm: config.llm,
        model: config.model,
        target: config.target,
        combineParents,
        ...(config.mutationPrimitives ? { mutationPrimitives: config.mutationPrimitives } : {}),
      })
      const result = await runImprovementLoop<TScenario, TArtifact>({
        scenarios: trainScenarios,
        holdoutScenarios: selectionScenarios,
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        proposer,
        populationSize: config.populationSize ?? 2,
        maxGenerations: config.maxGenerations ?? 3,
        gate: defaultProductionGate<TArtifact, TScenario>({
          holdoutScenarios: selectionScenarios,
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${config.runDir}/${slug(name)}-loop`,
        ...(config.seed !== undefined ? { seed: config.seed } : {}),
        // Flow findings to the proposer's propose(). These reach runOptimization
        // unchanged (runImprovementLoop extends RunOptimizationOptions and
        // forwards {...opts}); ctx.findings/report/analyzeGeneration are consumed there.
        ...(config.findings !== undefined ? { findings: config.findings } : {}),
        ...(config.analyzeGeneration ? { analyzeGeneration: config.analyzeGeneration } : {}),
        ...(config.report !== undefined ? { report: config.report } : {}),
      })
      const costUsd =
        result.baselineCampaign.aggregates.totalCostUsd +
        result.generations.reduce(
          (sum, g) =>
            sum + g.surfaces.reduce((s, sf) => s + sf.campaign.aggregates.totalCostUsd, 0),
          0,
        )
      return {
        winnerSurface:
          result.gateResult.decision === 'ship' ? result.winnerSurface : config.baselineSurface,
        costUsd,
        durationMs: Date.now() - started,
      }
    },
  }
}

/** SkillOpt patch-mode hill-climb. Runs findings-BLIND: `runSkillOpt` owns its
 *  own epoch acceptance/budget loop and does not thread `analyzeGeneration`, so
 *  `config.findings` is intentionally NOT forwarded here. In a findings-fed
 *  comparison this entry is the blind control — do not read its result as
 *  findings-fed. (Threading findings into the SkillOpt epoch loop is a separate
 *  refactor, deferred not faked.) */
export function skillOptEntry<TScenario extends Scenario, TArtifact>(
  config: BuiltinProposerEntryConfig<TScenario, TArtifact>,
  name = 'skill-opt',
): ProposerEntry<TScenario> {
  return {
    name,
    async optimize(data) {
      const started = Date.now()
      const proposer = skillOptProposer({
        llm: config.llm,
        model: config.model,
        target: config.target,
      })
      const result = await runSkillOpt<TScenario, TArtifact>({
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        proposer,
        trainScenarios: [...data.trainScenarios],
        selectionScenarios: [...data.selectionScenarios],
        maxEpochs: config.maxEpochs ?? 6,
        runDir: `${config.runDir}/${slug(name)}-loop`,
        ...(config.seed !== undefined ? { seed: config.seed } : {}),
      })
      return {
        winnerSurface: result.winnerSurface,
        costUsd: result.totalCostUsd,
        durationMs: Date.now() - started,
      }
    },
  }
}

/** FAPO reviewed-escalation policy. This is an orchestration layer over
 * level-specific proposers, not a new mutation operator:
 * prompt -> parameter -> structural, with scope + reviewer + plateau rules in
 * `fapoProposer`. The prompt proposer defaults to GEPA+Pareto because that is
 * the package's strongest prompt-tier proposer; parameter/structural proposers
 * are opt-in so we do not fake code-generation inside agent-eval. */
export interface FapoEntryConfig<TScenario extends Scenario, TArtifact>
  extends BuiltinProposerEntryConfig<TScenario, TArtifact> {
  /** Override the prompt-level proposer. Default: `gepaProposer({ combineParents: true })`. */
  promptProposer?: SurfaceProposer
  /** Parameter/config-level proposer. If omitted, `parameterCandidates` builds one. */
  parameterProposer?: SurfaceProposer
  /** Structural/code-level proposer, typically supplied by agent-runtime. */
  structuralProposer?: SurfaceProposer
  /** Convenience: build a `parameterSweepProposer` from these candidates. */
  parameterCandidates?: readonly ParameterCandidate[]
  /** FAPO policy knobs: scope, reviewer, plateau thresholds. */
  fapo?: Omit<
    FapoProposerOptions,
    'proposers' | 'promptProposer' | 'parameterProposer' | 'structuralProposer'
  >
}

/**
 * Build a `ProposerEntry` that runs the full FAPO escalation policy (prompt → parameter → structural) as a single comparable optimizer entry.
 */
export function fapoEscalationEntry<TScenario extends Scenario, TArtifact>(
  config: FapoEntryConfig<TScenario, TArtifact>,
  name = 'fapo-escalation',
): ProposerEntry<TScenario> {
  return {
    name,
    async optimize(data) {
      const started = Date.now()
      const trainScenarios = [...data.trainScenarios]
      const selectionScenarios = [...data.selectionScenarios]
      const promptProposer =
        config.promptProposer ??
        gepaProposer({
          llm: config.llm,
          model: config.model,
          target: config.target,
          combineParents: true,
          ...(config.mutationPrimitives ? { mutationPrimitives: config.mutationPrimitives } : {}),
        })
      const parameterProposer =
        config.parameterProposer ??
        (config.parameterCandidates
          ? parameterSweepProposer({ candidates: config.parameterCandidates })
          : undefined)
      const structuralProposer = config.structuralProposer
      const proposer = fapoProposer({
        ...(config.fapo ?? {}),
        promptProposer,
        ...(parameterProposer ? { parameterProposer } : {}),
        ...(structuralProposer ? { structuralProposer } : {}),
      })
      const result = await runImprovementLoop<TScenario, TArtifact>({
        scenarios: trainScenarios,
        holdoutScenarios: selectionScenarios,
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        proposer,
        populationSize: config.populationSize ?? 2,
        maxGenerations: config.maxGenerations ?? 3,
        gate: defaultProductionGate<TArtifact, TScenario>({
          holdoutScenarios: selectionScenarios,
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${config.runDir}/${slug(name)}-loop`,
        ...(config.seed !== undefined ? { seed: config.seed } : {}),
        ...(config.findings !== undefined ? { findings: config.findings } : {}),
        ...(config.analyzeGeneration ? { analyzeGeneration: config.analyzeGeneration } : {}),
        ...(config.report !== undefined ? { report: config.report } : {}),
      })
      const costUsd =
        result.baselineCampaign.aggregates.totalCostUsd +
        result.generations.reduce(
          (sum, g) =>
            sum + g.surfaces.reduce((s, sf) => s + sf.campaign.aggregates.totalCostUsd, 0),
          0,
        )
      return {
        winnerSurface:
          result.gateResult.decision === 'ship' ? result.winnerSurface : config.baselineSurface,
        costUsd,
        durationMs: Date.now() - started,
      }
    },
  }
}
