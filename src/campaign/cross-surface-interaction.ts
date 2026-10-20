/**
 * Task-paired comparison and deterministic selection for independently
 * proposed agent surfaces. Unlike factorial cell-mean attribution, every
 * benefit, regression, and interaction remains attached to its task row.
 */

import { validateCrossSurfaceInput as validateAndIndex } from './cross-surface-context'
import { buildPairwise } from './cross-surface-pairwise'
import { selectCandidates } from './cross-surface-selection'
import {
  candidateEligibility,
  rankedEligibleSingles,
  rankedInteractionReadySingles,
  summarizeCandidate,
} from './cross-surface-summary'
import type {
  AnalyzeCrossSurfaceInteractionsInput,
  CrossSurfaceInteractionReport,
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
