/**
 * Task-paired comparison and deterministic selection for independently
 * proposed agent surfaces. Unlike factorial cell-mean attribution, every
 * benefit, regression, and interaction remains attached to its task row.
 */

import { ValidationError } from '../errors'
import { comparePairedArms, type PairedArmRow, type PairedArmsComparison } from '../paired-arms'
import { pairedBootstrap } from '../statistics'
import {
  type CrossSurfaceAnalysisContext as AnalysisContext,
  canonicalCrossSurfaceComponents as canonicalComponents,
  crossSurfaceComponentSetKey as componentSetKey,
  crossSurfaceRowFor as rowFor,
  crossSurfaceRowsFor as rowsFor,
  validateCrossSurfaceInput as validateAndIndex,
} from './cross-surface-context'
import type {
  AnalyzeCrossSurfaceInteractionsInput,
  CrossSurfaceAdditionDecision,
  CrossSurfaceAdditionRejectionReason,
  CrossSurfaceCandidate,
  CrossSurfaceCandidateComparison,
  CrossSurfaceCandidateEvidence,
  CrossSurfaceCandidateOutcome,
  CrossSurfaceCandidateSummary,
  CrossSurfaceCompositionStep,
  CrossSurfaceDistribution,
  CrossSurfaceEligibility,
  CrossSurfaceEvidenceBreakdown,
  CrossSurfaceIneligibilityReason,
  CrossSurfaceInteractionAwareSelection,
  CrossSurfaceInteractionEffect,
  CrossSurfaceInteractionPath,
  CrossSurfaceInteractionReport,
  CrossSurfaceNaiveStackSelection,
  CrossSurfacePairCompatibility,
  CrossSurfacePairEvidence,
  CrossSurfacePairIncompatibilityReason,
  CrossSurfacePairwiseEntry,
  CrossSurfaceRankedSingle,
  CrossSurfaceRelativeCost,
  CrossSurfaceSelections,
  CrossSurfaceTaskRow,
} from './cross-surface-types'

/**
 * Build the complete cross-surface evidence matrix and derive all three frozen
 * candidates. The task/candidate/component orders are part of the input so
 * neither insertion order nor an after-the-fact tie-break can change a result.
 */
export function analyzeCrossSurfaceInteractions<TRow extends CrossSurfaceTaskRow>(
  input: AnalyzeCrossSurfaceInteractionsInput<TRow>,
): CrossSurfaceInteractionReport<TRow> {
  const context = validateAndIndex(input)
  const baseline = context.candidateById.get(input.baselineCandidateId)!

  const preliminary = context.candidates.map((candidate) =>
    summarizeCandidate(context, candidate, baseline),
  )
  const baselineSummary = preliminary.find(
    (summary) => summary.candidate.candidateId === input.baselineCandidateId,
  )!
  const summaries = preliminary.map((summary) =>
    summary.candidate.candidateId === input.baselineCandidateId
      ? summary
      : {
          ...summary,
          eligibility: candidateEligibility(context, summary, baselineSummary),
        },
  )
  const summaryById = new Map(summaries.map((summary) => [summary.candidate.candidateId, summary]))
  const eligibleSingles = rankedEligibleSingles(context, summaryById)
  const interactionReadySingles = rankedInteractionReadySingles(context, summaryById)
  const pairwise = buildPairwise(context, summaryById, interactionReadySingles, baselineSummary)
  const selections = selectCandidates(
    context,
    summaryById,
    eligibleSingles,
    interactionReadySingles,
    pairwise,
  )
  const rows = context.candidates.flatMap((candidate) =>
    input.taskOrder.map(
      (taskId) => context.rowsByCandidate.get(candidate.candidateId)!.get(taskId)!,
    ),
  )

  return {
    taskIds: [...input.taskOrder],
    componentIds: [...input.componentOrder],
    candidateIds: [...input.candidateOrder],
    costMetrics: [...input.costMetricOrder],
    rows,
    missingAttempts: rows.filter((row) => row.completeness === 'missing'),
    invalidAttempts: rows.filter((row) => row.completeness === 'invalid'),
    candidates: summaries,
    pairwise,
    selections,
  }
}

function summarizeCandidate<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  candidate: CrossSurfaceCandidate,
  baseline: CrossSurfaceCandidate,
): CrossSurfaceCandidateSummary {
  const rows = rowsFor(context, candidate.candidateId)
  const baselineRows = rowsFor(context, baseline.candidateId)
  const outcome = summarizeOutcome(
    context,
    rows,
    baselineRows,
    candidate.candidateId === baseline.candidateId,
  )
  const completeScores = rows
    .filter((row) => row.completeness === 'complete')
    .map((row) => row.score as number)
  const costs = Object.fromEntries(
    context.input.costMetricOrder.map((metric) => [
      metric,
      distribution(rows.map((row) => row.cost[metric] as number)),
    ]),
  )
  return {
    candidate,
    outcome,
    score: completeScores.length === 0 ? null : distribution(completeScores),
    costs,
    firing: summarizeCandidateEvidence(rows, candidate.componentIds, 'fired'),
    effect: summarizeCandidateEvidence(rows, candidate.componentIds, 'effectObserved'),
    comparisonToBaseline:
      candidate.candidateId === baseline.candidateId
        ? null
        : pairedComparison(context, baseline.candidateId, candidate.candidateId),
    eligibility: null,
  }
}

function summarizeOutcome<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  rows: TRow[],
  baselineRows: TRow[],
  isBaseline: boolean,
): CrossSurfaceCandidateOutcome {
  const resolvedTaskIds: string[] = []
  const failedTaskIds: string[] = []
  const missingTaskIds: string[] = []
  const invalidTaskIds: string[] = []
  const benefitTaskIds: string[] = []
  const regressionTaskIds: string[] = []
  const comparisonMissingTaskIds: string[] = []
  for (let index = 0; index < context.input.taskOrder.length; index++) {
    const row = rows[index]!
    const baseline = baselineRows[index]!
    if (row.completeness === 'missing') missingTaskIds.push(row.taskId)
    else if (row.completeness === 'invalid') invalidTaskIds.push(row.taskId)
    else if (row.pass) resolvedTaskIds.push(row.taskId)
    else failedTaskIds.push(row.taskId)

    if (isBaseline) continue
    if (row.completeness !== 'complete' || baseline.completeness !== 'complete') {
      comparisonMissingTaskIds.push(row.taskId)
    } else if (row.pass && !baseline.pass) benefitTaskIds.push(row.taskId)
    else if (!row.pass && baseline.pass) regressionTaskIds.push(row.taskId)
  }
  return {
    resolvedTaskIds,
    failedTaskIds,
    missingTaskIds,
    invalidTaskIds,
    benefitTaskIds,
    regressionTaskIds,
    comparisonMissingTaskIds,
    netBenefit: benefitTaskIds.length - regressionTaskIds.length,
  }
}

function summarizeCandidateEvidence<TRow extends CrossSurfaceTaskRow>(
  rows: TRow[],
  componentIds: string[],
  field: 'fired' | 'effectObserved',
): CrossSurfaceCandidateEvidence {
  if (componentIds.length === 0) {
    return {
      byComponent: [],
      allObservedTaskIds: [],
      someObservedTaskIds: [],
      noneObservedTaskIds: [],
      unobservedTaskIds: [],
    }
  }
  const byComponent: CrossSurfaceEvidenceBreakdown[] = componentIds.map((componentId) => {
    const observedTaskIds: string[] = []
    const notObservedTaskIds: string[] = []
    const unobservedTaskIds: string[] = []
    for (const row of rows) {
      const value = evidenceValue(row, componentId, field)
      if (value === true) observedTaskIds.push(row.taskId)
      else if (value === false) notObservedTaskIds.push(row.taskId)
      else unobservedTaskIds.push(row.taskId)
    }
    return { componentId, observedTaskIds, notObservedTaskIds, unobservedTaskIds }
  })
  const allObservedTaskIds: string[] = []
  const someObservedTaskIds: string[] = []
  const noneObservedTaskIds: string[] = []
  const unobservedTaskIds: string[] = []
  for (const row of rows) {
    const values = componentIds.map((componentId) => evidenceValue(row, componentId, field))
    if (values.some((value) => value === null)) unobservedTaskIds.push(row.taskId)
    else if (values.every(Boolean)) allObservedTaskIds.push(row.taskId)
    else if (values.some(Boolean)) someObservedTaskIds.push(row.taskId)
    else noneObservedTaskIds.push(row.taskId)
  }
  return {
    byComponent,
    allObservedTaskIds,
    someObservedTaskIds,
    noneObservedTaskIds,
    unobservedTaskIds,
  }
}

function candidateEligibility<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summary: CrossSurfaceCandidateSummary,
  baseline: CrossSurfaceCandidateSummary,
): CrossSurfaceEligibility {
  const reasons: CrossSurfaceIneligibilityReason[] = []
  if (summary.outcome.missingTaskIds.length > 0) reasons.push('missing_attempt')
  if (summary.outcome.invalidTaskIds.length > 0) reasons.push('invalid_attempt')
  if (summary.outcome.comparisonMissingTaskIds.length > 0) reasons.push('baseline_outcome_missing')
  if (summary.outcome.benefitTaskIds.length <= summary.outcome.regressionTaskIds.length) {
    reasons.push('benefit_not_greater_than_regression')
  }
  appendEvidenceEligibilityReasons(
    reasons,
    summary.firing,
    context.input.selection.minimumFiringTasks,
    context.input.selection.requireObservedFiring,
    'firing_below_minimum',
    'firing_unobserved',
  )
  appendEvidenceEligibilityReasons(
    reasons,
    summary.effect,
    context.input.selection.minimumEffectTasks,
    context.input.selection.requireObservedEffect,
    'effect_below_minimum',
    'effect_unobserved',
  )
  if (!withinCostLimits(context, summary, baseline)) reasons.push('cost_limit_exceeded')
  return { eligible: reasons.length === 0, reasons: unique(reasons) }
}

function appendEvidenceEligibilityReasons(
  reasons: CrossSurfaceIneligibilityReason[],
  evidence: CrossSurfaceCandidateEvidence,
  minimum: number,
  requireObserved: boolean,
  belowReason: CrossSurfaceIneligibilityReason,
  unobservedReason: CrossSurfaceIneligibilityReason,
): void {
  if (evidence.byComponent.some((component) => component.observedTaskIds.length < minimum)) {
    reasons.push(belowReason)
  }
  if (
    requireObserved &&
    evidence.byComponent.some((component) => component.unobservedTaskIds.length > 0)
  ) {
    reasons.push(unobservedReason)
  }
}

function rankedEligibleSingles<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
): CrossSurfaceCandidateSummary[] {
  return [...context.singleByComponent.values()]
    .map((candidate) => summaryById.get(candidate.candidateId)!)
    .filter((summary) => summary.eligibility?.eligible)
    .sort((left, right) => compareSingleSummaries(context, left, right))
}

/**
 * A neutral constituent may seed a composition when it has complete, bounded,
 * observed evidence and causes no baseline regression. Individual benefit is
 * deliberately left to the best-single arm rather than used as a pair gate.
 */
function rankedInteractionReadySingles<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
): CrossSurfaceCandidateSummary[] {
  return [...context.singleByComponent.values()]
    .map((candidate) => summaryById.get(candidate.candidateId)!)
    .filter(
      (summary) =>
        summary.outcome.regressionTaskIds.length === 0 &&
        summary.eligibility?.reasons.every(
          (reason) => reason === 'benefit_not_greater_than_regression',
        ),
    )
    .sort((left, right) => compareSingleSummaries(context, left, right))
}

function compareSingleSummaries<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  left: CrossSurfaceCandidateSummary,
  right: CrossSurfaceCandidateSummary,
): number {
  const byNetBenefit = right.outcome.netBenefit - left.outcome.netBenefit
  if (byNetBenefit !== 0) return byNetBenefit
  const byBenefit = right.outcome.benefitTaskIds.length - left.outcome.benefitTaskIds.length
  if (byBenefit !== 0) return byBenefit
  const byRegression =
    left.outcome.regressionTaskIds.length - right.outcome.regressionTaskIds.length
  if (byRegression !== 0) return byRegression
  for (const metric of context.input.costMetricOrder) {
    const byCost = left.costs[metric]!.median - right.costs[metric]!.median
    if (byCost !== 0) return byCost
  }
  const byBytes = left.candidate.artifactBytes - right.candidate.artifactBytes
  if (byBytes !== 0) return byBytes
  return (
    context.candidateIndex.get(left.candidate.candidateId)! -
    context.candidateIndex.get(right.candidate.candidateId)!
  )
}

function buildPairwise<TRow extends CrossSurfaceTaskRow>(
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

function selectCandidates<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
  eligibleSingles: CrossSurfaceCandidateSummary[],
  interactionReadySingles: CrossSurfaceCandidateSummary[],
  pairwise: CrossSurfacePairwiseEntry[],
): CrossSurfaceSelections {
  const bestSingleRanking = eligibleSingles.filter((summary) => {
    const componentId = summary.candidate.componentIds[0]!
    return context.componentById.get(componentId)!.bestSingleEligible
  })
  const ranking: CrossSurfaceRankedSingle[] = bestSingleRanking.map((summary, index) => ({
    rank: index + 1,
    candidateId: summary.candidate.candidateId,
    componentId: summary.candidate.componentIds[0]!,
  }))
  const best = bestSingleRanking[0]
  const bestSingle = best
    ? {
        candidateId: best.candidate.candidateId,
        componentId: best.candidate.componentIds[0]!,
        ranking,
      }
    : null
  const naiveStack = selectNaiveStack(context, interactionReadySingles)
  const interactionAware = selectInteractionAware(
    context,
    summaryById,
    interactionReadySingles,
    pairwise,
  )
  return { bestSingle, naiveStack, interactionAware }
}

function selectNaiveStack<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  eligibleSingles: CrossSurfaceCandidateSummary[],
): CrossSurfaceNaiveStackSelection | null {
  if (eligibleSingles.length === 0) return null
  const componentIds = eligibleSingles
    .map((summary) => summary.candidate.componentIds[0]!)
    .sort((left, right) => context.componentIndex.get(left)! - context.componentIndex.get(right)!)
  const candidate = context.candidateByComponents.get(componentSetKey(componentIds))
  if (!candidate) {
    throw new ValidationError(
      `analyzeCrossSurfaceInteractions: naive stack [${componentIds.join(', ')}] was not evaluated`,
    )
  }
  return { candidateId: candidate.candidateId, componentIds }
}

function selectInteractionAware<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
  interactionReadySingles: CrossSurfaceCandidateSummary[],
  pairwise: CrossSurfacePairwiseEntry[],
): CrossSurfaceInteractionAwareSelection | null {
  const baseline = summaryById.get(context.input.baselineCandidateId)!
  const pairByComponents = new Map(
    pairwise.map((entry) => [componentSetKey(entry.componentIds), entry]),
  )
  const paths = pairwise
    .filter((entry) => entry.compatibility.compatible)
    .map((entry) =>
      growInteractionPath(
        context,
        summaryById,
        interactionReadySingles,
        pairByComponents,
        baseline,
        summaryById.get(entry.compositionCandidateId)!,
      ),
    )
  if (paths.length === 0) return null

  const qualified = paths
    .filter((path) => path.qualified)
    .sort((left, right) => compareInteractionPaths(context, summaryById, left, right))
  const winning =
    qualified[0] ??
    [...paths].sort((left, right) => compareInteractionPaths(context, summaryById, left, right))[0]!
  return {
    seedCandidateId: winning.seedCandidateId,
    terminalCandidateId: winning.terminalCandidateId,
    terminalComponentIds: [...winning.terminalComponentIds],
    selectedCandidateId: qualified.length > 0 ? winning.terminalCandidateId : null,
    qualified: qualified.length > 0,
    evaluatedPaths: paths,
    steps: winning.steps,
  }
}

function growInteractionPath<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
  interactionReadySingles: CrossSurfaceCandidateSummary[],
  pairByComponents: Map<string, CrossSurfacePairwiseEntry>,
  baseline: CrossSurfaceCandidateSummary,
  seed: CrossSurfaceCandidateSummary,
): CrossSurfaceInteractionPath {
  let current = seed
  let retained = [...seed.candidate.componentIds]
  let remaining = interactionReadySingles.filter(
    (summary) => !retained.includes(summary.candidate.componentIds[0]!),
  )
  const steps: CrossSurfaceCompositionStep[] = []

  while (remaining.length > 0) {
    const decisions = remaining.map((addition) =>
      evaluateAddition(
        context,
        summaryById,
        pairByComponents,
        baseline,
        current,
        retained,
        addition,
      ),
    )
    const eligible = decisions
      .filter((decision) => decision.eligible)
      .sort((left, right) => compareAdditionDecisions(context, summaryById, left, right))
    const selected = eligible[0]
    if (selected) selected.selected = true
    steps.push({
      fromCandidateId: current.candidate.candidateId,
      retainedComponentIds: [...retained],
      considered: decisions.sort(
        (left, right) =>
          context.candidateIndex.get(left.additionCandidateId)! -
          context.candidateIndex.get(right.additionCandidateId)!,
      ),
      selectedCandidateId: selected?.bundleCandidateId ?? null,
    })
    if (!selected?.bundleCandidateId) break
    current = summaryById.get(selected.bundleCandidateId)!
    retained = [...current.candidate.componentIds]
    remaining = remaining.filter(
      (summary) => summary.candidate.candidateId !== selected.additionCandidateId,
    )
  }

  const qualified = retained.length >= context.input.selection.minimumBundleComponents
  return {
    seedCandidateId: seed.candidate.candidateId,
    terminalCandidateId: current.candidate.candidateId,
    terminalComponentIds: retained,
    qualified,
    steps,
  }
}

function compareInteractionPaths<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
  left: CrossSurfaceInteractionPath,
  right: CrossSurfaceInteractionPath,
): number {
  const leftSummary = summaryById.get(left.terminalCandidateId)!
  const rightSummary = summaryById.get(right.terminalCandidateId)!
  const byNetBenefit = rightSummary.outcome.netBenefit - leftSummary.outcome.netBenefit
  if (byNetBenefit !== 0) return byNetBenefit
  const byBenefit =
    rightSummary.outcome.benefitTaskIds.length - leftSummary.outcome.benefitTaskIds.length
  if (byBenefit !== 0) return byBenefit
  const byRegression =
    leftSummary.outcome.regressionTaskIds.length - rightSummary.outcome.regressionTaskIds.length
  if (byRegression !== 0) return byRegression
  for (const metric of context.input.costMetricOrder) {
    const byCost = leftSummary.costs[metric]!.median - rightSummary.costs[metric]!.median
    if (byCost !== 0) return byCost
  }
  const byBytes = leftSummary.candidate.artifactBytes - rightSummary.candidate.artifactBytes
  if (byBytes !== 0) return byBytes
  const byCandidateOrder =
    context.candidateIndex.get(left.terminalCandidateId)! -
    context.candidateIndex.get(right.terminalCandidateId)!
  if (byCandidateOrder !== 0) return byCandidateOrder
  return (
    context.candidateIndex.get(left.seedCandidateId)! -
    context.candidateIndex.get(right.seedCandidateId)!
  )
}

function evaluateAddition<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
  pairByComponents: Map<string, CrossSurfacePairwiseEntry>,
  baseline: CrossSurfaceCandidateSummary,
  current: CrossSurfaceCandidateSummary,
  retained: string[],
  addition: CrossSurfaceCandidateSummary,
): CrossSurfaceAdditionDecision {
  const additionComponentId = addition.candidate.componentIds[0]!
  const reasons: CrossSurfaceAdditionRejectionReason[] = []
  for (const retainedComponentId of retained) {
    const pair = pairByComponents.get(
      componentSetKey(canonicalComponents(context, [retainedComponentId, additionComponentId])),
    )
    if (!pair?.compatibility.compatible) reasons.push('pair_incompatible')
  }
  const bundleComponents = canonicalComponents(context, [...retained, additionComponentId])
  const bundle = context.candidateByComponents.get(componentSetKey(bundleComponents))
  if (!bundle) {
    reasons.push('full_bundle_not_evaluated')
    return emptyAdditionDecision(addition, additionComponentId, reasons)
  }
  const bundleSummary = summaryById.get(bundle.candidateId)!
  if (
    bundleSummary.outcome.missingTaskIds.length > 0 ||
    bundleSummary.outcome.invalidTaskIds.length > 0 ||
    bundleSummary.outcome.comparisonMissingTaskIds.length > 0
  ) {
    reasons.push('bundle_incomplete')
  }
  if (bundleSummary.outcome.regressionTaskIds.length > 0) reasons.push('baseline_regression')
  const comparison = compareCandidates(
    context,
    summaryById,
    current.candidate.candidateId,
    bundle.candidateId,
  )
  if (comparison.winsTaskIds.length === 0) reasons.push('no_incremental_resolution')
  if (comparison.regressionTaskIds.length > 0) reasons.push('incremental_regression')
  appendBundleEvidenceReasons(
    reasons,
    bundleSummary.firing,
    context.input.selection.minimumFiringTasks,
    context.input.selection.requireObservedFiring,
    'firing_below_minimum',
    'firing_unobserved',
  )
  appendBundleEvidenceReasons(
    reasons,
    bundleSummary.effect,
    context.input.selection.minimumEffectTasks,
    context.input.selection.requireObservedEffect,
    'effect_below_minimum',
    'effect_unobserved',
  )
  if (!withinCostLimits(context, bundleSummary, baseline)) reasons.push('cost_limit_exceeded')
  return {
    additionCandidateId: addition.candidate.candidateId,
    additionComponentId,
    bundleCandidateId: bundle.candidateId,
    incrementalResolutionTaskIds: comparison.winsTaskIds,
    incrementalRegressionTaskIds: comparison.regressionTaskIds,
    incrementalMedianCost: Object.fromEntries(
      context.input.costMetricOrder.map((metric) => [
        metric,
        bundleSummary.costs[metric]!.median - current.costs[metric]!.median,
      ]),
    ),
    eligible: reasons.length === 0,
    selected: false,
    reasons: unique(reasons),
  }
}

function emptyAdditionDecision(
  addition: CrossSurfaceCandidateSummary,
  additionComponentId: string,
  reasons: CrossSurfaceAdditionRejectionReason[],
): CrossSurfaceAdditionDecision {
  return {
    additionCandidateId: addition.candidate.candidateId,
    additionComponentId,
    bundleCandidateId: null,
    incrementalResolutionTaskIds: [],
    incrementalRegressionTaskIds: [],
    incrementalMedianCost: null,
    eligible: false,
    selected: false,
    reasons: unique(reasons),
  }
}

function appendBundleEvidenceReasons(
  reasons: CrossSurfaceAdditionRejectionReason[],
  evidence: CrossSurfaceCandidateEvidence,
  minimum: number,
  requireObserved: boolean,
  belowReason: CrossSurfaceAdditionRejectionReason,
  unobservedReason: CrossSurfaceAdditionRejectionReason,
): void {
  if (evidence.byComponent.some((component) => component.observedTaskIds.length < minimum)) {
    reasons.push(belowReason)
  }
  if (
    requireObserved &&
    evidence.byComponent.some((component) => component.unobservedTaskIds.length > 0)
  ) {
    reasons.push(unobservedReason)
  }
}

function compareAdditionDecisions<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
  left: CrossSurfaceAdditionDecision,
  right: CrossSurfaceAdditionDecision,
): number {
  const byWins =
    right.incrementalResolutionTaskIds.length - left.incrementalResolutionTaskIds.length
  if (byWins !== 0) return byWins
  for (const metric of context.input.costMetricOrder) {
    const byCost = left.incrementalMedianCost![metric]! - right.incrementalMedianCost![metric]!
    if (byCost !== 0) return byCost
  }
  const leftBytes = summaryById.get(left.additionCandidateId)!.candidate.artifactBytes
  const rightBytes = summaryById.get(right.additionCandidateId)!.candidate.artifactBytes
  const byBytes = leftBytes - rightBytes
  if (byBytes !== 0) return byBytes
  return (
    context.candidateIndex.get(left.additionCandidateId)! -
    context.candidateIndex.get(right.additionCandidateId)!
  )
}

function compareCandidates<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  summaryById: Map<string, CrossSurfaceCandidateSummary>,
  comparatorCandidateId: string,
  treatmentCandidateId: string,
): CrossSurfaceCandidateComparison {
  const winsTaskIds: string[] = []
  const regressionTaskIds: string[] = []
  const missingTaskIds: string[] = []
  for (const taskId of context.input.taskOrder) {
    const comparator = rowFor(context, comparatorCandidateId, taskId)
    const treatment = rowFor(context, treatmentCandidateId, taskId)
    if (comparator.completeness !== 'complete' || treatment.completeness !== 'complete') {
      missingTaskIds.push(taskId)
    } else if (treatment.pass && !comparator.pass) winsTaskIds.push(taskId)
    else if (!treatment.pass && comparator.pass) regressionTaskIds.push(taskId)
  }
  return {
    comparatorCandidateId,
    treatmentCandidateId,
    winsTaskIds,
    regressionTaskIds,
    missingTaskIds,
    paired: pairedComparison(context, comparatorCandidateId, treatmentCandidateId),
    relativeCost: relativeCosts(
      context,
      summaryById.get(treatmentCandidateId)!,
      summaryById.get(comparatorCandidateId)!,
    ),
  }
}

function pairedComparison<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  comparatorCandidateId: string,
  treatmentCandidateId: string,
): PairedArmsComparison {
  const rows: PairedArmRow[] = []
  for (const taskId of context.input.taskOrder) {
    rows.push(toPairedArmRow(context, rowFor(context, comparatorCandidateId, taskId)))
    rows.push(toPairedArmRow(context, rowFor(context, treatmentCandidateId, taskId)))
  }
  return comparePairedArms(rows, {
    baselineArm: comparatorCandidateId,
    treatmentArm: treatmentCandidateId,
    metricNames: ['score', ...context.input.costMetricOrder],
    bootstrap: { ...context.input.bootstrap, statistic: 'mean' },
  })
}

function toPairedArmRow<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  row: TRow,
): PairedArmRow {
  const metrics: Record<string, number> = Object.fromEntries(
    context.input.costMetricOrder.map((metric) => [metric, row.cost[metric] as number]),
  )
  if (row.completeness === 'complete') metrics.score = row.score as number
  return {
    pairKey: row.taskId,
    arm: row.candidateId,
    ...(row.completeness === 'complete' ? { pass: row.pass as boolean } : {}),
    metrics,
  }
}

function summarizePairEvidence<TRow extends CrossSurfaceTaskRow>(
  rows: TRow[],
  leftComponentId: string,
  rightComponentId: string,
  field: 'fired' | 'effectObserved',
): CrossSurfacePairEvidence {
  const bothTaskIds: string[] = []
  const leftOnlyTaskIds: string[] = []
  const rightOnlyTaskIds: string[] = []
  const neitherTaskIds: string[] = []
  const unobservedTaskIds: string[] = []
  for (const row of rows) {
    const left = evidenceValue(row, leftComponentId, field)
    const right = evidenceValue(row, rightComponentId, field)
    if (left === null || right === null) unobservedTaskIds.push(row.taskId)
    else if (left && right) bothTaskIds.push(row.taskId)
    else if (left) leftOnlyTaskIds.push(row.taskId)
    else if (right) rightOnlyTaskIds.push(row.taskId)
    else neitherTaskIds.push(row.taskId)
  }
  return {
    bothTaskIds,
    leftOnlyTaskIds,
    rightOnlyTaskIds,
    neitherTaskIds,
    unobservedTaskIds,
  }
}

function relativeCosts<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  treatment: CrossSurfaceCandidateSummary,
  comparator: CrossSurfaceCandidateSummary,
): Record<string, CrossSurfaceRelativeCost> {
  return Object.fromEntries(
    context.input.costMetricOrder.map((metric) => {
      const treatmentMedian = treatment.costs[metric]!.median
      const comparatorMedian = comparator.costs[metric]!.median
      return [
        metric,
        {
          treatmentMedian,
          comparatorMedian,
          medianDelta: treatmentMedian - comparatorMedian,
          medianRatio:
            comparatorMedian === 0
              ? treatmentMedian === 0
                ? 1
                : null
              : treatmentMedian / comparatorMedian,
        },
      ]
    }),
  )
}

function withinCostLimits<TRow extends CrossSurfaceTaskRow>(
  context: AnalysisContext<TRow>,
  treatment: CrossSurfaceCandidateSummary,
  baseline: CrossSurfaceCandidateSummary,
): boolean {
  const relative = relativeCosts(context, treatment, baseline)
  return Object.entries(context.input.selection.maximumMedianCostRatioToBaseline).every(
    ([metric, limit]) => {
      const ratio = relative[metric]!.medianRatio
      return ratio !== null && ratio <= limit
    },
  )
}

function distribution(values: number[]): CrossSurfaceDistribution {
  const sorted = [...values].sort((left, right) => left - right)
  const total = sorted.reduce((sum, value) => sum + value, 0)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  return {
    n: sorted.length,
    min: sorted[0]!,
    median,
    mean: total / sorted.length,
    max: sorted[sorted.length - 1]!,
    total,
  }
}

function evidenceValue(
  row: CrossSurfaceTaskRow,
  componentId: string,
  field: 'fired' | 'effectObserved',
): boolean | null {
  return row.componentEvidence.find((evidence) => evidence.componentId === componentId)![field]
}

function meanOrNull(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}
