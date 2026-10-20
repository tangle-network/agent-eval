/** Markdown research reports and their shared numeric text formatting. */

import type { FailureClusterReport } from './pipelines/failure-cluster'
import type {
  ResearchReportCandidate,
  ResearchReportMethodology,
  ResearchReportRecommendation,
} from './research-report'
import type {
  GainDistributionFigureSpec,
  ParetoFigureSpec,
  SummaryTable,
} from './summary-report-figures'

export function renderResearchMarkdown(report: {
  title: string
  generatedAt: string
  split: 'search' | 'holdout'
  comparator: string | null
  executiveSummary: string[]
  recommendation: ResearchReportRecommendation
  candidates: ResearchReportCandidate[]
  summary: SummaryTable
  pareto: ParetoFigureSpec
  gains: GainDistributionFigureSpec[]
  rope: { low: number; high: number } | null
  runFingerprint: string
  preregistrationHash: string | null
  methodology: ResearchReportMethodology
  failureClusters?: FailureClusterReport
}): string {
  const lines: string[] = []
  lines.push(`# ${report.title}`)
  lines.push('')
  lines.push(`**Generated:** ${report.generatedAt}`)
  lines.push(`**Primary split:** ${report.split}`)
  lines.push(`**Comparator:** ${report.comparator ?? 'not configured'}`)
  lines.push(`**ROPE:** ${report.rope ? formatRope(report.rope) : 'not configured'}`)
  lines.push(`**Run fingerprint:** \`${report.runFingerprint}\``)
  lines.push(
    `**Preregistration:** ${report.preregistrationHash ? `\`${report.preregistrationHash}\`` : 'none'}`,
  )
  lines.push('')
  lines.push('## Executive Summary')
  lines.push('')
  for (const item of report.executiveSummary) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Recommendation')
  lines.push('')
  lines.push(`**Decision:** ${report.recommendation.decision}`)
  lines.push(`**Candidate:** ${report.recommendation.candidateId ?? 'N/A'}`)
  lines.push('')
  lines.push('### Rationale')
  lines.push('')
  for (const item of report.recommendation.rationale) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### Risks')
  lines.push('')
  for (const item of report.recommendation.risks.length
    ? report.recommendation.risks
    : ['No material report-level risks detected.']) {
    lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('### Next Actions')
  lines.push('')
  for (const item of report.recommendation.nextActions) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Candidate Decision Table')
  lines.push('')
  lines.push(
    '| Candidate | Decision | Mean | Δ̄ | Pr(Δ>0) | q | dz | Paired N | Median Gain CI | MDE | Pareto | Gate |',
  )
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|---|')
  for (const c of report.candidates) {
    const delta = c.meanDeltaVsComparator === null ? '-' : signed(c.meanDeltaVsComparator)
    const prGt = c.prGreaterThanZero === null ? '-' : c.prGreaterThanZero.toFixed(3)
    const q = c.qValue !== null ? c.qValue.toFixed(4) : '-'
    const d = c.cohensD !== null ? c.cohensD.toFixed(3) : '-'
    const gain = c.gainCi ? `[${fmt(c.gainCi.low)}, ${fmt(c.gainCi.high)}]` : '-'
    const mde = c.mde === null || !Number.isFinite(c.mde) ? '-' : fmt(c.mde)
    lines.push(
      `| ${c.candidateId} | ${c.decision} | ${fmt(c.mean)} | ${delta} | ${prGt} | ${q} | ${d} | ${c.pairedN} | ${gain} | ${mde} | ${c.onParetoFrontier ? 'yes' : 'no'} | ${c.gate ?? '-'} |`,
    )
  }
  lines.push('')
  lines.push('## Statistical Summary')
  lines.push('')
  lines.push(report.summary.markdown)
  lines.push('')
  lines.push('## Methodology')
  lines.push('')
  lines.push('### Assumptions')
  lines.push('')
  for (const item of report.methodology.assumptions) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### Methods')
  lines.push('')
  for (const item of report.methodology.methods) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### Alternatives Considered')
  lines.push('')
  for (const item of report.methodology.alternatives) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### When NOT To Apply')
  lines.push('')
  for (const item of report.methodology.whenNotToApply) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### Citations')
  lines.push('')
  for (const item of report.methodology.citations) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Chart Specs')
  lines.push('')
  lines.push(
    'The report carries JSON chart specs for Pareto cost/quality and paired gain histograms.',
  )
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify({ pareto: report.pareto, gains: report.gains }, null, 2))
  lines.push('```')
  if (report.failureClusters) {
    lines.push('')
    lines.push('## Failure Clusters')
    lines.push('')
    lines.push('| Failure Class | Runs | Scenarios | Tool | Example |')
    lines.push('|---|---:|---:|---|---|')
    for (const c of report.failureClusters.clusters.slice(0, 10)) {
      lines.push(
        `| ${c.failureClass} | ${c.runCount} | ${c.scenarioIds.length} | ${c.toolName ?? '-'} | ${escapePipes(c.exampleError ?? c.exampleRunId)} |`,
      )
    }
  }
  return lines.join('\n')
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|')
}

function signed(x: number): string {
  return `${x >= 0 ? '+' : ''}${fmt(x)}`
}

export function formatRope(rope: { low: number; high: number }): string {
  return `[${fmt(rope.low)}, ${fmt(rope.high)}]`
}

export function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  return x.toFixed(4)
}
