import {
  distribution,
  pairedComparison,
  unique,
  withinCostLimits,
} from './cross-surface-comparison'
import {
  type CrossSurfaceAnalysisContext as AnalysisContext,
  crossSurfaceRowsFor as rowsFor,
} from './cross-surface-context'
import {
  appendEvidenceReasons as appendEvidenceEligibilityReasons,
  summarizeCandidateEvidence,
} from './cross-surface-evidence'
import type {
  CrossSurfaceCandidate,
  CrossSurfaceCandidateOutcome,
  CrossSurfaceCandidateSummary,
  CrossSurfaceEligibility,
  CrossSurfaceIneligibilityReason,
  CrossSurfaceTaskRow,
} from './cross-surface-types'

export function summarizeCandidate<TRow extends CrossSurfaceTaskRow>(
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

export function candidateEligibility<TRow extends CrossSurfaceTaskRow>(
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

export function rankedEligibleSingles<TRow extends CrossSurfaceTaskRow>(
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
export function rankedInteractionReadySingles<TRow extends CrossSurfaceTaskRow>(
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

export function compareSingleSummaries<TRow extends CrossSurfaceTaskRow>(
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
