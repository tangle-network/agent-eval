/**
 * @experimental
 *
 * `runOptimization` — the improvement loop body. Runs N generations: the
 * `ImprovementDriver` proposes K candidate surfaces per generation, each
 * candidate runs a campaign (the measurement), top-scoring promote to the
 * next generation. Driver-agnostic — the same loop runs an evolutionary
 * population mutator (`evolutionaryDriver`) or agent-runtime's
 * `improvementDriver` (reflective / agentic generators); they differ only in
 * how `propose()` picks candidates.
 *
 * This is `runLoop`'s shape (plan → measure → decide) specialized to surface
 * improvement: `driver.propose` = plan, `runCampaign` = the measurement (which
 * runs the worker behind `dispatch`), the mean-composite ranking = the
 * validator, `driver.decide` = the stop check.
 *
 * The gated-promotion shell (`runImprovementLoop`) wraps this with a holdout
 * re-score + release gate + optional PR.
 */

import { createHash } from 'node:crypto'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import type {
  CampaignResult,
  GenerationRecord,
  ImprovementDriver,
  MutableSurface,
  Scenario,
} from '../types'

export interface RunOptimizationOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch'> {
  /** Initial mutable surface (typically system prompt or addendum). */
  baselineSurface: MutableSurface
  /** Dispatcher that takes the CURRENT surface + scenario → artifact. */
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: Parameters<RunCampaignOptions<TScenario, TArtifact>['dispatch']>[1],
  ) => Promise<TArtifact>
  /** The improvement strategy. Wrap a population `Mutator` via
   *  `evolutionaryDriver({ mutator })`, or pass agent-runtime's
   *  `improvementDriver` (reflective / agentic generators). */
  driver: ImprovementDriver
  populationSize: number
  maxGenerations: number
  /** How many top-scoring candidates carry to the next generation. Default 2. */
  promoteTopK?: number
  /** DEPTH knob forwarded to the driver's `propose()` — max iterations the
   *  agentic generator may take per candidate. */
  maxImprovementShots?: number
  /** Phase-2 research report forwarded to `propose()` (analyst findings +
   *  diff). Opaque here; the driver types it. */
  report?: unknown
}

export interface RunOptimizationResult<TArtifact, TScenario extends Scenario> {
  generations: Array<{
    record: GenerationRecord
    surfaces: Array<{
      surfaceHash: string
      surface: MutableSurface
      campaign: CampaignResult<TArtifact, TScenario>
    }>
  }>
  winnerSurface: MutableSurface
  winnerSurfaceHash: string
  baselineCampaign: CampaignResult<TArtifact, TScenario>
}

export async function runOptimization<TScenario extends Scenario, TArtifact>(
  opts: RunOptimizationOptions<TScenario, TArtifact>,
): Promise<RunOptimizationResult<TArtifact, TScenario>> {
  const promoteTopK = opts.promoteTopK ?? 2

  // Baseline run
  const baselineCampaign = await runCampaign<TScenario, TArtifact>({
    ...opts,
    dispatch: (scenario, ctx) => opts.dispatchWithSurface(opts.baselineSurface, scenario, ctx),
    runDir: `${opts.runDir}/baseline`,
  })

  const generations: RunOptimizationResult<TArtifact, TScenario>['generations'] = []
  const history: GenerationRecord[] = []
  let currentSurfaces: MutableSurface[] = [opts.baselineSurface]
  let winnerSurface = opts.baselineSurface
  let winnerSurfaceHash = surfaceHash(opts.baselineSurface)
  let winnerComposite = meanComposite(baselineCampaign)

  for (let gen = 0; gen < opts.maxGenerations; gen++) {
    // Decide: the driver may stop early based on accumulated history.
    if (opts.driver.decide?.({ history }).stop) break

    // Plan: the driver proposes N candidates from the current best surface,
    // the accumulated generation history, and any external findings.
    const candidates = await opts.driver.propose({
      currentSurface: currentSurfaces[0] ?? opts.baselineSurface,
      history,
      findings: [],
      populationSize: opts.populationSize,
      generation: gen,
      signal: new AbortController().signal,
      report: opts.report,
      dataset: opts.labeledStore && opts.labeledStore !== 'off' ? opts.labeledStore : undefined,
      maxImprovementShots: opts.maxImprovementShots,
    })

    // Run each candidate as its own campaign.
    const surfaceResults: Array<{
      surfaceHash: string
      surface: MutableSurface
      campaign: CampaignResult<TArtifact, TScenario>
      composite: number
    }> = []
    for (let i = 0; i < candidates.length; i++) {
      const surface = candidates[i] as MutableSurface
      const hash = surfaceHash(surface)
      const campaign = await runCampaign<TScenario, TArtifact>({
        ...opts,
        dispatch: (scenario, ctx) => opts.dispatchWithSurface(surface, scenario, ctx),
        runDir: `${opts.runDir}/gen-${gen}/candidate-${i}`,
      })
      const composite = meanComposite(campaign)
      surfaceResults.push({ surfaceHash: hash, surface, campaign, composite })
    }

    // Rank, promote top-K.
    surfaceResults.sort((a, b) => b.composite - a.composite)
    const promoted = surfaceResults.slice(0, promoteTopK)
    currentSurfaces = promoted.map((p) => p.surface)
    const top = surfaceResults[0]
    if (top && top.composite > winnerComposite) {
      winnerSurface = top.surface
      winnerSurfaceHash = top.surfaceHash
      winnerComposite = top.composite
    }

    const record: GenerationRecord = {
      generationIndex: gen,
      candidates: surfaceResults.map((s) => {
        const breakdown = candidateBreakdown(s.campaign)
        return {
          surfaceHash: s.surfaceHash,
          composite: s.composite,
          ci95: [s.composite, s.composite] as [number, number],
          dimensions: breakdown.dimensions,
          scenarios: breakdown.scenarios,
        }
      }),
      promoted: promoted.map((p) => p.surfaceHash),
    }
    history.push(record)
    generations.push({
      record,
      surfaces: surfaceResults.map((s) => ({
        surfaceHash: s.surfaceHash,
        surface: s.surface,
        campaign: s.campaign,
      })),
    })
  }

  return {
    generations,
    winnerSurface,
    winnerSurfaceHash,
    baselineCampaign,
  }
}

export function surfaceHash(surface: MutableSurface): string {
  // Prompt/tool surfaces (string) hash by content; code surfaces hash by the
  // worktree + base ref pair (the content lives in git, not in the string).
  const material =
    typeof surface === 'string'
      ? surface
      : JSON.stringify({
          kind: surface.kind,
          worktreeRef: surface.worktreeRef,
          baseRef: surface.baseRef ?? null,
        })
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

function meanComposite<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
): number {
  const composites: number[] = []
  for (const cell of campaign.cells) {
    const cellComposites = Object.values(cell.judgeScores).map((s) => s.composite)
    if (cellComposites.length > 0) {
      composites.push(cellComposites.reduce((a, b) => a + b, 0) / cellComposites.length)
    }
  }
  return composites.length === 0 ? 0 : composites.reduce((a, b) => a + b, 0) / composites.length
}

/** Per-candidate evidence a reflective driver grounds its next proposal on:
 *  mean score per judge dimension + per-scenario composite. */
function candidateBreakdown<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
): {
  dimensions: Record<string, number>
  scenarios: Array<{ scenarioId: string; composite: number }>
} {
  const dimSums: Record<string, number> = {}
  const dimCounts: Record<string, number> = {}
  const byScenario = new Map<string, number[]>()
  for (const cell of campaign.cells) {
    const judgeScores = Object.values(cell.judgeScores)
    if (judgeScores.length === 0) continue
    const cellComposite = judgeScores.reduce((a, s) => a + s.composite, 0) / judgeScores.length
    const arr = byScenario.get(cell.scenarioId) ?? []
    arr.push(cellComposite)
    byScenario.set(cell.scenarioId, arr)
    for (const score of judgeScores) {
      for (const [key, value] of Object.entries(score.dimensions)) {
        dimSums[key] = (dimSums[key] ?? 0) + value
        dimCounts[key] = (dimCounts[key] ?? 0) + 1
      }
    }
  }
  const dimensions: Record<string, number> = {}
  for (const key of Object.keys(dimSums)) {
    const count = dimCounts[key] ?? 0
    dimensions[key] = count > 0 ? (dimSums[key] ?? 0) / count : 0
  }
  const scenarios = [...byScenario.entries()].map(([scenarioId, comps]) => ({
    scenarioId,
    composite: comps.reduce((a, b) => a + b, 0) / comps.length,
  }))
  return { dimensions, scenarios }
}
