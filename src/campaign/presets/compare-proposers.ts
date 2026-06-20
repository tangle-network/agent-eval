/**
 * @experimental
 *
 * `compareProposers` — a head-to-head lift benchmark across surface proposers
 * on ONE corpus. This is the forcing function: optimizer quality (GEPA
 * reflection vs GEPA+Pareto vs SkillOpt) becomes a NUMBER with a confidence
 * interval, so a proposer regression — or shipping a simplified proposer and
 * calling it the real one — turns a build red instead of going
 * measurement-invisible.
 *
 * Every entrant is scored the SAME way: each proposer returns the surface it
 * promoted, then the benchmark scores the baseline + every winner on the
 * SAME held-out scenarios with the SAME judges. Apples-to-apples by
 * construction — the comparison never depends on how a proposer measured itself.
 * The per-scenario held-out composites feed a paired bootstrap (`statistics.ts`)
 * for each proposer's lift CI and for the pairwise "which proposer wins" CI.
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

/** What an optimizer produced: the surface it promoted + what it cost to get
 *  there. The comparison does the held-out scoring itself, so an entry only
 *  needs to run its loop and hand back the winner. */
export interface ProposerEntry {
  name: string
  optimize: () => Promise<{ winnerSurface: MutableSurface; costUsd: number; durationMs?: number }>
}

export interface ProposerScore {
  name: string
  /** Mean held-out composite of the baseline (identical across proposers). */
  baselineComposite: number
  /** Mean held-out composite of this proposer's promoted surface. */
  winnerComposite: number
  /** Mean per-scenario held-out lift (winner − baseline). */
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
  /** Mean per-scenario held-out delta (a − b). */
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
  /** Best vs each other proposer, paired-bootstrap on the held-out winners. */
  pairwise: ProposerPairwise[]
  holdoutScenarioIds: string[]
}

export interface CompareProposersOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch' | 'scenarios'> {
  proposers: ProposerEntry[]
  baselineSurface: MutableSurface
  /** The held-out scenarios every winner is scored on. */
  holdoutScenarios: TScenario[]
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

export async function compareProposers<TScenario extends Scenario, TArtifact>(
  opts: CompareProposersOptions<TScenario, TArtifact>,
): Promise<ProposerComparison> {
  return compareProposerEntries(opts)
}

async function compareProposerEntries<TScenario extends Scenario, TArtifact>(
  opts: CompareProposersOptions<TScenario, TArtifact>,
): Promise<ProposerComparison> {
  if (opts.proposers.length === 0) throw new Error('compareProposers: no proposers to compare')
  const seed = opts.seed ?? 42
  const resamples = opts.resamples ?? 2000
  const confidence = opts.confidence ?? 0.95

  const scoreOnHoldout = async (
    surface: MutableSurface,
    tag: string,
  ): Promise<Record<string, number>> => {
    const campaign: CampaignResult<TArtifact, TScenario> = await runCampaign<TScenario, TArtifact>({
      ...opts,
      scenarios: opts.holdoutScenarios,
      dispatch: (scenario, ctx) => opts.dispatchWithSurface(surface, scenario, ctx),
      runDir: `${opts.runDir}/${tag}`,
    })
    const byScenario: Record<string, number> = {}
    for (const { scenarioId, composite } of campaignBreakdown(campaign).scenarios) {
      byScenario[scenarioId] = composite
    }
    return byScenario
  }

  // The comparison axis is the DESIGNED held-out set, not whatever a campaign
  // happened to score. Align every score vector to it and FAIL LOUD if a
  // surface is missing any scenario (an errored cell / a judge that returned no
  // score). Fabricating a 0 there would silently penalize that surface and
  // corrupt the paired-bootstrap lift CI — the exact "no silent zeros" trap.
  const scenarioIds = [...new Set(opts.holdoutScenarios.map((s) => s.id))].sort()
  if (scenarioIds.length === 0) throw new Error('compareProposers: holdoutScenarios is empty')
  const align = (byScenario: Record<string, number>, label: string): number[] => {
    const missing = scenarioIds.filter((id) => !(id in byScenario))
    if (missing.length > 0) {
      throw new Error(
        `compareProposers: ${label} produced no held-out score for scenario(s) [${missing.join(
          ', ',
        )}] — a cell errored or its judges returned nothing. Refusing to fabricate a 0 (it would corrupt the lift comparison). Fix the dispatch/judge or drop the scenario.`,
      )
    }
    return scenarioIds.map((id) => byScenario[id]!)
  }

  const baselineArr = align(
    await scoreOnHoldout(opts.baselineSurface, 'compare-baseline'),
    'baseline',
  )

  // Run + uniformly re-score every entrant on the SAME held-out axis.
  const winners: Array<{
    name: string
    winnerSurface: MutableSurface
    costUsd: number
    durationMs?: number
    arr: number[]
  }> = []
  for (const proposer of opts.proposers) {
    const out = await proposer.optimize()
    const byScenario = await scoreOnHoldout(out.winnerSurface, `compare-${slug(proposer.name)}`)
    winners.push({
      name: proposer.name,
      winnerSurface: out.winnerSurface,
      costUsd: out.costUsd,
      durationMs: out.durationMs,
      arr: align(byScenario, `proposer "${proposer.name}"`),
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
    // before = other, after = best ⇒ delta = best − other on the held-out set.
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

  return { scores, best, pairwise, holdoutScenarioIds: scenarioIds }
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

// ── Built-in entries — wire the real optimizers for a live comparison ───────

/** Shared corpus + transport for the three built-in optimizer entries. */
export interface OptimizerEntryConfig<TScenario extends Scenario, TArtifact> {
  baselineSurface: string
  /** Training scenarios the proposers reflect on. */
  trainScenarios: TScenario[]
  /** Held-out scenarios (the gate axis + the benchmark scoring axis). */
  holdoutScenarios: TScenario[]
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
   *  `ctx.findings` (the EYES→HANDS wire). Forwarded by `gepaReflectionEntry` /
   *  `gepaParetoEntry`; `skillOptEntry` runs findings-BLIND (see its doc). */
  findings?: unknown[]
  /** Per-generation findings producer (EYES→HANDS loop closure): after each
   *  generation scores, this re-diagnoses and REPLACES `ctx.findings` for the
   *  next generation's `propose()`. Reuses the `runOptimization` field type so
   *  it cannot drift. GEPA entries only. */
  analyzeGeneration?: RunImprovementLoopOptions<TScenario, TArtifact>['analyzeGeneration']
  /** Phase-2 research report forwarded to `propose()` as `ctx.report`. */
  report?: unknown
}

/** GEPA, reflection-only (single-parent, no Pareto combine). */
export function gepaReflectionEntry<TScenario extends Scenario, TArtifact>(
  config: OptimizerEntryConfig<TScenario, TArtifact>,
  name = 'gepa-reflection',
): ProposerEntry {
  return gepaEntry(config, false, name)
}

/** GEPA with the Pareto frontier + combine-complementary-lessons. */
export function gepaParetoEntry<TScenario extends Scenario, TArtifact>(
  config: OptimizerEntryConfig<TScenario, TArtifact>,
  name = 'gepa-pareto',
): ProposerEntry {
  return gepaEntry(config, true, name)
}

function gepaEntry<TScenario extends Scenario, TArtifact>(
  config: OptimizerEntryConfig<TScenario, TArtifact>,
  combineParents: boolean,
  name: string,
): ProposerEntry {
  return {
    name,
    async optimize() {
      const started = Date.now()
      const proposer = gepaProposer({
        llm: config.llm,
        model: config.model,
        target: config.target,
        combineParents,
        ...(config.mutationPrimitives ? { mutationPrimitives: config.mutationPrimitives } : {}),
      })
      const result = await runImprovementLoop<TScenario, TArtifact>({
        scenarios: config.trainScenarios,
        holdoutScenarios: config.holdoutScenarios,
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        proposer,
        populationSize: config.populationSize ?? 2,
        maxGenerations: config.maxGenerations ?? 3,
        gate: defaultProductionGate<TArtifact, TScenario>({
          holdoutScenarios: config.holdoutScenarios,
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${config.runDir}/${slug(name)}-loop`,
        ...(config.seed !== undefined ? { seed: config.seed } : {}),
        // EYES→HANDS: flow findings to the proposer's propose(). These reach
        // runOptimization unchanged (runImprovementLoop extends RunOptimizationOptions
        // and forwards {...opts}); ctx.findings/report/analyzeGeneration are consumed there.
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
      return { winnerSurface: result.winnerSurface, costUsd, durationMs: Date.now() - started }
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
  config: OptimizerEntryConfig<TScenario, TArtifact>,
  name = 'skill-opt',
): ProposerEntry {
  return {
    name,
    async optimize() {
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
        trainScenarios: config.trainScenarios,
        holdoutScenarios: config.holdoutScenarios,
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
  extends OptimizerEntryConfig<TScenario, TArtifact> {
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

export function fapoEscalationEntry<TScenario extends Scenario, TArtifact>(
  config: FapoEntryConfig<TScenario, TArtifact>,
  name = 'fapo-escalation',
): ProposerEntry {
  return {
    name,
    async optimize() {
      const started = Date.now()
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
        scenarios: config.trainScenarios,
        holdoutScenarios: config.holdoutScenarios,
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        proposer,
        populationSize: config.populationSize ?? 2,
        maxGenerations: config.maxGenerations ?? 3,
        gate: defaultProductionGate<TArtifact, TScenario>({
          holdoutScenarios: config.holdoutScenarios,
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
      return { winnerSurface: result.winnerSurface, costUsd, durationMs: Date.now() - started }
    },
  }
}
