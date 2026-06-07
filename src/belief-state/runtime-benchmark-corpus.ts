import {
  type ProjectRuntimeTrajectoryEvidenceOptions,
  projectRuntimeTrajectoryEvidence,
  type RuntimeTrajectoryEvidenceProjection,
  type RuntimeTrajectoryRecord,
} from '../runtime-trajectory'
import {
  type BuildRuntimeBeliefPhase0MeasurementOptions,
  buildRuntimeBeliefPhase0Measurement,
  type RuntimeBeliefDecisionLabel,
  type RuntimeBeliefPhase0Measurement,
  type RuntimeBeliefPhase0RunRecord,
} from './phase0-measurement'
import type { RuntimeBeliefDecisionPoint, RuntimeBeliefHookEvent } from './runtime-hooks'

type RuntimeBenchmarkTrajectoryRecord = RuntimeTrajectoryRecord & {
  benchmark?: unknown
  condition?: unknown
  instanceId?: unknown
  runtimeDecisionPoints?: unknown
}

const MAX_STRING_LENGTH = 12_000
const MAX_CONTEXT_LENGTH = 20_000
const MAX_EVIDENCE_DETAIL_LENGTH = 2_000
const MAX_CANDIDATE_ACTIONS = 50
const MAX_EVIDENCE_REFS = 50
const MAX_METADATA_DEPTH = 4
const MAX_METADATA_KEYS = 100
const SENSITIVE_KEY_RE =
  /(?:authorization|api[_-]?key|token|secret|password|cookie|credential|bearer)/i
const SENSITIVE_VALUE_RES = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|gh[pousr])_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:sk|ghp|gho|ghu|ghs|ghr)-[A-Za-z0-9_-]{20,}\b/g,
]
const SENSITIVE_ASSIGNMENT_RE =
  /\b(api[_-]?key|token|secret|password|cookie)\s*[:=]\s*["']?[^"'\s,;}]+/gi

export interface BuildRuntimeBenchmarkBeliefPhase0MeasurementOptions
  extends Omit<
    BuildRuntimeBeliefPhase0MeasurementOptions,
    'runs' | 'events' | 'decisions' | 'labels'
  > {
  records: RuntimeBenchmarkTrajectoryRecord[]
  decisions?: RuntimeBeliefDecisionPoint[]
  defaultSplitTag?: ProjectRuntimeTrajectoryEvidenceOptions['defaultSplitTag']
  labels?: RuntimeBeliefDecisionLabel[]
}

export interface RuntimeBenchmarkBeliefPhase0Summary {
  decisionCount: number
  labelCount: number
}

export interface RuntimeBenchmarkBeliefPhase0Measurement {
  runs: RuntimeBeliefPhase0RunRecord[]
  events: RuntimeBeliefHookEvent[]
  decisions: RuntimeBeliefDecisionPoint[]
  labels: RuntimeBeliefDecisionLabel[]
  trajectory: RuntimeTrajectoryEvidenceProjection
  measurement: RuntimeBeliefPhase0Measurement
  summary: RuntimeBenchmarkBeliefPhase0Summary
  diagnostics: string[]
}

export function buildRuntimeBenchmarkBeliefPhase0Measurement(
  options: BuildRuntimeBenchmarkBeliefPhase0MeasurementOptions,
): RuntimeBenchmarkBeliefPhase0Measurement {
  const diagnostics: string[] = []
  const trajectory = projectRuntimeTrajectoryEvidence({
    records: options.records,
    defaultSplitTag: options.defaultSplitTag,
    recordIdOf: runtimeBenchmarkRecordId,
    scenarioIdOf: runtimeBenchmarkScenarioId,
  })
  const decisions =
    options.decisions ?? runtimeBenchmarkDecisionPoints(options.records, diagnostics)
  const labels = options.labels ?? []
  if (decisions.length === 0) {
    diagnostics.push(
      'no runtime decision points supplied or found on records; benchmark lifecycle events alone cannot produce belief decision rows',
    )
  }
  if (labels.length === 0 && decisions.length > 0) {
    diagnostics.push(
      'no decision labels supplied; observed action/outcome joins will be incomplete',
    )
  }

  const measurement = buildRuntimeBeliefPhase0Measurement({
    ...options,
    runs: trajectory.runs,
    events: trajectory.events,
    decisions,
    labels,
  })

  return {
    runs: trajectory.runs,
    events: trajectory.events,
    decisions,
    labels,
    trajectory,
    measurement,
    summary: {
      decisionCount: decisions.length,
      labelCount: labels.length,
    },
    diagnostics: [...trajectory.diagnostics, ...diagnostics, ...measurement.diagnostics],
  }
}

function runtimeBenchmarkRecordId(record: RuntimeBenchmarkTrajectoryRecord): string | undefined {
  const parts = [
    nonEmptyString(record.benchmark),
    nonEmptyString(record.instanceId),
    nonEmptyString(record.condition),
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(':') : undefined
}

function runtimeBenchmarkScenarioId(record: RuntimeBenchmarkTrajectoryRecord): string | undefined {
  return nonEmptyString(record.instanceId)
}

function runtimeBenchmarkDecisionPoints(
  records: RuntimeBenchmarkTrajectoryRecord[],
  diagnostics: string[],
): RuntimeBeliefDecisionPoint[] {
  const decisions: RuntimeBeliefDecisionPoint[] = []
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex]!
    const raw = record.runtimeDecisionPoints
    if (raw === undefined) continue
    const recordId = runtimeBenchmarkRecordId(record) ?? `record[${recordIndex}]`
    if (!Array.isArray(raw)) {
      diagnostics.push(`${recordId}: runtimeDecisionPoints is not an array`)
      continue
    }
    for (let pointIndex = 0; pointIndex < raw.length; pointIndex += 1) {
      const point = runtimeBenchmarkDecisionPoint(raw[pointIndex], {
        diagnostics,
        path: `${recordId}: runtimeDecisionPoints[${pointIndex}]`,
      })
      if (!point) {
        diagnostics.push(
          `${recordId}: runtimeDecisionPoints[${pointIndex}] is not a RuntimeDecisionPoint`,
        )
        continue
      }
      decisions.push(point)
    }
  }
  return decisions
}

function runtimeBenchmarkDecisionPoint(
  input: unknown,
  context: { diagnostics: string[]; path: string },
): RuntimeBeliefDecisionPoint | null {
  if (!isRecord(input)) return null
  if (typeof input.id !== 'string' || input.id.length === 0) return null
  if (typeof input.runId !== 'string' || input.runId.length === 0) return null
  if (
    typeof input.stepIndex !== 'number' ||
    !Number.isInteger(input.stepIndex) ||
    input.stepIndex < 0
  ) {
    return null
  }
  if (typeof input.kind !== 'string' || input.kind.length === 0) return null
  return {
    id: sanitizeString(input.id, MAX_STRING_LENGTH),
    runId: sanitizeString(input.runId, MAX_STRING_LENGTH),
    scenarioId: sanitizeOptionalString(input.scenarioId, MAX_STRING_LENGTH),
    stepIndex: input.stepIndex,
    kind: sanitizeString(input.kind, MAX_STRING_LENGTH),
    candidateActions: stringArray(input.candidateActions, {
      ...context,
      maxItems: MAX_CANDIDATE_ACTIONS,
      label: 'candidateActions',
    }),
    context: sanitizeOptionalString(input.context, MAX_CONTEXT_LENGTH),
    evidence: runtimeBenchmarkEvidence(input.evidence, context),
    metadata: sanitizeMetadataRecord(input.metadata),
  }
}

function runtimeBenchmarkEvidence(
  input: unknown,
  context: { diagnostics: string[]; path: string },
): RuntimeBeliefDecisionPoint['evidence'] {
  if (!Array.isArray(input)) return []
  if (input.length > MAX_EVIDENCE_REFS) {
    context.diagnostics.push(`${context.path}: evidence truncated to ${MAX_EVIDENCE_REFS} refs`)
  }
  return input.slice(0, MAX_EVIDENCE_REFS).flatMap((item) => {
    if (!isRecord(item)) return []
    const source = sanitizeOptionalString(item.source, MAX_STRING_LENGTH)
    const id = sanitizeOptionalString(item.id, MAX_STRING_LENGTH)
    if (!source || !id) return []
    return [
      {
        source,
        id,
        detail: sanitizeOptionalString(item.detail, MAX_EVIDENCE_DETAIL_LENGTH),
        metadata: sanitizeMetadataRecord(item.metadata),
      },
    ]
  })
}

function stringArray(
  input: unknown,
  context: { diagnostics: string[]; path: string; maxItems: number; label: string },
): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  if (input.length > context.maxItems) {
    context.diagnostics.push(`${context.path}: ${context.label} truncated to ${context.maxItems}`)
  }
  const values = input
    .slice(0, context.maxItems)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => sanitizeString(value, MAX_STRING_LENGTH))
  return values.length > 0 ? values : undefined
}

function sanitizeMetadataRecord(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) return undefined
  const sanitized = sanitizeMetadata(metadata)
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return undefined
  return sanitized as Record<string, unknown>
}

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return sanitizeString(value, MAX_STRING_LENGTH)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth >= MAX_METADATA_DEPTH) return '[MaxDepth]'
    return value.slice(0, MAX_METADATA_KEYS).map((item) => sanitizeMetadata(item, depth + 1))
  }
  if (!isRecord(value)) return undefined
  if (depth >= MAX_METADATA_DEPTH) return '[MaxDepth]'

  const sanitized: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value).slice(0, MAX_METADATA_KEYS)) {
    sanitized[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : sanitizeMetadata(nested, depth + 1)
  }
  return sanitized
}

function sanitizeOptionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? sanitizeString(value, maxLength)
    : undefined
}

function sanitizeString(value: string, maxLength: number): string {
  let sanitized = value
  for (const pattern of SENSITIVE_VALUE_RES) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }
  sanitized = sanitized.replace(
    SENSITIVE_ASSIGNMENT_RE,
    (_match, key: string) => `${key}=[REDACTED]`,
  )
  if (sanitized.length <= maxLength) return sanitized
  return sanitized.slice(0, maxLength)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
