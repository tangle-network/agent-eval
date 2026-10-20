import { comparePairedArms, type PairedArmRow, type PairedArmsComparison } from '../paired-arms'
import {
  type CrossSurfaceAnalysisContext as AnalysisContext,
  crossSurfaceRowFor as rowFor,
} from './cross-surface-context'
import type {
  CrossSurfaceCandidateComparison,
  CrossSurfaceCandidateSummary,
  CrossSurfaceDistribution,
  CrossSurfaceRelativeCost,
  CrossSurfaceTaskRow,
} from './cross-surface-types'

export function compareCandidates<TRow extends CrossSurfaceTaskRow>(
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

export function pairedComparison<TRow extends CrossSurfaceTaskRow>(
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

export function relativeCosts<TRow extends CrossSurfaceTaskRow>(
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

export function withinCostLimits<TRow extends CrossSurfaceTaskRow>(
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

export function distribution(values: number[]): CrossSurfaceDistribution {
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

export function meanOrNull(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}
