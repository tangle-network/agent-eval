export {
  assertReleaseConfidence,
  evaluateReleaseConfidence,
  releaseTraceEvidenceFromMultiShotTrials,
} from './release-confidence'
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

export { renderReleaseReport } from './release-report'
export type { RenderReleaseReportOptions } from './release-report'

export {
  gainHistogram,
  paretoChart,
  researchReport,
  summaryTable,
} from './summary-report'
export { RESEARCH_REPORT_HARD_PAIR_FLOOR } from './summary-report'
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
  bhAdjust,
  pairedBootstrap,
  pairedWilcoxon,
} from './paired-stats'
export type {
  PairedBootstrapOptions,
  PairedBootstrapResult,
} from './paired-stats'

export {
  bootstrapCi,
  judgeReplayGate,
} from './promotion-gate'
export type {
  BootstrapOptions,
  BootstrapResult,
  JudgeReplayGateArgs,
  Verdict,
} from './promotion-gate'
