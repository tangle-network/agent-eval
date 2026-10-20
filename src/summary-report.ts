/** Production summaries, plotting specifications, and research reports. */

export type {
  ResearchReport,
  ResearchReportCandidate,
  ResearchReportDecision,
  ResearchReportMethodology,
  ResearchReportOptions,
  ResearchReportRecommendation,
} from './research-report'
export { RESEARCH_REPORT_HARD_PAIR_FLOOR, researchReport } from './research-report'
export type {
  GainDistributionBin,
  GainDistributionFigureSpec,
  GainDistributionOptions,
  ParetoFigureSpec,
  ParetoPoint,
  SummaryTable,
  SummaryTableOptions,
  SummaryTableRow,
} from './summary-report-figures'
export { gainHistogram, paretoChart, summaryTable } from './summary-report-figures'
