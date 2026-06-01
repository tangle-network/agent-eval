import { ValidationError } from '../errors'
import {
  type SanitizedWorkflowTraceEnvelopeResult,
  type SanitizeWorkflowTraceEnvelopeOptions,
  sanitizeWorkflowTraceEnvelope,
  type WorkflowTraceSanitizationReport,
} from './sanitize'
import { validateWorkflowTraceEnvelope } from './schema'
import { summarizeWorkflowExecution, type WorkflowExecutionSummary } from './summary'
import type { WorkflowTraceEnvelope, WorkflowTraceEvent, WorkflowTraceExportLinks } from './types'

export type WorkflowTraceIntelligenceEnvelopeVersion = 'workflow-trace-intelligence-envelope-v1'
export type WorkflowTraceExportGrantScope = 'workflow-trace:export' | 'workflow-trace:read' | '*'
export type WorkflowTraceExportGrantSubject = 'product' | 'partner' | 'tenant'

export interface WorkflowTraceExportGrant {
  grantId: string
  subject: WorkflowTraceExportGrantSubject
  subjectId: string
  scopes: readonly WorkflowTraceExportGrantScope[]
  grantedAt?: string
  expiresAt?: string
  metadata?: Record<string, unknown>
}

export interface WorkflowTraceHashEvidence {
  path: string
  sha256: string
  shape?: unknown
}

export interface WorkflowTraceArtifactEvidence {
  kind: string
  uri: string
  contentType?: string
  sha256?: string
}

export interface WorkflowTraceCompactEvidence {
  eventKinds: Record<string, number>
  phases: string[]
  toolNames: string[]
  redactedHashes: WorkflowTraceHashEvidence[]
  artifacts: WorkflowTraceArtifactEvidence[]
  failureMessage?: string
}

export interface WorkflowTraceIntelligenceEnvelope {
  schemaVersion: WorkflowTraceIntelligenceEnvelopeVersion
  destination: string
  generatedAt: string
  productId: string
  partnerId?: string
  runId: string
  grantIds: string[]
  traceEnvelope: WorkflowTraceEnvelope
  summary: WorkflowExecutionSummary
  compactEvidence: WorkflowTraceCompactEvidence
  sanitization: SanitizedWorkflowTraceEnvelopeResult['report']
  links?: WorkflowTraceExportLinks
}

export interface BuildWorkflowTraceIntelligenceEnvelopeOptions {
  envelope: WorkflowTraceEnvelope | unknown
  productId: string
  partnerId?: string
  grants: readonly WorkflowTraceExportGrant[]
  generatedAt?: string
  destination?: string
  sanitize?: SanitizeWorkflowTraceEnvelopeOptions
  links?: WorkflowTraceExportLinks
  metadata?: Record<string, unknown>
}

const ENVELOPE_VERSION: WorkflowTraceIntelligenceEnvelopeVersion =
  'workflow-trace-intelligence-envelope-v1'
const DEFAULT_DESTINATION = 'intelligence.tangle.tools'

export function buildWorkflowTraceIntelligenceEnvelope(
  options: BuildWorkflowTraceIntelligenceEnvelopeOptions,
): WorkflowTraceIntelligenceEnvelope {
  const productId = requireNonEmpty(options.productId, 'productId')
  const partnerId =
    options.partnerId !== undefined ? requireNonEmpty(options.partnerId, 'partnerId') : undefined
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const grantIds = activeExportGrantIds({
    grants: options.grants,
    productId,
    partnerId,
    nowMs: Date.parse(generatedAt),
  })
  const base = validateWorkflowTraceEnvelope(options.envelope)
  const sourceEnvelope: WorkflowTraceEnvelope =
    options.metadata === undefined
      ? base
      : {
          ...base,
          metadata: {
            ...(base.metadata ?? {}),
            intelligenceExport: options.metadata,
          },
        }
  const sanitized = sanitizeWorkflowTraceEnvelope(sourceEnvelope, options.sanitize)
  const summary = summarizeWorkflowExecution(sanitized.envelope)
  return {
    schemaVersion: ENVELOPE_VERSION,
    destination: options.destination ?? DEFAULT_DESTINATION,
    generatedAt,
    productId,
    ...(partnerId ? { partnerId } : {}),
    runId: sanitized.envelope.runId,
    grantIds,
    traceEnvelope: sanitized.envelope,
    summary,
    compactEvidence: compactEvidence(sanitized.envelope, summary),
    sanitization: sanitized.report,
    ...(options.links ? { links: options.links } : {}),
  }
}

export function validateWorkflowTraceIntelligenceEnvelope(
  input: unknown,
): WorkflowTraceIntelligenceEnvelope {
  const obj = expectRecord(input, 'workflow intelligence envelope')
  if (obj.schemaVersion !== ENVELOPE_VERSION) {
    throw new ValidationError(`workflow intelligence schemaVersion must be ${ENVELOPE_VERSION}`)
  }
  const destination = expectString(obj.destination, 'destination')
  const generatedAt = expectString(obj.generatedAt, 'generatedAt')
  const productId = expectString(obj.productId, 'productId')
  const partnerId =
    obj.partnerId !== undefined ? expectString(obj.partnerId, 'partnerId') : undefined
  const runId = expectString(obj.runId, 'runId')
  const grantIds = expectStringArray(obj.grantIds, 'grantIds')
  const traceEnvelope = validateWorkflowTraceEnvelope(obj.traceEnvelope)
  if (traceEnvelope.runId !== runId) {
    throw new ValidationError(`workflow intelligence runId ${runId} does not match trace envelope`)
  }
  const summary = summarizeWorkflowExecution(traceEnvelope)
  const compact = validateCompactEvidence(obj.compactEvidence)
  const expectedCompact = compactEvidence(traceEnvelope, summary)
  assertCompactEvidenceEqual(compact, expectedCompact)
  const sanitization = validateSanitizationReport(obj.sanitization)
  return {
    schemaVersion: ENVELOPE_VERSION,
    destination,
    generatedAt,
    productId,
    ...(partnerId ? { partnerId } : {}),
    runId,
    grantIds,
    traceEnvelope,
    summary,
    compactEvidence: expectedCompact,
    sanitization,
    ...(obj.links !== undefined ? { links: validateLinks(obj.links) } : {}),
  }
}

function activeExportGrantIds(args: {
  grants: readonly WorkflowTraceExportGrant[]
  productId: string
  partnerId?: string
  nowMs: number
}): string[] {
  if (!Array.isArray(args.grants) || args.grants.length === 0) {
    throw new ValidationError('workflow intelligence export requires at least one opt-in grant')
  }
  const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : Date.now()
  const ids = args.grants
    .filter((grant) => grantMatchesSubject(grant, args.productId, args.partnerId))
    .filter((grant) => grant.scopes.includes('workflow-trace:export') || grant.scopes.includes('*'))
    .filter((grant) => !grantExpired(grant, nowMs))
    .map((grant) => grant.grantId)
    .filter((id) => id.length > 0)
  if (ids.length === 0) {
    throw new ValidationError(
      'workflow intelligence export requires an active workflow-trace:export grant for the product or partner',
    )
  }
  return ids
}

function grantMatchesSubject(
  grant: WorkflowTraceExportGrant,
  productId: string,
  partnerId: string | undefined,
): boolean {
  if (grant.subject === 'product') return grant.subjectId === productId
  if (grant.subject === 'partner') return partnerId !== undefined && grant.subjectId === partnerId
  return grant.subjectId === productId || grant.subjectId === partnerId
}

function grantExpired(grant: WorkflowTraceExportGrant, nowMs: number): boolean {
  if (!grant.expiresAt) return false
  const expiresAt = Date.parse(grant.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= nowMs
}

function compactEvidence(
  envelope: WorkflowTraceEnvelope,
  summary: WorkflowExecutionSummary,
): WorkflowTraceCompactEvidence {
  return {
    eventKinds: summary.eventKinds,
    phases: summary.phases,
    toolNames: toolNames(envelope.events),
    redactedHashes: redactedHashes(envelope),
    artifacts: (envelope.artifacts ?? []).map((artifact) => ({
      kind: artifact.kind,
      uri: artifact.uri,
      ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    })),
    ...(summary.failureMessage ? { failureMessage: summary.failureMessage } : {}),
  }
}

function toolNames(events: readonly WorkflowTraceEvent[]): string[] {
  const names = new Set<string>()
  for (const event of events) collectToolNames(event.payload, names)
  return [...names].sort()
}

function collectToolNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectToolNames(item, names)
    })
    return
  }
  if (!isRecord(value)) return
  const direct = stringValue(value.toolName) ?? stringValue(value.name)
  if (direct && looksLikeToolRecord(value)) names.add(direct)
  if (isRecord(value.byTool)) {
    for (const key of Object.keys(value.byTool)) names.add(key)
  }
  for (const child of Object.values(value)) collectToolNames(child, names)
}

function looksLikeToolRecord(value: Record<string, unknown>): boolean {
  return (
    'toolName' in value ||
    'toolArgs' in value ||
    'args' in value ||
    'status' in value ||
    'error' in value ||
    'success' in value
  )
}

function redactedHashes(envelope: WorkflowTraceEnvelope): WorkflowTraceHashEvidence[] {
  const out: WorkflowTraceHashEvidence[] = []
  envelope.events.forEach((event, index) => {
    collectHashEvidence(event.payload, `events[${index}].payload`, out)
  })
  const artifacts = envelope.artifacts ?? []
  artifacts.forEach((artifact, index) => {
    collectHashEvidence(artifact.metadata, `artifacts[${index}].metadata`, out)
  })
  collectHashEvidence(envelope.metadata, 'metadata', out)
  return out
}

function collectHashEvidence(value: unknown, path: string, out: WorkflowTraceHashEvidence[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectHashEvidence(item, `${path}[${index}]`, out)
    })
    return
  }
  if (!isRecord(value)) return
  if (value.redacted === true && typeof value.sha256 === 'string') {
    out.push({
      path,
      sha256: value.sha256,
      ...(value.shape !== undefined ? { shape: value.shape } : {}),
    })
    return
  }
  for (const [key, child] of Object.entries(value)) {
    collectHashEvidence(child, `${path}.${key}`, out)
  }
}

function validateCompactEvidence(value: unknown): WorkflowTraceCompactEvidence {
  const obj = expectRecord(value, 'compactEvidence')
  return {
    eventKinds: expectNumberRecord(obj.eventKinds, 'compactEvidence.eventKinds'),
    phases: expectStringArray(obj.phases, 'compactEvidence.phases'),
    toolNames: expectStringArray(obj.toolNames, 'compactEvidence.toolNames'),
    redactedHashes: expectArray(obj.redactedHashes, 'compactEvidence.redactedHashes').map(
      (item, index) => {
        const record = expectRecord(item, `compactEvidence.redactedHashes[${index}]`)
        return {
          path: expectString(record.path, `compactEvidence.redactedHashes[${index}].path`),
          sha256: expectString(record.sha256, `compactEvidence.redactedHashes[${index}].sha256`),
          ...(record.shape !== undefined ? { shape: record.shape } : {}),
        }
      },
    ),
    artifacts: expectArray(obj.artifacts, 'compactEvidence.artifacts').map((item, index) => {
      const record = expectRecord(item, `compactEvidence.artifacts[${index}]`)
      return {
        kind: expectString(record.kind, `compactEvidence.artifacts[${index}].kind`),
        uri: expectString(record.uri, `compactEvidence.artifacts[${index}].uri`),
        ...(record.contentType !== undefined
          ? {
              contentType: expectString(
                record.contentType,
                `compactEvidence.artifacts[${index}].contentType`,
              ),
            }
          : {}),
        ...(record.sha256 !== undefined
          ? {
              sha256: expectString(record.sha256, `compactEvidence.artifacts[${index}].sha256`),
            }
          : {}),
      }
    }),
    ...(obj.failureMessage !== undefined
      ? { failureMessage: expectString(obj.failureMessage, 'compactEvidence.failureMessage') }
      : {}),
  }
}

function assertCompactEvidenceEqual(
  actual: WorkflowTraceCompactEvidence,
  expected: WorkflowTraceCompactEvidence,
): void {
  assertNumberRecordEqual(actual.eventKinds, expected.eventKinds, 'compactEvidence.eventKinds')
  assertStringArrayEqual(actual.phases, expected.phases, 'compactEvidence.phases')
  assertStringArrayEqual(actual.toolNames, expected.toolNames, 'compactEvidence.toolNames')
  assertJsonArrayEqual(
    actual.redactedHashes,
    expected.redactedHashes,
    'compactEvidence.redactedHashes',
  )
  assertJsonArrayEqual(actual.artifacts, expected.artifacts, 'compactEvidence.artifacts')
  if (actual.failureMessage !== expected.failureMessage) {
    throw new ValidationError('compactEvidence.failureMessage does not match trace envelope')
  }
}

function validateSanitizationReport(value: unknown): WorkflowTraceSanitizationReport {
  const obj = expectRecord(value, 'sanitization')
  return {
    redactionCount: expectNonNegativeNumber(obj.redactionCount, 'sanitization.redactionCount'),
    byRule: expectNumberRecord(obj.byRule, 'sanitization.byRule'),
    hashedArgs: expectNonNegativeNumber(obj.hashedArgs, 'sanitization.hashedArgs'),
    truncatedStrings: expectNonNegativeNumber(
      obj.truncatedStrings,
      'sanitization.truncatedStrings',
    ),
    droppedPayloadKeys: expectNumberRecord(
      obj.droppedPayloadKeys,
      'sanitization.droppedPayloadKeys',
    ),
    droppedArtifactContents: expectNonNegativeNumber(
      obj.droppedArtifactContents,
      'sanitization.droppedArtifactContents',
    ),
  }
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

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`workflow intelligence ${field} must be a non-empty string`)
  }
  return value
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError(`${path}: expected object`)
  return value
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${path}: expected array`)
  return value
}

function expectStringArray(value: unknown, path: string): string[] {
  return expectArray(value, path).map((item, index) => expectString(item, `${path}[${index}]`))
}

function expectNumberRecord(value: unknown, path: string): Record<string, number> {
  const record = expectRecord(value, path)
  const out: Record<string, number> = {}
  for (const [key, item] of Object.entries(record)) {
    out[key] = expectNonNegativeNumber(item, `${path}.${key}`)
  }
  return out
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${path}: expected non-empty string`)
  }
  return value
}

function expectNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${path}: expected non-negative number`)
  }
  return value
}

function assertNumberRecordEqual(
  actual: Record<string, number>,
  expected: Record<string, number>,
  path: string,
): void {
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  assertStringArrayEqual(actualKeys, expectedKeys, path)
  for (const key of expectedKeys) {
    if (actual[key] !== expected[key]) {
      throw new ValidationError(`${path}.${key} does not match trace envelope`)
    }
  }
}

function assertStringArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new ValidationError(`${path} does not match trace envelope`)
  }
}

function assertJsonArrayEqual(
  actual: readonly unknown[],
  expected: readonly unknown[],
  path: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((item, index) => JSON.stringify(item) !== JSON.stringify(expected[index]))
  ) {
    throw new ValidationError(`${path} does not match trace envelope`)
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
