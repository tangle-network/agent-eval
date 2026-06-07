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
      const point = runtimeBenchmarkDecisionPoint(raw[pointIndex])
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

function runtimeBenchmarkDecisionPoint(input: unknown): RuntimeBeliefDecisionPoint | null {
  if (!isRecord(input)) return null
  if (typeof input.id !== 'string' || input.id.length === 0) return null
  if (typeof input.runId !== 'string' || input.runId.length === 0) return null
  if (typeof input.stepIndex !== 'number' || !Number.isFinite(input.stepIndex)) return null
  if (typeof input.kind !== 'string' || input.kind.length === 0) return null
  return {
    id: input.id,
    runId: input.runId,
    scenarioId: nonEmptyString(input.scenarioId),
    stepIndex: input.stepIndex,
    kind: input.kind,
    candidateActions: stringArray(input.candidateActions),
    context: nonEmptyString(input.context),
    evidence: runtimeBenchmarkEvidence(input.evidence),
    metadata: isRecord(input.metadata) ? { ...input.metadata } : undefined,
  }
}

function runtimeBenchmarkEvidence(input: unknown): RuntimeBeliefDecisionPoint['evidence'] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    if (!isRecord(item)) return []
    const source = nonEmptyString(item.source)
    const id = nonEmptyString(item.id)
    if (!source || !id) return []
    return [
      {
        source,
        id,
        detail: nonEmptyString(item.detail),
        metadata: isRecord(item.metadata) ? { ...item.metadata } : undefined,
      },
    ]
  })
}

function stringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const values = input.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  return values.length > 0 ? values : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
