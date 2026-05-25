/**
 * @experimental
 *
 * `runOptimization` — population-based prompt-evolution loop. Runs N
 * generations: mutator produces K candidate surfaces per generation, each
 * candidate runs a campaign, top-scoring promote to next generation.
 *
 * Phase 2 implementation: SCAFFOLD that wraps `runShot` for each
 * generation. The full reflective-mutation / AxGEPA mutator wiring lands
 * when consumer migrations need it (gtm/legal/tax already have working
 * `run-prompt-evolution.ts` flows — those become inputs to the mutator
 * adapter in Phase 4 day 1-2 diff work).
 *
 * For Phase 2 testing: a consumer-provided `dispatch` that swaps the
 * surface into its profile + runs scenarios. Optimizer rotates the surface
 * via the mutator + collects per-generation scorecards.
 */

import { createHash } from 'node:crypto'
import { type RunShotOptions, runShot } from '../run-shot'
import type { GenerationRecord, MutableSurface, Mutator, Scenario, ShotResult } from '../types'

export interface RunOptimizationOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunShotOptions<TScenario, TArtifact>, 'dispatch'> {
  /** Initial mutable surface (typically system prompt or addendum). */
  baselineSurface: MutableSurface
  /** Dispatcher that takes the CURRENT surface + scenario → artifact. */
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: Parameters<RunShotOptions<TScenario, TArtifact>['dispatch']>[1],
  ) => Promise<TArtifact>
  mutator: Mutator
  populationSize: number
  maxGenerations: number
  /** How many top-scoring candidates carry to the next generation. Default 2. */
  promoteTopK?: number
}

export interface RunOptimizationResult<TArtifact, TScenario extends Scenario> {
  generations: Array<{
    record: GenerationRecord
    surfaces: Array<{
      surfaceHash: string
      surface: MutableSurface
      campaign: ShotResult<TArtifact, TScenario>
    }>
  }>
  winnerSurface: MutableSurface
  winnerSurfaceHash: string
  baselineShot: ShotResult<TArtifact, TScenario>
}

export async function runOptimization<TScenario extends Scenario, TArtifact>(
  opts: RunOptimizationOptions<TScenario, TArtifact>,
): Promise<RunOptimizationResult<TArtifact, TScenario>> {
  const promoteTopK = opts.promoteTopK ?? 2

  // Baseline run
  const baselineShot = await runShot<TScenario, TArtifact>({
    ...opts,
    dispatch: (scenario, ctx) => opts.dispatchWithSurface(opts.baselineSurface, scenario, ctx),
    runDir: `${opts.runDir}/baseline`,
  })

  const generations: RunOptimizationResult<TArtifact, TScenario>['generations'] = []
  let currentSurfaces: MutableSurface[] = [opts.baselineSurface]
  let winnerSurface = opts.baselineSurface
  let winnerSurfaceHash = surfaceHash(opts.baselineSurface)
  let winnerComposite = meanComposite(baselineShot)

  for (let gen = 0; gen < opts.maxGenerations; gen++) {
    // Mutate: produce N candidates from the current top surfaces.
    const candidates = await opts.mutator.mutate({
      findings: [],
      currentSurface: currentSurfaces[0] ?? opts.baselineSurface,
      populationSize: opts.populationSize,
      signal: new AbortController().signal,
    })

    // Run each candidate as its own campaign.
    const surfaceResults: Array<{
      surfaceHash: string
      surface: MutableSurface
      campaign: ShotResult<TArtifact, TScenario>
      composite: number
    }> = []
    for (let i = 0; i < candidates.length; i++) {
      const surface = candidates[i] as MutableSurface
      const hash = surfaceHash(surface)
      const campaign = await runShot<TScenario, TArtifact>({
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

    generations.push({
      record: {
        generationIndex: gen,
        candidates: surfaceResults.map((s) => ({
          surfaceHash: s.surfaceHash,
          composite: s.composite,
          ci95: [s.composite, s.composite] as [number, number],
        })),
        promoted: promoted.map((p) => p.surfaceHash),
      },
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
    baselineShot,
  }
}

export function surfaceHash(surface: MutableSurface): string {
  return createHash('sha256').update(surface).digest('hex').slice(0, 16)
}

function meanComposite<TArtifact, TScenario extends Scenario>(
  campaign: ShotResult<TArtifact, TScenario>,
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
