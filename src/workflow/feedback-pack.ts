import type { AnalystFinding, AnalystSeverity, EvidenceRef } from '../analyst/types'
import type { FailureClusterInsight } from '../contract/insight-report'
import type { LayerResult, VerificationReport } from '../multi-layer-verifier'
import type { FailureClusterReport } from '../pipelines/failure-cluster'
import { summarizeWorkflowTrace, validateWorkflowTraceEnvelope } from './schema'
import type { WorkflowTraceEnvelope, WorkflowTraceSummary } from './types'

export type WorkflowFeedbackPackVersion = 'workflow-feedback-pack-v1'

export type WorkflowFeedbackSeverity = AnalystSeverity

export interface WorkflowToolUsageSummary {
  totalCalls: number
  erroredCalls: number
  byTool: Record<string, { calls: number; errors: number }>
}

export interface WorkflowVerifierFindingSummary {
  severity: WorkflowFeedbackSeverity
  message: string
  evidence?: string
  detail?: Record<string, unknown>
}

export interface WorkflowVerifierLayerSummary {
  layer: string
  status: LayerResult['status']
  score?: number
  durationMs: number
  reason?: string
  findings: WorkflowVerifierFindingSummary[]
  diagnostics?: Record<string, number | null>
}

export interface WorkflowVerifierSummary {
  allPass: boolean
  blendedScore: number
  durationMs: number
  failedLayers: string[]
  layers: WorkflowVerifierLayerSummary[]
}

export interface WorkflowFailureClusterInput {
  id: string
  name: string
  share?: number
  runCount?: number
  exemplars?: readonly string[]
  suggestedFix?: string
  metadata?: Record<string, unknown>
}

export interface WorkflowFailureClusterSummary {
  id: string
  name: string
  share: number
  runCount?: number
  exemplars: string[]
  suggestedFix?: string
  source: 'failure-cluster-view' | 'insight-report' | 'custom'
  metadata?: Record<string, unknown>
}

export interface WorkflowAnalystFindingSummary {
  findingId: string
  analystId: string
  severity: WorkflowFeedbackSeverity
  area: string
  claim: string
  confidence: number
  subject?: string
  recommendedAction?: string
  evidenceRefs: EvidenceRef[]
}

export interface WorkflowAnalystFeedbackPack {
  schemaVersion: WorkflowFeedbackPackVersion
  runId: string
  generatedAt: string
  summary: WorkflowTraceSummary
  verifier?: WorkflowVerifierSummary
  toolUsage: WorkflowToolUsageSummary
  failureClusters: WorkflowFailureClusterSummary[]
  findings: WorkflowAnalystFindingSummary[]
  recommendations: string[]
  driverContextLines: string[]
}

export interface WorkflowFeedbackPackLimits {
  findings?: number
  clusters?: number
  layerFindings?: number
  recommendations?: number
  contextLines?: number
}

export interface BuildWorkflowAnalystFeedbackPackOptions {
  envelope: WorkflowTraceEnvelope | unknown
  verifier?: VerificationReport
  analystFindings?: readonly AnalystFinding[]
  failureClusters?:
    | FailureClusterReport
    | FailureClusterInsight
    | readonly WorkflowFailureClusterInput[]
  generatedAt?: string
  limits?: WorkflowFeedbackPackLimits
}

const PACK_VERSION: WorkflowFeedbackPackVersion = 'workflow-feedback-pack-v1'

const DEFAULT_LIMITS: Required<WorkflowFeedbackPackLimits> = {
  findings: 12,
  clusters: 8,
  layerFindings: 5,
  recommendations: 10,
  contextLines: 24,
}

export function buildWorkflowAnalystFeedbackPack(
  options: BuildWorkflowAnalystFeedbackPackOptions,
): WorkflowAnalystFeedbackPack {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const envelope = validateWorkflowTraceEnvelope(options.envelope)
  const summary = summarizeWorkflowTrace(envelope)
  const verifier = options.verifier ? summarizeVerifier(options.verifier, limits) : undefined
  const toolUsage = summarizeToolUsage(envelope)
  const failureClusters = normalizeFailureClusters(options.failureClusters)
    .sort((a, b) => b.share - a.share)
    .slice(0, limits.clusters)
  const findings = summarizeFindings(options.analystFindings ?? [])
    .sort(compareFindings)
    .slice(0, limits.findings)
  const recommendations = uniqueStrings([
    ...recommendFromVerifier(verifier),
    ...failureClusters.flatMap((cluster) => (cluster.suggestedFix ? [cluster.suggestedFix] : [])),
    ...findings.flatMap((finding) =>
      finding.recommendedAction ? [finding.recommendedAction] : [],
    ),
    ...(summary.failed && summary.failureMessage
      ? [`Inspect workflow failure: ${summary.failureMessage}`]
      : []),
  ]).slice(0, limits.recommendations)

  const pack: WorkflowAnalystFeedbackPack = {
    schemaVersion: PACK_VERSION,
    runId: envelope.runId,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    summary,
    ...(verifier ? { verifier } : {}),
    toolUsage,
    failureClusters,
    findings,
    recommendations,
    driverContextLines: [],
  }
  return {
    ...pack,
    driverContextLines: renderDriverContextLines(pack).slice(0, limits.contextLines),
  }
}

export function renderWorkflowFeedbackPack(
  pack: WorkflowAnalystFeedbackPack,
  options: { maxChars?: number } = {},
): string {
  const lines = [
    `Workflow feedback pack for ${pack.runId}`,
    `status=${pack.summary.failed ? 'failed' : 'completed'} durationMs=${pack.summary.durationMs} costUsd=${pack.summary.costUsd.toFixed(6)} tokens=${pack.summary.tokenUsage.input}/${pack.summary.tokenUsage.output} events=${pack.summary.eventCount}`,
    renderDelegateFailureCounts(pack.summary),
    pack.verifier
      ? `verifier=${pack.verifier.allPass ? 'pass' : 'fail'} blendedScore=${pack.verifier.blendedScore.toFixed(3)} failedLayers=${pack.verifier.failedLayers.join(',') || 'none'}`
      : undefined,
    pack.toolUsage.totalCalls > 0
      ? `tools=${pack.toolUsage.totalCalls} errors=${pack.toolUsage.erroredCalls} byTool=${formatToolUsage(pack.toolUsage)}`
      : undefined,
    pack.failureClusters.length > 0 ? 'Failure clusters:' : undefined,
    ...pack.failureClusters.map(
      (cluster) =>
        `- ${cluster.name} share=${cluster.share.toFixed(3)} exemplars=${cluster.exemplars.join(',') || 'none'}${cluster.suggestedFix ? ` fix=${cluster.suggestedFix}` : ''}`,
    ),
    pack.findings.length > 0 ? 'Analyst findings:' : undefined,
    ...pack.findings.map(
      (finding) =>
        `- ${finding.severity} ${finding.area}: ${finding.claim}${finding.recommendedAction ? ` action=${finding.recommendedAction}` : ''}`,
    ),
    pack.recommendations.length > 0 ? 'Recommended next moves:' : undefined,
    ...pack.recommendations.map((recommendation) => `- ${recommendation}`),
  ].filter((line): line is string => Boolean(line))
  const rendered = lines.join('\n')
  const maxChars = options.maxChars
  if (maxChars === undefined || rendered.length <= maxChars) return rendered
  if (maxChars <= 1) return rendered.slice(0, Math.max(0, maxChars))
  return `${rendered.slice(0, maxChars - 1)}…`
}

function renderDelegateFailureCounts(summary: WorkflowTraceSummary): string | undefined {
  const entries: Array<[string, number]> = [
    ['agent', summary.agentFailures],
    ['loop', summary.loopFailures],
    ['verifier', summary.verifierFailures],
    ['analyst', summary.analystFailures],
    ['reviewer', summary.reviewerFailures],
  ]
  const failures = entries.filter((entry) => entry[1] > 0)
  if (failures.length === 0) return undefined
  return `delegateFailures=${failures.map(([kind, count]) => `${kind}:${count}`).join(',')}`
}

function summarizeVerifier(
  verifier: VerificationReport,
  limits: Required<WorkflowFeedbackPackLimits>,
): WorkflowVerifierSummary {
  const layers = verifier.layers.map((layer) => ({
    layer: layer.layer,
    status: layer.status,
    ...(layer.score !== undefined ? { score: layer.score } : {}),
    durationMs: layer.durationMs,
    ...(layer.reason ? { reason: layer.reason } : {}),
    findings: layer.findings
      .map((finding) => ({
        severity: verifierSeverity(finding.severity),
        message: finding.message,
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
        ...(finding.detail ? { detail: finding.detail } : {}),
      }))
      .slice(0, limits.layerFindings),
    ...(layer.diagnostics ? { diagnostics: layer.diagnostics } : {}),
  }))
  return {
    allPass: verifier.allPass,
    blendedScore: verifier.blendedScore,
    durationMs: verifier.durationMs,
    failedLayers: verifier.layers
      .filter(
        (layer) =>
          layer.status === 'fail' || layer.status === 'error' || layer.status === 'timeout',
      )
      .map((layer) => layer.layer),
    layers,
  }
}

function summarizeToolUsage(envelope: WorkflowTraceEnvelope): WorkflowToolUsageSummary {
  const summary: WorkflowToolUsageSummary = { totalCalls: 0, erroredCalls: 0, byTool: {} }
  for (const event of envelope.events) {
    collectToolUsagePayload(summary, event.payload.toolUsage)
    collectToolCalls(summary, event.payload.toolCalls)
    collectSingleTool(summary, event.payload)
  }
  return summary
}

function collectToolUsagePayload(summary: WorkflowToolUsageSummary, value: unknown): void {
  if (!isRecord(value)) return
  if (!isRecord(value.byTool)) {
    summary.totalCalls += finiteNumber(value.totalCalls)
    summary.erroredCalls += finiteNumber(value.erroredCalls)
    return
  }
  let addedByTool = false
  for (const [tool, raw] of Object.entries(value.byTool)) {
    if (!isRecord(raw)) continue
    const calls = finiteNumber(raw.calls)
    const errors = finiteNumber(raw.errors)
    addTool(summary, tool, calls, errors)
    addedByTool ||= calls > 0 || errors > 0
  }
  if (!addedByTool) {
    summary.totalCalls += finiteNumber(value.totalCalls)
    summary.erroredCalls += finiteNumber(value.erroredCalls)
  }
}

function collectToolCalls(summary: WorkflowToolUsageSummary, value: unknown): void {
  if (!Array.isArray(value)) return
  for (const call of value) {
    if (!isRecord(call)) continue
    const name = stringValue(call.toolName) ?? stringValue(call.name)
    if (!name) continue
    const errored =
      call.status === 'error' ||
      call.error !== undefined ||
      call.ok === false ||
      call.success === false
    addTool(summary, name, 1, errored ? 1 : 0)
  }
}

function collectSingleTool(
  summary: WorkflowToolUsageSummary,
  payload: Record<string, unknown>,
): void {
  const name = stringValue(payload.toolName)
  if (!name) return
  const errored =
    payload.status === 'error' ||
    payload.error !== undefined ||
    payload.ok === false ||
    payload.success === false
  addTool(summary, name, 1, errored ? 1 : 0)
}

function addTool(
  summary: WorkflowToolUsageSummary,
  name: string,
  calls: number,
  errors: number,
): void {
  if (calls === 0 && errors === 0) return
  const current = summary.byTool[name] ?? { calls: 0, errors: 0 }
  current.calls += calls
  current.errors += errors
  summary.byTool[name] = current
  summary.totalCalls += calls
  summary.erroredCalls += errors
}

function normalizeFailureClusters(
  input:
    | FailureClusterReport
    | FailureClusterInsight
    | readonly WorkflowFailureClusterInput[]
    | undefined,
): WorkflowFailureClusterSummary[] {
  if (!input) return []
  if (Array.isArray(input)) {
    return input.map((cluster) => ({
      id: cluster.id,
      name: cluster.name,
      share: clamp01(cluster.share ?? 0),
      ...(cluster.runCount !== undefined ? { runCount: cluster.runCount } : {}),
      exemplars: [...(cluster.exemplars ?? [])],
      ...(cluster.suggestedFix ? { suggestedFix: cluster.suggestedFix } : {}),
      source: 'custom',
      ...(cluster.metadata ? { metadata: cluster.metadata } : {}),
    }))
  }
  const report = input as FailureClusterReport | FailureClusterInsight
  const clusters = report.clusters ?? []
  const first = clusters[0] as unknown
  if (isRecord(first) && typeof first.failureClass === 'string') {
    const failureReport = report as FailureClusterReport
    return failureReport.clusters.map((cluster) => ({
      id: [
        cluster.failureClass,
        cluster.toolName ?? '',
        cluster.argPrefix ?? '',
        cluster.dimension ?? '',
      ].join('|'),
      name: [
        cluster.failureClass,
        cluster.toolName ? `tool:${cluster.toolName}` : undefined,
        cluster.dimension ? `dimension:${cluster.dimension}` : undefined,
      ]
        .filter(Boolean)
        .join(' '),
      share: failureReport.totalFailures > 0 ? cluster.runCount / failureReport.totalFailures : 0,
      runCount: cluster.runCount,
      exemplars: [cluster.exampleRunId],
      source: 'failure-cluster-view',
      metadata: {
        scenarioIds: cluster.scenarioIds,
        exampleError: cluster.exampleError,
        argPrefix: cluster.argPrefix,
      },
    }))
  }
  const insight = report as FailureClusterInsight
  return insight.clusters.map((cluster) => ({
    id: cluster.id,
    name: cluster.name,
    share: clamp01(cluster.share),
    exemplars: [...cluster.exemplars],
    ...(cluster.suggestedFix ? { suggestedFix: cluster.suggestedFix } : {}),
    source: 'insight-report',
  }))
}

function summarizeFindings(findings: readonly AnalystFinding[]): WorkflowAnalystFindingSummary[] {
  return findings.map((finding) => ({
    findingId: finding.finding_id,
    analystId: finding.analyst_id,
    severity: finding.severity,
    area: finding.area,
    claim: finding.claim,
    confidence: clamp01(finding.confidence),
    ...(finding.subject ? { subject: finding.subject } : {}),
    ...(finding.recommended_action ? { recommendedAction: finding.recommended_action } : {}),
    evidenceRefs: finding.evidence_refs,
  }))
}

function recommendFromVerifier(verifier: WorkflowVerifierSummary | undefined): string[] {
  if (!verifier || verifier.allPass) return []
  return verifier.layers
    .filter((layer) => verifier.failedLayers.includes(layer.layer))
    .map((layer) => {
      const firstFinding = layer.findings[0]?.message
      const detail = layer.reason ?? firstFinding ?? layer.status
      return `Fix verifier layer "${layer.layer}": ${detail}`
    })
}

function renderDriverContextLines(pack: WorkflowAnalystFeedbackPack): string[] {
  return renderWorkflowFeedbackPack(pack)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function compareFindings(
  left: WorkflowAnalystFindingSummary,
  right: WorkflowAnalystFindingSummary,
): number {
  const severityDelta = severityRank(right.severity) - severityRank(left.severity)
  if (severityDelta !== 0) return severityDelta
  return right.confidence - left.confidence
}

function verifierSeverity(severity: string): WorkflowFeedbackSeverity {
  switch (severity) {
    case 'critical':
      return 'critical'
    case 'major':
      return 'high'
    case 'minor':
      return 'low'
    case 'info':
      return 'info'
    default:
      return 'medium'
  }
}

function severityRank(severity: WorkflowFeedbackSeverity): number {
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

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function formatToolUsage(summary: WorkflowToolUsageSummary): string {
  return Object.entries(summary.byTool)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, usage]) => `${tool}:${usage.calls}/${usage.errors}`)
    .join(',')
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
