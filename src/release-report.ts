import type { ReleaseConfidenceScorecard } from './release-confidence'
import type { RunRecord } from './run-record'
import { summaryTable } from './summary-report'

export interface RenderReleaseReportOptions {
  title?: string
  runs?: readonly RunRecord[]
  comparator?: string
  traceAnalystFindings?: readonly string[]
  nextActions?: readonly string[]
}

export function renderReleaseReport(
  scorecard: ReleaseConfidenceScorecard,
  options: RenderReleaseReportOptions = {},
): string {
  const title = options.title ?? `Release Report: ${scorecard.target}`
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`Status: **${scorecard.status.toUpperCase()}**`)
  lines.push(`Promote: **${scorecard.promote ? 'yes' : 'no'}**`)
  if (scorecard.candidateId) lines.push(`Candidate: \`${scorecard.candidateId}\``)
  if (scorecard.baselineId) lines.push(`Baseline: \`${scorecard.baselineId}\``)
  lines.push('')
  lines.push(scorecard.summary)
  lines.push('')

  lines.push('## Metrics')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('|---|---:|')
  lines.push(`| Scenarios | ${scorecard.metrics.scenarioCount} |`)
  lines.push(`| Search runs | ${scorecard.metrics.searchRuns} |`)
  lines.push(`| Holdout runs | ${scorecard.metrics.holdoutRuns} |`)
  lines.push(`| Pass rate | ${pct(scorecard.metrics.passRate)} |`)
  lines.push(`| Mean score | ${num(scorecard.metrics.meanScore)} |`)
  lines.push(`| Search mean | ${num(scorecard.metrics.searchMeanScore)} |`)
  lines.push(`| Holdout mean | ${num(scorecard.metrics.holdoutMeanScore)} |`)
  lines.push(`| Overfit gap | ${num(scorecard.metrics.overfitGap)} |`)
  lines.push(`| Mean cost | $${num(scorecard.metrics.meanCostUsd)} |`)
  lines.push(`| p95 wall time | ${Math.round(scorecard.metrics.p95WallMs)} ms |`)
  lines.push('')

  if (scorecard.issues.length > 0) {
    lines.push('## Issues')
    lines.push('')
    for (const issue of scorecard.issues) {
      lines.push(`- **${issue.severity}** \`${issue.code}\` (${issue.axis}): ${issue.detail}`)
    }
    lines.push('')
  }

  const surfaces = entries(scorecard.metrics.responsibleSurfaceCounts)
  if (surfaces.length > 0) {
    lines.push('## Responsible Surfaces')
    lines.push('')
    for (const [surface, count] of surfaces) lines.push(`- ${surface}: ${count}`)
    lines.push('')
  }

  const failures = entries(scorecard.metrics.failureModeCounts)
  if (failures.length > 0) {
    lines.push('## Failure Modes')
    lines.push('')
    for (const [mode, count] of failures) lines.push(`- ${mode}: ${count}`)
    lines.push('')
  }

  if (options.runs && options.runs.length > 0) {
    lines.push('## Run Summary')
    lines.push('')
    lines.push(
      summaryTable([...options.runs], {
        comparator: options.comparator ?? scorecard.baselineId ?? undefined,
        split: 'holdout',
      }).markdown,
    )
    lines.push('')
  }

  if (options.traceAnalystFindings && options.traceAnalystFindings.length > 0) {
    lines.push('## TraceAnalyst Findings')
    lines.push('')
    for (const finding of options.traceAnalystFindings) lines.push(`- ${finding}`)
    lines.push('')
  }

  const nextActions = options.nextActions ?? defaultNextActions(scorecard)
  if (nextActions.length > 0) {
    lines.push('## Next Actions')
    lines.push('')
    for (const action of nextActions) lines.push(`- ${action}`)
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function defaultNextActions(scorecard: ReleaseConfidenceScorecard): string[] {
  if (scorecard.promote) return ['Promote the candidate and keep canaries enabled.']
  return scorecard.issues
    .filter((issue) => issue.severity === 'critical')
    .map((issue) => `Resolve ${issue.code}: ${issue.detail}`)
}

function entries(values: Record<string, number>): Array<[string, number]> {
  return Object.entries(values)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a'
}

function num(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : 'n/a'
}
