import { createHash } from 'node:crypto'

import {
  DEFAULT_REDACTION_RULES,
  type RedactionReport,
  type RedactionRule,
  redactString,
} from '../trace/redact'
import { validateWorkflowTraceEnvelope } from './schema'
import type { WorkflowTraceArtifact, WorkflowTraceEnvelope, WorkflowTraceEvent } from './types'

export interface WorkflowTraceSanitizationReport extends RedactionReport {
  hashedArgs: number
  truncatedStrings: number
  droppedPayloadKeys: Record<string, number>
  droppedArtifactContents: number
}

export interface SanitizeWorkflowTraceEnvelopeOptions {
  rules?: readonly RedactionRule[]
  maxStringLength?: number
  hashSalt?: string
  approvedArtifactUris?: readonly string[]
  approvedArtifactKinds?: readonly string[]
}

export interface SanitizedWorkflowTraceEnvelopeResult {
  envelope: WorkflowTraceEnvelope
  report: WorkflowTraceSanitizationReport
}

const DEFAULT_MAX_STRING_LENGTH = 600

const SECRET_KEY_RE =
  /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|session|credential|credentials)$/i
const ARG_KEY_RE = /^(args|arguments|rawargs|raw_args|toolargs|tool_args|inputargs|input_args)$/i
const FILE_CONTENT_KEY_RE = /^(filecontent|filecontents|file_content|file_contents|contents)$/i
const FILE_HINT_KEY_RE = /^(path|filepath|file_path|filename|file|uri)$/i

export function sanitizeWorkflowTraceEnvelope(
  input: WorkflowTraceEnvelope | unknown,
  options: SanitizeWorkflowTraceEnvelopeOptions = {},
): SanitizedWorkflowTraceEnvelopeResult {
  const envelope = validateWorkflowTraceEnvelope(input)
  const report = emptyReport()
  const ctx: SanitizeContext = {
    rules: [...(options.rules ?? DEFAULT_REDACTION_RULES)],
    maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    hashSalt: options.hashSalt ?? '',
    approvedArtifactUris: new Set(options.approvedArtifactUris ?? []),
    approvedArtifactKinds: new Set(options.approvedArtifactKinds ?? []),
    report,
  }

  return {
    envelope: {
      traceVersion: envelope.traceVersion,
      runId: envelope.runId,
      ...(envelope.topology ? { topology: sanitizeValue(envelope.topology, ctx) as never } : {}),
      events: envelope.events.map((event) => sanitizeWorkflowTraceEvent(event, ctx)),
      ...(envelope.artifacts ? { artifacts: sanitizeArtifacts(envelope.artifacts, ctx) } : {}),
      ...(envelope.metadata
        ? { metadata: sanitizeRecord(envelope.metadata, ctx) as Record<string, unknown> }
        : {}),
    },
    report,
  }
}

function sanitizeWorkflowTraceEvent(
  event: WorkflowTraceEvent,
  ctx: SanitizeContext,
): WorkflowTraceEvent {
  return {
    kind: event.kind,
    runId: event.runId,
    timestamp: event.timestamp,
    payload: sanitizeRecord(event.payload, ctx) as Record<string, unknown>,
  }
}

function sanitizeArtifacts(
  artifacts: readonly WorkflowTraceArtifact[],
  ctx: SanitizeContext,
): WorkflowTraceArtifact[] {
  return artifacts.map((artifact) => {
    const approved =
      ctx.approvedArtifactUris.has(artifact.uri) || ctx.approvedArtifactKinds.has(artifact.kind)
    const metadata = artifact.metadata
      ? sanitizeRecord(artifact.metadata, ctx, { artifactApproved: approved })
      : undefined
    return {
      kind: artifact.kind,
      uri: sanitizeString(artifact.uri, ctx),
      ...(artifact.contentType ? { contentType: sanitizeString(artifact.contentType, ctx) } : {}),
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      ...(metadata ? { metadata: metadata as Record<string, unknown> } : {}),
    }
  })
}

function sanitizeRecord(
  record: Record<string, unknown>,
  ctx: SanitizeContext,
  options: { artifactApproved?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const hasFileHint = Object.keys(record).some((key) => FILE_HINT_KEY_RE.test(key))
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = `[redacted:${key}]`
      increment(ctx.report.droppedPayloadKeys, key)
      continue
    }
    if (ARG_KEY_RE.test(key)) {
      out[key] = hashedValue(value, ctx)
      ctx.report.hashedArgs += 1
      continue
    }
    if (!options.artifactApproved && isFileContentKey(key, hasFileHint)) {
      out[key] = hashedValue(value, ctx)
      ctx.report.droppedArtifactContents += 1
      continue
    }
    out[key] = sanitizeValue(value, ctx)
  }
  return out
}

function sanitizeValue(value: unknown, ctx: SanitizeContext): unknown {
  if (typeof value === 'string') return sanitizeString(value, ctx)
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, ctx))
  if (isRecord(value)) return sanitizeRecord(value, ctx)
  return value
}

function sanitizeString(value: string, ctx: SanitizeContext): string {
  const redacted = redactString(value, ctx.rules)
  ctx.report.redactionCount += redacted.report.redactionCount
  for (const [rule, count] of Object.entries(redacted.report.byRule)) {
    ctx.report.byRule[rule] = (ctx.report.byRule[rule] ?? 0) + count
  }
  if (redacted.output.length <= ctx.maxStringLength) return redacted.output
  ctx.report.truncatedStrings += 1
  return `${redacted.output.slice(0, Math.max(0, ctx.maxStringLength - 1))}…`
}

function hashedValue(value: unknown, ctx: SanitizeContext): Record<string, unknown> {
  return {
    redacted: true,
    sha256: sha256Stable(value, ctx.hashSalt),
    shape: valueShape(value),
  }
}

function sha256Stable(value: unknown, salt: string): string {
  return createHash('sha256').update(salt).update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function valueShape(value: unknown): unknown {
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  if (isRecord(value)) {
    return {
      type: 'object',
      keys: Object.keys(value).sort(),
    }
  }
  return { type: typeof value }
}

function isFileContentKey(key: string, hasFileHint: boolean): boolean {
  if (FILE_CONTENT_KEY_RE.test(key)) return true
  return hasFileHint && /^(content|source|diff)$/i.test(key)
}

function emptyReport(): WorkflowTraceSanitizationReport {
  return {
    redactionCount: 0,
    byRule: {},
    hashedArgs: 0,
    truncatedStrings: 0,
    droppedPayloadKeys: {},
    droppedArtifactContents: 0,
  }
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface SanitizeContext {
  rules: RedactionRule[]
  maxStringLength: number
  hashSalt: string
  approvedArtifactUris: Set<string>
  approvedArtifactKinds: Set<string>
  report: WorkflowTraceSanitizationReport
}
