import { assertCompleteCampaign } from '../coverage'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { createRunCostLedger, fsCampaignStorage } from '../storage'
import { renderSurfaceDiff, surfaceDispatchRef, surfaceHash } from '../surface-identity'
import type { CampaignResult, Gate, MutableSurface, Scenario } from '../types'

export interface FinalComparisonOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch'> {
  baselineSurface: MutableSurface
  winnerSurface: MutableSurface
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: Parameters<RunCampaignOptions<TScenario, TArtifact>['dispatch']>[1],
  ) => Promise<TArtifact>
  gate: Gate<TArtifact, TScenario>
  holdout?: 'measured' | 'deferred'
  label?: string
  neutralize?: (winner: MutableSurface, baseline: MutableSurface) => MutableSurface
}

/** Compare a search-selected surface without changing the search's selection. */
export async function runFinalComparison<TScenario extends Scenario, TArtifact>(
  opts: FinalComparisonOptions<TScenario, TArtifact>,
) {
  const storage = opts.storage ?? fsCampaignStorage()
  const costLedger =
    opts.costLedger ??
    createRunCostLedger({ storage, runDir: opts.runDir, costCeilingUsd: opts.costCeiling })
  const dispatchTimeoutMs = opts.dispatchTimeoutMs ?? 600_000
  const costPhase = (phase: string) => (opts.costPhase ? `${opts.costPhase}.${phase}` : phase)
  const baselineSurface = structuredClone(opts.baselineSurface)
  const winnerSurface = structuredClone(opts.winnerSurface)
  const finalScenarios = structuredClone(opts.scenarios)

  // An unchanged selection has nothing to promote, regardless of measurement noise.
  const winnerIsBaseline = surfaceHash(winnerSurface) === surfaceHash(baselineSurface)
  const holdoutDeferred = (opts.holdout ?? 'measured') === 'deferred'

  // An empty campaign records deferred measurement without dispatching final cases.
  const baselineOnHoldout = holdoutDeferred
    ? await runCampaign<TScenario, TArtifact>({
        ...opts,
        labeledStore: 'off',
        costLedger,
        costPhase: costPhase('holdout.deferred'),
        dispatchTimeoutMs,
        scenarios: [],
        dispatch: async () => {
          throw new Error('runFinalComparison: unreachable dispatch — holdout is deferred')
        },
        runDir: `${opts.runDir}/holdout-deferred`,
      })
    : await runCampaign<TScenario, TArtifact>({
        ...opts,
        labeledStore: 'off',
        costLedger,
        costPhase: costPhase('holdout.baseline'),
        dispatchRef: surfaceDispatchRef(baselineSurface, opts.dispatchRef),
        dispatchTimeoutMs,
        scenarios: structuredClone(finalScenarios),
        dispatch: (scenario, ctx) =>
          opts.dispatchWithSurface(structuredClone(baselineSurface), scenario, ctx),
        runDir: `${opts.runDir}/holdout-baseline`,
      })

  // Reuse unchanged or deferred measurements; neither can justify promotion.
  const winnerOnHoldout =
    winnerIsBaseline || holdoutDeferred
      ? baselineOnHoldout
      : await runCampaign<TScenario, TArtifact>({
          ...opts,
          labeledStore: 'off',
          costLedger,
          costPhase: costPhase('holdout.winner'),
          dispatchRef: surfaceDispatchRef(winnerSurface, opts.dispatchRef),
          dispatchTimeoutMs,
          scenarios: structuredClone(finalScenarios),
          dispatch: (scenario, ctx) =>
            opts.dispatchWithSurface(structuredClone(winnerSurface), scenario, ctx),
          runDir: `${opts.runDir}/holdout-winner`,
        })

  // Missing replicas or judges must not improve an arm by reducing its denominator.
  const requireJudgeScore = (opts.judges?.length ?? 0) > 0
  const reps = opts.reps ?? 1
  const assertCompleteHoldout = (
    arm: string,
    campaign: CampaignResult<TArtifact, TScenario>,
  ): void => {
    assertCompleteCampaign(
      campaign,
      finalScenarios,
      reps,
      requireJudgeScore,
      `${opts.label ?? 'runImprovementLoop'}: ${arm} holdout`,
    )
  }
  if (!holdoutDeferred) {
    assertCompleteHoldout('baseline', baselineOnHoldout)
    assertCompleteHoldout('winner', winnerOnHoldout)
  }

  // Both arms share cell identifiers, so their scores need separate maps.
  type ScoreMap = Map<
    string,
    Record<string, { composite: number; dimensions: Record<string, number>; notes: string }>
  >
  const candidateArtifacts = new Map<string, TArtifact>()
  const baselineArtifacts = new Map<string, TArtifact>()
  const judgeScores: ScoreMap = new Map()
  const baselineJudgeScores: ScoreMap = new Map()
  for (const cell of winnerOnHoldout.cells) {
    candidateArtifacts.set(cell.cellId, cell.artifact)
    judgeScores.set(cell.cellId, cell.judgeScores)
  }
  for (const cell of baselineOnHoldout.cells) {
    baselineArtifacts.set(cell.cellId, cell.artifact)
    baselineJudgeScores.set(cell.cellId, cell.judgeScores)
  }

  // The optional control measures whether lift survives removal of the selected content.
  let neutralizedArtifacts: Map<string, TArtifact> | undefined
  let neutralizedJudgeScores: ScoreMap | undefined
  let neutralizedOnHoldout: CampaignResult<TArtifact, TScenario> | undefined
  let neutralizedSurface: MutableSurface | undefined
  if (opts.neutralize && !winnerIsBaseline && !holdoutDeferred) {
    const surface = opts.neutralize(
      structuredClone(winnerSurface),
      structuredClone(baselineSurface),
    )
    neutralizedSurface = surface
    neutralizedOnHoldout = await runCampaign<TScenario, TArtifact>({
      ...opts,
      labeledStore: 'off',
      costLedger,
      costPhase: costPhase('holdout.neutralized'),
      dispatchRef: surfaceDispatchRef(surface, opts.dispatchRef),
      dispatchTimeoutMs,
      scenarios: structuredClone(finalScenarios),
      dispatch: (scenario, ctx) =>
        opts.dispatchWithSurface(structuredClone(surface), scenario, ctx),
      runDir: `${opts.runDir}/holdout-neutralized`,
    })
    assertCompleteHoldout('neutralized', neutralizedOnHoldout)
    neutralizedArtifacts = new Map<string, TArtifact>()
    neutralizedJudgeScores = new Map()
    for (const cell of neutralizedOnHoldout.cells) {
      neutralizedArtifacts.set(cell.cellId, cell.artifact)
      neutralizedJudgeScores.set(cell.cellId, cell.judgeScores)
    }
  }

  // Deferred measurement has no observed delta. An unchanged selection has zero change.
  const gateResult = holdoutDeferred
    ? {
        decision: 'hold' as const,
        reasons: [
          'holdout deferred — improvement-set search completed without a held-out measurement; nothing to promote from this run',
        ],
        contributingGates: [
          {
            name: 'holdout-deferred',
            status: 'not_evaluated' as const,
            detail: { holdout: 'deferred' },
          },
        ],
      }
    : winnerIsBaseline
      ? {
          decision: 'hold' as const,
          reasons: ['selected surface equals the baseline (empty diff); nothing to promote'],
          contributingGates: [
            { name: 'no-op-guard', status: 'fail' as const, detail: { winnerIsBaseline: true } },
          ],
          delta: 0,
        }
      : await opts.gate.decide({
          candidateArtifacts,
          baselineArtifacts,
          judgeScores,
          baselineJudgeScores,
          neutralizedArtifacts,
          neutralizedJudgeScores,
          scenarios: structuredClone(finalScenarios),
          cost: {
            candidate: winnerOnHoldout.aggregates.cost.totalCostUsd,
            baseline: baselineOnHoldout.aggregates.cost.totalCostUsd,
          },
          costLedger,
          costPhase: costPhase('promotion.gate'),
          signal: opts.signal ?? new AbortController().signal,
        })

  const promotedDiff =
    surfaceHash(winnerSurface) === surfaceHash(baselineSurface)
      ? ''
      : renderSurfaceDiff(winnerSurface, baselineSurface)

  return {
    baselineOnHoldout,
    winnerOnHoldout,
    ...(neutralizedOnHoldout && neutralizedSurface
      ? { neutralizedOnHoldout, neutralizedSurface }
      : {}),
    ...(holdoutDeferred ? { holdout: 'deferred' as const } : {}),
    gateResult,
    promotedDiff,
  }
}
