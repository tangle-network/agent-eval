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
  const decisions = options.decisions ?? []
  const labels = options.labels ?? []
  if (decisions.length === 0) {
    diagnostics.push(
      'no runtime decision points supplied; benchmark lifecycle events alone cannot produce belief decision rows',
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
