import { defineEvaluationClaim, type EvaluationClaim } from '../../experiment/claim'
import {
  captureModelTreatment,
  compareModelIdentities,
  type ModelTreatment,
} from '../../integrity/model-comparison'
import { cellReceiptModels } from '../cell-cache'
import { assertCompleteCampaign } from '../coverage'
import {
  captureFinalEvidencePolicy,
  exposeFinalEvidence,
  type FinalEvidencePolicy,
} from '../final-evidence'
import { captureJudge } from '../judge-snapshot'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { createRunCostLedger, fsCampaignStorage } from '../storage'
import { renderSurfaceDiff, surfaceDispatchRef, surfaceHash } from '../surface-identity'
import type { CampaignResult, Gate, MutableSurface, Scenario } from '../types'

interface FinalComparisonOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch'> {
  baselineSurface: MutableSurface
  winnerSurface: MutableSurface
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: Parameters<RunCampaignOptions<TScenario, TArtifact>['dispatch']>[1],
  ) => Promise<TArtifact>
  gate: Gate<TArtifact, TScenario>
  claim?: EvaluationClaim
  finalEvidence?: FinalEvidencePolicy
  model?: string
  modelTreatment?: ModelTreatment
  requireReportedModel?: boolean
  holdout?: 'measured' | 'deferred'
  label?: string
  neutralize?: (winner: MutableSurface, baseline: MutableSurface) => MutableSurface
}

/** Compare a search-selected surface without changing the search's selection. */
/** Each holdout campaign a final comparison dispatched, labeled by arm; a reused arm counts once. */
export function finalComparisonCampaigns<TArtifact, TScenario extends Scenario>(comparison: {
  baselineOnHoldout: CampaignResult<TArtifact, TScenario>
  winnerOnHoldout: CampaignResult<TArtifact, TScenario>
  neutralizedOnHoldout?: CampaignResult<TArtifact, TScenario>
}) {
  return [
    { label: 'holdout.baseline', cells: comparison.baselineOnHoldout.cells },
    ...(comparison.winnerOnHoldout === comparison.baselineOnHoldout
      ? []
      : [{ label: 'holdout.winner', cells: comparison.winnerOnHoldout.cells }]),
    ...(comparison.neutralizedOnHoldout
      ? [{ label: 'holdout.neutralized', cells: comparison.neutralizedOnHoldout.cells }]
      : []),
  ]
}

export async function runFinalComparison<TScenario extends Scenario, TArtifact>(
  opts: FinalComparisonOptions<TScenario, TArtifact>,
) {
  opts = {
    ...opts,
    judges: opts.judges?.map(captureJudge),
    modelTreatment: captureModelTreatment(opts.modelTreatment),
    claim: opts.claim && defineEvaluationClaim(opts.claim),
    finalEvidence: opts.finalEvidence && captureFinalEvidencePolicy(opts.finalEvidence),
  }
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
  if (opts.finalEvidence && holdoutDeferred) {
    throw new Error('final evidence requires a measured comparison')
  }
  const controlSurface =
    opts.neutralize && !winnerIsBaseline && !holdoutDeferred
      ? structuredClone(
          opts.neutralize(structuredClone(winnerSurface), structuredClone(baselineSurface)),
        )
      : undefined
  const finalEvidence = opts.finalEvidence
    ? await exposeFinalEvidence(opts.finalEvidence, opts.claim, finalScenarios, [
        baselineSurface,
        winnerSurface,
        ...(controlSurface === undefined ? [] : [controlSurface]),
      ])
    : undefined

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

  // The optional control measures whether lift survives removal of the selected content.
  let neutralized: ReturnType<typeof gateArms<TScenario, TArtifact>> | undefined
  let neutralizedOnHoldout: CampaignResult<TArtifact, TScenario> | undefined
  let neutralizedSurface: MutableSurface | undefined
  if (controlSurface !== undefined) {
    const surface = controlSurface
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
    neutralized = gateArms(baselineOnHoldout, neutralizedOnHoldout)
  }

  // Model identity is a precondition of a prompt/code comparison, including a custom gate.
  // Keep every measurement; a confounded pair makes the comparison ineligible.
  const models = (cell: (typeof baselineOnHoldout.cells)[number]) => {
    const reported = cellReceiptModels(cell)
    return reported.length > 0 || !opts.model ? reported : [opts.model]
  }
  const baselineCells = new Map(baselineOnHoldout.cells.map((cell) => [cell.cellId, cell]))
  const comparisonPairs = (campaign: typeof winnerOnHoldout, arm: string) =>
    campaign.cells.map((cell) => ({
      id: `${arm}:${cell.cellId}`,
      baseline: models(baselineCells.get(cell.cellId)!),
      candidate: models(cell),
    }))
  const modelComparison = compareModelIdentities(
    [
      ...comparisonPairs(winnerOnHoldout, 'winner'),
      ...(neutralizedOnHoldout ? comparisonPairs(neutralizedOnHoldout, 'neutralized') : []),
    ],
    opts.modelTreatment,
    opts.requireReportedModel,
  )

  // Deferred measurement has no observed delta. An unchanged selection has zero change.
  const decision = holdoutDeferred
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
      : !modelComparison.eligible
        ? {
            decision: 'hold' as const,
            reasons: ['served model identity does not support the declared comparison'],
            contributingGates: [],
          }
        : await opts.gate.decide({
            ...gateArms(baselineOnHoldout, winnerOnHoldout),
            neutralizedArtifacts: neutralized?.candidateArtifacts,
            neutralizedJudgeScores: neutralized?.judgeScores,
            scenarios: structuredClone(finalScenarios),
            costLedger,
            costPhase: costPhase('promotion.gate'),
            signal: opts.signal ?? new AbortController().signal,
          })
  const gateResult = {
    ...decision,
    contributingGates: [
      ...decision.contributingGates,
      {
        name: 'served-model-identity',
        status:
          modelComparison.checkedPairs === 0
            ? ('not_evaluated' as const)
            : modelComparison.eligible
              ? ('pass' as const)
              : ('fail' as const),
        detail: modelComparison,
      },
    ],
  }

  const promotedDiff =
    surfaceHash(winnerSurface) === surfaceHash(baselineSurface)
      ? ''
      : renderSurfaceDiff(winnerSurface, baselineSurface)

  return {
    ...(opts.claim ? { claim: opts.claim } : {}),
    ...(finalEvidence ? { finalEvidence } : {}),
    baselineOnHoldout,
    winnerOnHoldout,
    ...(neutralizedOnHoldout && neutralizedSurface
      ? { neutralizedOnHoldout, neutralizedSurface }
      : {}),
    ...(holdoutDeferred ? { holdout: 'deferred' as const } : {}),
    gateResult,
    modelComparison,
    promotedDiff,
  }
}

/** The paired cells of a baseline and a candidate campaign, keyed by cell id, as a gate reads them. */
export function gateArms<TScenario extends Scenario, TArtifact>(
  baseline: CampaignResult<TArtifact, TScenario>,
  candidate: CampaignResult<TArtifact, TScenario>,
) {
  return {
    baselineArtifacts: new Map(baseline.cells.map((cell) => [cell.cellId, cell.artifact])),
    candidateArtifacts: new Map(candidate.cells.map((cell) => [cell.cellId, cell.artifact])),
    baselineJudgeScores: new Map(baseline.cells.map((cell) => [cell.cellId, cell.judgeScores])),
    judgeScores: new Map(candidate.cells.map((cell) => [cell.cellId, cell.judgeScores])),
    cost: {
      candidate: candidate.aggregates.cost.totalCostUsd,
      baseline: baseline.aggregates.cost.totalCostUsd,
    },
  }
}
