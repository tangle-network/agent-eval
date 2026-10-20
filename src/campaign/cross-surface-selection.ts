import { ValidationError } from '../errors'
import { compareCandidates, unique, withinCostLimits } from './cross-surface-comparison'
import {
  type CrossSurfaceAnalysisContext as AnalysisContext,
  canonicalCrossSurfaceComponents as canonicalComponents,
  crossSurfaceComponentSetKey as componentSetKey,
} from './cross-surface-context'
import { appendEvidenceReasons as appendBundleEvidenceReasons } from './cross-surface-evidence'
import type {
  CrossSurfaceAdditionDecision,
  CrossSurfaceAdditionRejectionReason,
  CrossSurfaceCandidateSummary,
  CrossSurfaceCompositionStep,
  CrossSurfaceInteractionAwareSelection,
  CrossSurfaceInteractionPath,
  CrossSurfaceNaiveStackSelection,
  CrossSurfacePairwiseEntry,
  CrossSurfaceRankedSingle,
  CrossSurfaceSelections,
  CrossSurfaceTaskRow,
} from './cross-surface-types'

export function selectCandidates<TRow extends CrossSurfaceTaskRow>(
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
  const naiveStack = selectNaiveStack(context, eligibleSingles)
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
