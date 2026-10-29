export type {
  RubricOutcomePair,
  RubricPredictiveValidityInput,
  RubricPredictiveValidityReport,
  RubricRanking,
} from './meta-eval/rubric-predictive-validity'
export { rubricPredictiveValidity } from './meta-eval/rubric-predictive-validity'
export type {
  BootstrapOptions,
  BootstrapResult,
  JudgeReplayGateArgs,
  Verdict,
} from './promotion-gate'
export {
  bootstrapCi,
  judgeReplayGate,
} from './promotion-gate'
export type {
  ReleaseConfidenceAxis,
  ReleaseConfidenceAxisName,
  ReleaseConfidenceInput,
  ReleaseConfidenceIssue,
  ReleaseConfidenceMetrics,
  ReleaseConfidenceScorecard,
  ReleaseConfidenceStatus,
  ReleaseConfidenceThresholds,
  ReleaseTraceEvidence,
} from './release-confidence'
export { evaluateReleaseConfidence } from './release-confidence'
export type {
  InterimReleaseConfidence,
  InterimReleaseConfidenceInput,
  PairedEvalueOptions,
  PairedEvalueSequence,
  PairedEvalueStep,
  SequentialDecision,
} from './sequential'
export {
  evaluateInterimReleaseConfidence,
  pairedEvalueSequence,
} from './sequential'
export type {
  PairedBootstrapOptions,
  PairedBootstrapResult,
} from './statistics'
export {
  benjaminiHochberg,
  pairedBootstrap,
  wilcoxonSignedRank,
} from './statistics'
export type {
  GainDistributionBin,
  GainDistributionFigureSpec,
  GainDistributionOptions,
  ParetoFigureSpec,
  ParetoPoint,
  ResearchReport,
  ResearchReportCandidate,
  ResearchReportDecision,
  ResearchReportMethodology,
  ResearchReportOptions,
  ResearchReportRecommendation,
  SummaryTable,
  SummaryTableOptions,
  SummaryTableRow,
} from './summary-report'
export {
  gainHistogram,
  RESEARCH_REPORT_HARD_PAIR_FLOOR,
  researchReport,
  summaryTable,
} from './summary-report'

/** A text report column; `none` leaves the cell unpadded. */
export interface ReportTableColumn {
  header: string
  align?: 'left' | 'right' | 'none'
}

/** Render already-formatted measurements without changing values or missing-data labels. */
export function formatReportTable(
  columns: readonly ReportTableColumn[],
  rows: readonly (readonly string[])[],
): string {
  const table = [columns.map((column) => column.header), ...rows]
  const widths = columns.map((_, index) =>
    Math.max(...table.map((row) => (row[index] ?? '').length)),
  )
  return table
    .map((row) =>
      columns
        .map((column, index) => {
          const value = row[index] ?? ''
          if (column.align === 'none') return value
          return column.align === 'right'
            ? value.padStart(widths[index]!)
            : value.padEnd(widths[index]!)
        })
        .join('  '),
    )
    .join('\n')
}
