import { pairedBootstrap } from '../statistics'
import {
  compareCandidates,
  meanOrNull,
  relativeCosts,
  unique,
  withinCostLimits,
} from './cross-surface-comparison'
import {
  type CrossSurfaceAnalysisContext as AnalysisContext,
  crossSurfaceComponentSetKey as componentSetKey,
  crossSurfaceRowFor as rowFor,
  crossSurfaceRowsFor as rowsFor,
} from './cross-surface-context'
import { summarizePairEvidence } from './cross-surface-evidence'
import { compareSingleSummaries } from './cross-surface-summary'
import type {
  CrossSurfaceCandidate,
  CrossSurfaceCandidateComparison,
  CrossSurfaceCandidateSummary,
  CrossSurfaceInteractionEffect,
  CrossSurfacePairCompatibility,
  CrossSurfacePairEvidence,
  CrossSurfacePairIncompatibilityReason,
  CrossSurfacePairwiseEntry,
  CrossSurfaceTaskRow,
} from './cross-surface-types'

export function buildPairwise<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
  interactionReadySingles: CrossSurfaceCandidateSummary[],
  baseline: CrossSurfaceCandidateSummary,
): CrossSurfacePairwiseEntry[] {
  const interactionReadyIds = new Set(
    interactionReadySingles.map((summary) => summary.candidate.candidateId),
  )
  const entries: CrossSurfacePairwiseEntry[] = []
  for (let leftIndex = 0; leftIndex < context.components.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < context.components.length; rightIndex++) {
      const leftComponent = context.components[leftIndex]!
      const rightComponent = context.components[rightIndex]!
      const leftSingle = context.singleByComponent.get(leftComponent.componentId)!
      const rightSingle = context.singleByComponent.get(rightComponent.componentId)!
      const pair = context.candidateByComponents.get(
        componentSetKey([leftComponent.componentId, rightComponent.componentId]),
      )!
      const pairSummary = summaryById.get(pair.candidateId)!
      const leftSummary = summaryById.get(leftSingle.candidateId)!
      const rightSummary = summaryById.get(rightSingle.candidateId)!
      const synergyTaskIds: string[] = []
      const interferenceTaskIds: string[] = []
      for (const taskId of context.input.taskOrder) {
        const pairRow = rowFor(context, pair.candidateId, taskId)
        const leftRow = rowFor(context, leftSingle.candidateId, taskId)
        const rightRow = rowFor(context, rightSingle.candidateId, taskId)
        if (![pairRow, leftRow, rightRow].every((row) => row.completeness === 'complete')) continue
        if (pairRow.pass && !leftRow.pass && !rightRow.pass) synergyTaskIds.push(taskId)
        if (!pairRow.pass && (leftRow.pass || rightRow.pass)) interferenceTaskIds.push(taskId)
      }
      const incrementalVsConstituents: [
        CrossSurfaceCandidateComparison,
        CrossSurfaceCandidateComparison,
      ] = [
        compareCandidates(context, summaryById, leftSingle.candidateId, pair.candidateId),
        compareCandidates(context, summaryById, rightSingle.candidateId, pair.candidateId),
      ]
      const betterSingle =
        compareSingleSummaries(context, leftSummary, rightSummary) <= 0 ? leftSummary : rightSummary
      const firing = summarizePairEvidence(
        rowsFor(context, pair.candidateId),
        leftComponent.componentId,
        rightComponent.componentId,
        'fired',
      )
      const effect = summarizePairEvidence(
        rowsFor(context, pair.candidateId),
        leftComponent.componentId,
        rightComponent.componentId,
        'effectObserved',
      )
      const compatibility = pairCompatibility(
        context,
        pairSummary,
        baseline,
        betterSingle,
        incrementalVsConstituents,
        interactionReadyIds.has(leftSingle.candidateId) &&
          interactionReadyIds.has(rightSingle.candidateId),
        interferenceTaskIds,
        firing,
        effect,
      )
      entries.push({
        componentIds: [leftComponent.componentId, rightComponent.componentId],
        singleCandidateIds: [leftSingle.candidateId, rightSingle.candidateId],
        compositionCandidateId: pair.candidateId,
        benefitTaskIds: [...pairSummary.outcome.benefitTaskIds],
        regressionTaskIds: [...pairSummary.outcome.regressionTaskIds],
        synergyTaskIds,
        interferenceTaskIds,
        incrementalVsConstituents,
        relativeCostToBaseline: relativeCosts(context, pairSummary, baseline),
        firing,
        effect,
        interaction: interactionEffect(
          context,
          baseline.candidate,
          [leftSingle, rightSingle],
          pair,
        ),
        compatibility,
      })
    }
  }
  return entries
}

function pairCompatibility<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  pair: CrossSurfaceCandidateSummary,
  baseline: CrossSurfaceCandidateSummary,
  betterSingle: CrossSurfaceCandidateSummary,
  comparisons: [CrossSurfaceCandidateComparison, CrossSurfaceCandidateComparison],
  constituentsReady: boolean,
  interferenceTaskIds: string[],
  firing: CrossSurfacePairEvidence,
  effect: CrossSurfacePairEvidence,
): CrossSurfacePairCompatibility {
  const reasons: CrossSurfacePairIncompatibilityReason[] = []
  if (!constituentsReady) reasons.push('constituent_not_ready')
  if (
    pair.outcome.missingTaskIds.length > 0 ||
    pair.outcome.invalidTaskIds.length > 0 ||
    pair.outcome.comparisonMissingTaskIds.length > 0
  ) {
    reasons.push('pair_incomplete')
  }
  if (pair.outcome.regressionTaskIds.length > 0) reasons.push('baseline_regression')
  if (interferenceTaskIds.length > 0) reasons.push('interference')
  const betterComparison = comparisons.find(
    (comparison) => comparison.comparatorCandidateId === betterSingle.candidate.candidateId,
  )!
  if (betterComparison.winsTaskIds.length === 0) reasons.push('no_incremental_resolution')
  appendPairEvidenceReasons(
    reasons,
    firing,
    context.input.selection.minimumFiringTasks,
    context.input.selection.requireObservedFiring,
    'firing_below_minimum',
    'firing_unobserved',
  )
  appendPairEvidenceReasons(
    reasons,
    effect,
    context.input.selection.minimumEffectTasks,
    context.input.selection.requireObservedEffect,
    'effect_below_minimum',
    'effect_unobserved',
  )
  if (!withinCostLimits(context, pair, baseline)) reasons.push('cost_limit_exceeded')
  return {
    compatible: reasons.length === 0,
    reasons: unique(reasons),
    betterSingleCandidateId: betterSingle.candidate.candidateId,
  }
}

function appendPairEvidenceReasons(
  reasons: CrossSurfacePairIncompatibilityReason[],
  evidence: CrossSurfacePairEvidence,
  minimum: number,
  requireObserved: boolean,
  belowReason: CrossSurfacePairIncompatibilityReason,
  unobservedReason: CrossSurfacePairIncompatibilityReason,
): void {
  const leftObserved = evidence.bothTaskIds.length + evidence.leftOnlyTaskIds.length
  const rightObserved = evidence.bothTaskIds.length + evidence.rightOnlyTaskIds.length
  if (leftObserved < minimum || rightObserved < minimum) reasons.push(belowReason)
  if (requireObserved && evidence.unobservedTaskIds.length > 0) reasons.push(unobservedReason)
}

function interactionEffect<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  baseline: CrossSurfaceCandidate,
  singles: CrossSurfaceCandidate[],
  composition: CrossSurfaceCandidate,
): CrossSurfaceInteractionEffect {
  const perTask = context.input.taskOrder.map((taskId) => {
    const baselineRow = rowFor(context, baseline.candidateId, taskId)
    const singleRows = singles.map((single) => rowFor(context, single.candidateId, taskId))
    const compositionRow = rowFor(context, composition.candidateId, taskId)
    const rows = [baselineRow, ...singleRows, compositionRow]
    if (!rows.every((row) => row.completeness === 'complete')) {
      return { taskId, passInteraction: null, scoreInteraction: null }
    }
    const additivePass =
      singleRows.reduce((sum, row) => sum + Number(row.pass), 0) -
      (singles.length - 1) * Number(baselineRow.pass)
    const additiveScore =
      singleRows.reduce((sum, row) => sum + (row.score as number), 0) -
      (singles.length - 1) * (baselineRow.score as number)
    return {
      taskId,
      passInteraction: Number(compositionRow.pass) - additivePass,
      scoreInteraction: (compositionRow.score as number) - additiveScore,
    }
  })
  const complete = perTask.filter(
    (row): row is { taskId: string; passInteraction: number; scoreInteraction: number } =>
      row.passInteraction !== null && row.scoreInteraction !== null,
  )
  const passInteractions = complete.map((row) => row.passInteraction)
  const scoreInteractions = complete.map((row) => row.scoreInteraction)
  return {
    perTask,
    n: complete.length,
    nMissing: perTask.length - complete.length,
    meanPassInteraction: meanOrNull(passInteractions),
    meanScoreInteraction: meanOrNull(scoreInteractions),
    passBootstrap: bootstrapInteraction(passInteractions, context),
    scoreBootstrap: bootstrapInteraction(scoreInteractions, context),
  }
}

function bootstrapInteraction<TRow extends CrossSurfaceTaskRow>(
  interactions: number[],
  context: AnalysisContext<TRow>,
) {
  if (interactions.length === 0) return null
  return pairedBootstrap(new Array(interactions.length).fill(0), interactions, {
    ...context.input.bootstrap,
    statistic: 'mean',
  })
}
