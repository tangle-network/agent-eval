import type { AnalystSeverity, EvidenceRef } from '../analyst/types'
import type { RunRecord } from '../run-record'
import {
  type BuildWorkflowAnalystFeedbackPackOptions,
  buildWorkflowAnalystFeedbackPack,
} from './feedback-pack'
import { type WorkflowTraceRunRecordOptions, workflowTraceToRunRecord } from './run-record'
import {
  type SanitizedWorkflowTraceEnvelopeResult,
  type SanitizeWorkflowTraceEnvelopeOptions,
  sanitizeWorkflowTraceEnvelope,
} from './sanitize'
import {
  type WorkflowTraceTrajectoryOptions,
  workflowTraceToFeedbackTrajectory,
} from './trajectory'
import type { WorkflowTraceEnvelope, WorkflowTraceExportLinks, WorkflowTraceSummary } from './types'

export type WorkflowPartnerReportVersion = 'workflow-partner-report-v1'

export interface WorkflowPartnerFinding {
  source: 'analyst' | 'verifier' | 'failure-cluster'
  severity: AnalystSeverity
  area: string
  claim: string
  evidence: EvidenceRef[]
  recommendedAction?: string
  metadata?: Record<string, unknown>
}

export interface WorkflowPartnerReport {
  schemaVersion: WorkflowPartnerReportVersion
  runId: string
  generatedAt: string
  summary: WorkflowTraceSummary
  docsApiGaps: WorkflowPartnerFinding[]
  prReadyFindings: WorkflowPartnerFinding[]
  failureClusters: ReturnType<typeof buildWorkflowAnalystFeedbackPack>['failureClusters']
  recommendations: string[]
  traceArtifacts: WorkflowTraceEnvelope['artifacts']
  links?: WorkflowTraceExportLinks
  exportBundle: {
    traceEnvelope: WorkflowTraceEnvelope
    sanitization: SanitizedWorkflowTraceEnvelopeResult['report']
    feedbackPack: ReturnType<typeof buildWorkflowAnalystFeedbackPack>
    trajectory: ReturnType<typeof workflowTraceToFeedbackTrajectory>
    runRecord?: RunRecord
  }
}

export interface BuildWorkflowPartnerReportOptions
  extends Omit<BuildWorkflowAnalystFeedbackPackOptions, 'envelope'> {
  envelope: WorkflowTraceEnvelope | unknown
  sanitize?: SanitizeWorkflowTraceEnvelopeOptions
  trajectory: WorkflowTraceTrajectoryOptions
  runRecord?: WorkflowTraceRunRecordOptions
  links?: WorkflowTraceExportLinks
}

const REPORT_VERSION: WorkflowPartnerReportVersion = 'workflow-partner-report-v1'

export function buildWorkflowPartnerReport(
  options: BuildWorkflowPartnerReportOptions,
): WorkflowPartnerReport {
  const sanitized = sanitizeWorkflowTraceEnvelope(options.envelope, options.sanitize)
  const feedbackPack = buildWorkflowAnalystFeedbackPack({
    ...options,
    envelope: sanitized.envelope,
  })
  const trajectory = workflowTraceToFeedbackTrajectory(sanitized.envelope, options.trajectory)
  const runRecord = options.runRecord
    ? workflowTraceToRunRecord(sanitized.envelope, options.runRecord)
    : undefined
  const analystFindings: WorkflowPartnerFinding[] = feedbackPack.findings.map((finding) => ({
    source: 'analyst' as const,
    severity: finding.severity,
    area: finding.area,
    claim: finding.claim,
    evidence: finding.evidenceRefs,
    ...(finding.recommendedAction ? { recommendedAction: finding.recommendedAction } : {}),
    metadata: {
      findingId: finding.findingId,
      analystId: finding.analystId,
      confidence: finding.confidence,
      ...(finding.subject ? { subject: finding.subject } : {}),
    },
  }))
  const verifierFindings: WorkflowPartnerFinding[] = (feedbackPack.verifier?.layers ?? []).flatMap(
    (layer) =>
      layer.findings.map((finding) => ({
        source: 'verifier' as const,
        severity: finding.severity,
        area: layer.layer,
        claim: finding.message,
        evidence: finding.evidence
          ? ([{ kind: 'artifact', uri: finding.evidence }] satisfies EvidenceRef[])
          : [],
        ...(layer.reason
          ? { recommendedAction: `Fix verifier layer "${layer.layer}": ${layer.reason}` }
          : {}),
        metadata: {
          status: layer.status,
          score: layer.score,
        },
      })),
  )
  const clusterFindings: WorkflowPartnerFinding[] = feedbackPack.failureClusters.map((cluster) => ({
    source: 'failure-cluster' as const,
    severity: 'medium' as const,
    area: 'failure-cluster',
    claim: `${cluster.name} affects ${(cluster.share * 100).toFixed(1)}% of failed workflow runs`,
    evidence: cluster.exemplars.map((runId) => ({
      kind: 'artifact' as const,
      uri: `run://${runId}`,
    })),
    ...(cluster.suggestedFix ? { recommendedAction: cluster.suggestedFix } : {}),
    metadata: {
      clusterId: cluster.id,
      runCount: cluster.runCount,
      source: cluster.source,
    },
  }))
  const allFindings = [...analystFindings, ...verifierFindings, ...clusterFindings].sort(
    comparePartnerFindings,
  )

  return {
    schemaVersion: REPORT_VERSION,
    runId: sanitized.envelope.runId,
    generatedAt: options.generatedAt ?? feedbackPack.generatedAt,
    summary: feedbackPack.summary,
    docsApiGaps: allFindings.filter(isDocsApiGap),
    prReadyFindings: allFindings.filter(isPrReadyFinding),
    failureClusters: feedbackPack.failureClusters,
    recommendations: feedbackPack.recommendations,
    traceArtifacts: sanitized.envelope.artifacts,
    ...(options.links ? { links: options.links } : {}),
    exportBundle: {
      traceEnvelope: sanitized.envelope,
      sanitization: sanitized.report,
      feedbackPack,
      trajectory,
      ...(runRecord ? { runRecord } : {}),
    },
  }
}

export function renderWorkflowPartnerReport(
  report: WorkflowPartnerReport,
  options: { maxFindings?: number } = {},
): string {
  const maxFindings = options.maxFindings ?? 8
  const lines = [
    `Workflow partner report for ${report.runId}`,
    `status=${report.summary.failed ? 'failed' : 'completed'} scoreEvidence events=${report.summary.eventCount} agents=${report.summary.agentCalls} verifier=${report.summary.verifierCalls} analyst=${report.summary.analystCalls} reviewer=${report.summary.reviewerCalls} costUsd=${report.summary.costUsd.toFixed(6)}`,
    report.failureClusters.length > 0 ? 'Failure clusters:' : undefined,
    ...report.failureClusters
      .slice(0, maxFindings)
      .map(
        (cluster) =>
          `- ${cluster.name} share=${cluster.share.toFixed(3)} exemplars=${cluster.exemplars.join(',')}`,
      ),
    report.docsApiGaps.length > 0 ? 'Docs/API gaps:' : undefined,
    ...report.docsApiGaps
      .slice(0, maxFindings)
      .map((finding) => `- ${finding.severity} ${finding.area}: ${finding.claim}`),
    report.prReadyFindings.length > 0 ? 'PR-ready findings:' : undefined,
    ...report.prReadyFindings
      .slice(0, maxFindings)
      .map((finding) => `- ${finding.severity} ${finding.area}: ${finding.claim}`),
    report.recommendations.length > 0 ? 'Recommendations:' : undefined,
    ...report.recommendations.slice(0, maxFindings).map((recommendation) => `- ${recommendation}`),
  ].filter((line): line is string => Boolean(line))
  return lines.join('\n')
}

function isDocsApiGap(finding: WorkflowPartnerFinding): boolean {
  const haystack = [
    finding.area,
    finding.claim,
    finding.recommendedAction,
    typeof finding.metadata?.subject === 'string' ? finding.metadata.subject : undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return /\b(api|sdk|docs?|documentation|reference|integration|example|quickstart)\b/.test(haystack)
}

function isPrReadyFinding(finding: WorkflowPartnerFinding): boolean {
  return (
    finding.recommendedAction !== undefined ||
    finding.severity === 'critical' ||
    finding.severity === 'high'
  )
}

function comparePartnerFindings(
  left: WorkflowPartnerFinding,
  right: WorkflowPartnerFinding,
): number {
  const severityDelta = severityRank(right.severity) - severityRank(left.severity)
  if (severityDelta !== 0) return severityDelta
  return left.area.localeCompare(right.area)
}

function severityRank(severity: AnalystSeverity): number {
  switch (severity) {
    case 'critical':
      return 5
    case 'high':
      return 4
    case 'medium':
      return 3
    case 'low':
      return 2
    case 'info':
      return 1
  }
}
