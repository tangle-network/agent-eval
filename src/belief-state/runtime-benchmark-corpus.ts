import type { RunSplitTag } from '../run-record'
import {
  type BuildRuntimeBeliefPhase0MeasurementOptions,
  buildRuntimeBeliefPhase0Measurement,
  type RuntimeBeliefDecisionLabel,
  type RuntimeBeliefPhase0Measurement,
  type RuntimeBeliefPhase0RunRecord,
} from './phase0-measurement'
import type { RuntimeBeliefDecisionPoint, RuntimeBeliefHookEvent } from './runtime-hooks'

export interface RuntimeBenchmarkBeliefAttemptRecord {
  round: number
  prompt?: string
  output?: string
  valid?: boolean
  score?: number
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  wallMs?: number
  eventCount?: number
  eventTypes?: Record<string, number>
  traceTail?: string
  error?: string
}

export interface RuntimeBenchmarkBeliefRecord {
  benchmark: string
  instanceId: string
  condition: string
  model?: string
  blindResolved?: boolean
  resolved?: boolean
  attempts?: RuntimeBenchmarkBeliefAttemptRecord[]
  infraError?: boolean
  seed?: number
  splitTag?: RunSplitTag
  commitSha?: string
  runtimeEvents?: unknown[]
}

export interface BuildRuntimeBenchmarkBeliefPhase0MeasurementOptions
  extends Omit<
    BuildRuntimeBeliefPhase0MeasurementOptions,
    'runs' | 'events' | 'decisions' | 'labels'
  > {
  records: RuntimeBenchmarkBeliefRecord[]
  decisions?: RuntimeBeliefDecisionPoint[]
  labels?: RuntimeBeliefDecisionLabel[]
  defaultSplitTag?: RunSplitTag
}

export interface RuntimeBenchmarkBeliefPhase0Summary {
  recordCount: number
  recordWithRuntimeEventsCount: number
  runtimeRunCount: number
  lifecycleEventCount: number
  decisionCount: number
  labelCount: number
  defaultedSplitCount: number
}

export interface RuntimeBenchmarkBeliefPhase0Measurement {
  runs: RuntimeBeliefPhase0RunRecord[]
  events: RuntimeBeliefHookEvent[]
  decisions: RuntimeBeliefDecisionPoint[]
  labels: RuntimeBeliefDecisionLabel[]
  measurement: RuntimeBeliefPhase0Measurement
  summary: RuntimeBenchmarkBeliefPhase0Summary
  diagnostics: string[]
}

const DEFAULT_SPLIT_TAG: RunSplitTag = 'search'

export function buildRuntimeBenchmarkBeliefPhase0Measurement(
  options: BuildRuntimeBenchmarkBeliefPhase0MeasurementOptions,
): RuntimeBenchmarkBeliefPhase0Measurement {
  const diagnostics: string[] = []
  const runsById = new Map<string, RuntimeBeliefPhase0RunRecord>()
  const events: RuntimeBeliefHookEvent[] = []
  let recordWithRuntimeEventsCount = 0
  let defaultedSplitCount = 0

  for (const record of options.records) {
    const key = benchmarkRecordKey(record)
    const splitTag = record.splitTag ?? options.defaultSplitTag ?? DEFAULT_SPLIT_TAG
    if (record.splitTag === undefined) defaultedSplitCount += 1

    const rawEvents = record.runtimeEvents ?? []
    if (rawEvents.length === 0) {
      diagnostics.push(`${key}: no runtimeEvents; no runtime run join can be extracted`)
      continue
    }
    recordWithRuntimeEventsCount += 1

    for (let index = 0; index < rawEvents.length; index += 1) {
      const event = parseRuntimeHookEvent(rawEvents[index])
      if (!event) {
        diagnostics.push(`${key}: runtimeEvents[${index}] is not a RuntimeHookEvent`)
        continue
      }
      events.push(event)

      const scenarioId = event.scenarioId ?? record.instanceId
      const prior = runsById.get(event.runId)
      if (!prior) {
        runsById.set(event.runId, { runId: event.runId, scenarioId, splitTag })
        continue
      }
      if (prior.scenarioId !== scenarioId || prior.splitTag !== splitTag) {
        diagnostics.push(`${key}: runId ${event.runId} has conflicting scenario/split metadata`)
      }
    }
  }

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

  const runs = [...runsById.values()]
  const measurement = buildRuntimeBeliefPhase0Measurement({
    ...options,
    runs,
    events,
    decisions,
    labels,
  })

  return {
    runs,
    events,
    decisions,
    labels,
    measurement,
    summary: {
      recordCount: options.records.length,
      recordWithRuntimeEventsCount,
      runtimeRunCount: runs.length,
      lifecycleEventCount: events.length,
      decisionCount: decisions.length,
      labelCount: labels.length,
      defaultedSplitCount,
    },
    diagnostics: [...diagnostics, ...measurement.diagnostics],
  }
}

function benchmarkRecordKey(record: RuntimeBenchmarkBeliefRecord): string {
  return `${record.benchmark}:${record.instanceId}:${record.condition}`
}

function parseRuntimeHookEvent(input: unknown): RuntimeBeliefHookEvent | null {
  if (!isRecord(input)) return null
  if (typeof input.id !== 'string' || input.id.length === 0) return null
  if (typeof input.runId !== 'string' || input.runId.length === 0) return null
  if (typeof input.target !== 'string' || input.target.length === 0) return null
  if (typeof input.phase !== 'string' || input.phase.length === 0) return null
  if (typeof input.timestamp !== 'number' || !Number.isFinite(input.timestamp)) return null

  return {
    id: input.id,
    runId: input.runId,
    scenarioId: stringOrUndefined(input.scenarioId),
    target: input.target,
    phase: input.phase,
    timestamp: input.timestamp,
    stepIndex: finiteNumberOrUndefined(input.stepIndex),
    parentId: stringOrUndefined(input.parentId),
    payload: input.payload,
    metadata: isRecord(input.metadata) ? { ...input.metadata } : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
