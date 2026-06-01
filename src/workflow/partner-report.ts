import type { AnalystSeverity, EvidenceRef } from '../analyst/types'
import { ValidationError } from '../errors'
import { type RunRecord, validateRunRecord } from '../run-record'
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
import { summarizeWorkflowTrace, validateWorkflowTraceEnvelope } from './schema'
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
    ? workflowTraceToRunRecord(sanitized.envelope, {
        ...options.runRecord,
        runId: sanitized.envelope.runId,
      })
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

export function validateWorkflowPartnerReport(input: unknown): WorkflowPartnerReport {
  const obj = expectRecord(input, 'workflow partner report')
  if (obj.schemaVersion !== REPORT_VERSION) {
    throw new ValidationError(`workflow partner report schemaVersion must be ${REPORT_VERSION}`)
  }

  const runId = expectString(obj.runId, 'runId')
  const generatedAt = expectString(obj.generatedAt, 'generatedAt')
  const exportBundle = validateExportBundle(obj.exportBundle, runId)
  const expectedSummary = summarizeWorkflowTrace(exportBundle.traceEnvelope)
  assertJsonEqual(expectRecord(obj.summary, 'summary'), expectedSummary, 'summary')
  assertJsonEqual(
    exportBundle.feedbackPack.summary,
    expectedSummary,
    'exportBundle.feedbackPack.summary',
  )

  const traceArtifacts = validateOptionalArtifacts(obj.traceArtifacts, 'traceArtifacts')
  assertJsonEqual(
    traceArtifacts ?? [],
    exportBundle.traceEnvelope.artifacts ?? [],
    'traceArtifacts',
  )

  return {
    schemaVersion: REPORT_VERSION,
    runId,
    generatedAt,
    summary: expectedSummary,
    docsApiGaps: expectArray(obj.docsApiGaps, 'docsApiGaps') as WorkflowPartnerFinding[],
    prReadyFindings: expectArray(
      obj.prReadyFindings,
      'prReadyFindings',
    ) as WorkflowPartnerFinding[],
    failureClusters: expectArray(
      obj.failureClusters,
      'failureClusters',
    ) as WorkflowPartnerReport['failureClusters'],
    recommendations: expectStringArray(obj.recommendations, 'recommendations'),
    traceArtifacts,
    ...(obj.links !== undefined ? { links: validateLinks(obj.links) } : {}),
    exportBundle,
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

function validateExportBundle(
  value: unknown,
  runId: string,
): WorkflowPartnerReport['exportBundle'] {
  const obj = expectRecord(value, 'exportBundle')
  const traceEnvelope = validateWorkflowTraceEnvelope(obj.traceEnvelope)
  if (traceEnvelope.runId !== runId) {
    throw new ValidationError('exportBundle.traceEnvelope.runId must match report runId')
  }

  const feedbackPack = expectRecord(obj.feedbackPack, 'exportBundle.feedbackPack')
  if (feedbackPack.schemaVersion !== 'workflow-feedback-pack-v1') {
    throw new ValidationError(
      'exportBundle.feedbackPack.schemaVersion must be workflow-feedback-pack-v1',
    )
  }
  if (feedbackPack.runId !== runId) {
    throw new ValidationError('exportBundle.feedbackPack.runId must match report runId')
  }
  expectRecord(feedbackPack.toolUsage, 'exportBundle.feedbackPack.toolUsage')
  expectArray(feedbackPack.failureClusters, 'exportBundle.feedbackPack.failureClusters')
  expectArray(feedbackPack.findings, 'exportBundle.feedbackPack.findings')
  expectStringArray(feedbackPack.recommendations, 'exportBundle.feedbackPack.recommendations')
  expectStringArray(feedbackPack.driverContextLines, 'exportBundle.feedbackPack.driverContextLines')

  const trajectory = expectRecord(obj.trajectory, 'exportBundle.trajectory')
  if (trajectory.id !== runId) {
    throw new ValidationError('exportBundle.trajectory.id must match report runId')
  }
  expectArray(trajectory.attempts, 'exportBundle.trajectory.attempts')
  expectArray(trajectory.labels, 'exportBundle.trajectory.labels')

  const runRecord =
    obj.runRecord === undefined
      ? undefined
      : validateWorkflowRunRecord(obj.runRecord, traceEnvelope)
  expectRecord(obj.sanitization, 'exportBundle.sanitization')

  return {
    traceEnvelope,
    sanitization: obj.sanitization as WorkflowPartnerReport['exportBundle']['sanitization'],
    feedbackPack: obj.feedbackPack as WorkflowPartnerReport['exportBundle']['feedbackPack'],
    trajectory: obj.trajectory as WorkflowPartnerReport['exportBundle']['trajectory'],
    ...(runRecord ? { runRecord } : {}),
  }
}

function validateWorkflowRunRecord(value: unknown, envelope: WorkflowTraceEnvelope): RunRecord {
  const record = validateRunRecord(value)
  const summary = summarizeWorkflowTrace(envelope)
  if (record.runId !== envelope.runId) {
    throw new ValidationError('exportBundle.runRecord.runId must match trace envelope runId')
  }
  if (record.outcome.raw.workflow_events !== summary.eventCount) {
    throw new ValidationError('exportBundle.runRecord outcome does not match trace event count')
  }
  return record
}

function validateLinks(value: unknown): WorkflowTraceExportLinks {
  const obj = expectRecord(value, 'links')
  return {
    ...(obj.traceArtifactUri !== undefined
      ? { traceArtifactUri: expectString(obj.traceArtifactUri, 'links.traceArtifactUri') }
      : {}),
    ...(obj.exportBundleUri !== undefined
      ? { exportBundleUri: expectString(obj.exportBundleUri, 'links.exportBundleUri') }
      : {}),
    ...(obj.partnerReportUri !== undefined
      ? { partnerReportUri: expectString(obj.partnerReportUri, 'links.partnerReportUri') }
      : {}),
    ...(obj.intelligenceRunUri !== undefined
      ? { intelligenceRunUri: expectString(obj.intelligenceRunUri, 'links.intelligenceRunUri') }
      : {}),
  }
}

function validateOptionalArtifacts(
  value: unknown,
  path: string,
): WorkflowTraceEnvelope['artifacts'] {
  if (value === undefined) return undefined
  return expectArray(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`
    const obj = expectRecord(item, itemPath)
    return {
      kind: expectString(obj.kind, `${itemPath}.kind`),
      uri: expectString(obj.uri, `${itemPath}.uri`),
      ...(obj.contentType !== undefined
        ? { contentType: expectString(obj.contentType, `${itemPath}.contentType`) }
        : {}),
      ...(obj.sha256 !== undefined
        ? { sha256: expectString(obj.sha256, `${itemPath}.sha256`) }
        : {}),
      ...(obj.metadata !== undefined
        ? { metadata: expectRecord(obj.metadata, `${itemPath}.metadata`) }
        : {}),
    }
  })
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${path}: expected object`)
  }
  return value as Record<string, unknown>
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${path}: expected array`)
  return value
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${path}: expected non-empty string`)
  }
  return value
}

function expectStringArray(value: unknown, path: string): string[] {
  return expectArray(value, path).map((item, index) => expectString(item, `${path}[${index}]`))
}

function assertJsonEqual(actual: unknown, expected: unknown, path: string): void {
  if (JSON.stringify(stableJson(actual)) !== JSON.stringify(stableJson(expected))) {
    throw new ValidationError(`${path} does not match trace envelope`)
  }
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJson(child)]),
  )
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
