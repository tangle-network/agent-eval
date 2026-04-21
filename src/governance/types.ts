/**
 * Governance reporting — shared types.
 *
 * The framework collects a `GovernanceContext` (traces + outcomes +
 * dataset manifests + red-team results + judge calibration) and each
 * specific template (NIST AI RMF, SOC2, EU AI Act) renders a
 * structured report from it.
 *
 * Reports are machine-readable JSON first; human-readable Markdown is a
 * pure transform on top. External auditors consume the Markdown; CI
 * consumes the JSON.
 */

import type { DatasetManifest } from '../dataset'
import type { TraceStore } from '../trace/store'
import type { OutcomeStore } from '../meta-eval/outcome-store'
import type { RedTeamReport } from '../red-team'
import type { CalibrationResult } from '../judge-calibration'

export interface GovernanceContext {
  /** Legal / org identity for the report. */
  organization: string
  /** System / agent identifier. */
  systemName: string
  /** ISO8601 period the report covers. */
  periodStart: string
  periodEnd: string
  /** Versioned dataset manifests used during the period. */
  datasets: DatasetManifest[]
  traceStore: TraceStore
  outcomeStore?: OutcomeStore
  /** Cached red-team results for the period, if available. */
  redTeam?: RedTeamReport
  /** Judge-vs-human calibration results, if measured. */
  judgeCalibration?: CalibrationResult[]
  /** Responsible owner for the system — role + name + email. */
  owner: { role: string; name: string; email: string }
}

export interface GovernanceFinding {
  id: string
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  /** Control reference the finding maps to (e.g. "NIST-AI-RMF:MEASURE-2.1"). */
  control: string
  summary: string
  evidence?: string
  remediation?: string
}

export interface GovernanceReport {
  framework: 'NIST-AI-RMF' | 'SOC2' | 'EU-AI-ACT'
  version: string
  context: Pick<GovernanceContext, 'organization' | 'systemName' | 'periodStart' | 'periodEnd' | 'owner'>
  summary: {
    findings: number
    byeverity: Record<GovernanceFinding['severity'], number>
    overall: 'compliant' | 'compliant-with-findings' | 'non-compliant'
  }
  findings: GovernanceFinding[]
  /** Framework-specific structured payload (mapped controls, risk class, etc.). */
  payload: Record<string, unknown>
  generatedAt: string
}

export function renderMarkdown(report: GovernanceReport): string {
  const sevEmoji: Record<GovernanceFinding['severity'], string> = {
    info: 'ℹ︎', low: '·', medium: '!', high: '!!', critical: '‼',
  }
  const lines: string[] = []
  lines.push(`# ${report.framework} report — ${report.context.systemName}`)
  lines.push('')
  lines.push(`- Organization: **${report.context.organization}**`)
  lines.push(`- Period: ${report.context.periodStart} → ${report.context.periodEnd}`)
  lines.push(`- Owner: ${report.context.owner.role} ${report.context.owner.name} <${report.context.owner.email}>`)
  lines.push(`- Generated: ${report.generatedAt}`)
  lines.push('')
  lines.push(`## Summary — ${report.summary.overall}`)
  lines.push('')
  lines.push(`${report.summary.findings} finding(s).`)
  for (const [sev, n] of Object.entries(report.summary.byeverity) as Array<[GovernanceFinding['severity'], number]>) {
    if (n > 0) lines.push(`- ${sevEmoji[sev]} ${sev}: ${n}`)
  }
  lines.push('')
  lines.push('## Findings')
  lines.push('')
  for (const f of report.findings) {
    lines.push(`### ${sevEmoji[f.severity]} ${f.id} — ${f.control}`)
    lines.push('')
    lines.push(f.summary)
    if (f.evidence) { lines.push(''); lines.push('**Evidence:** ' + f.evidence) }
    if (f.remediation) { lines.push(''); lines.push('**Remediation:** ' + f.remediation) }
    lines.push('')
  }
  return lines.join('\n')
}

export function summarize(findings: GovernanceFinding[]): GovernanceReport['summary'] {
  const byeverity: GovernanceReport['summary']['byeverity'] = {
    info: 0, low: 0, medium: 0, high: 0, critical: 0,
  }
  for (const f of findings) byeverity[f.severity]++
  const overall: GovernanceReport['summary']['overall'] =
    byeverity.critical + byeverity.high > 0 ? 'non-compliant'
    : byeverity.medium + byeverity.low > 0 ? 'compliant-with-findings'
    : 'compliant'
  return { findings: findings.length, byeverity, overall }
}
