import type { RunSplitTag } from './run-record'

export interface RuntimeTrajectoryHookEvent {
  id: string
  runId: string
  scenarioId?: string
  target: string
  phase: string
  timestamp: number
  stepIndex?: number
  parentId?: string
  payload?: unknown
  metadata?: Record<string, unknown>
}

export interface RuntimeTrajectoryRecord {
  id?: string
  scenarioId?: string
  splitTag?: RunSplitTag
  runtimeEvents?: unknown
  [key: string]: unknown
}

export interface RuntimeTrajectoryRunRecord {
  runId: string
  scenarioId?: string
  splitTag: RunSplitTag
}

export interface RuntimeTrajectoryEvidenceSummary {
  recordCount: number
  recordWithRuntimeEventsCount: number
  runtimeRunCount: number
  lifecycleEventCount: number
  defaultedSplitCount: number
}

export interface RuntimeTrajectoryEvidenceProjection {
  runs: RuntimeTrajectoryRunRecord[]
  events: RuntimeTrajectoryHookEvent[]
  summary: RuntimeTrajectoryEvidenceSummary
  diagnostics: string[]
}

export interface ProjectRuntimeTrajectoryEvidenceOptions<
  TRecord extends RuntimeTrajectoryRecord = RuntimeTrajectoryRecord,
> {
  records: TRecord[]
  defaultSplitTag?: RunSplitTag
  recordIdOf?: (record: TRecord, index: number) => string | undefined
  scenarioIdOf?: (record: TRecord, index: number) => string | undefined
}

const DEFAULT_SPLIT_TAG: RunSplitTag = 'search'

export function projectRuntimeTrajectoryEvidence<TRecord extends RuntimeTrajectoryRecord>(
  options: ProjectRuntimeTrajectoryEvidenceOptions<TRecord>,
): RuntimeTrajectoryEvidenceProjection {
  const diagnostics: string[] = []
  const runsById = new Map<string, RuntimeTrajectoryRunRecord>()
  const events: RuntimeTrajectoryHookEvent[] = []
  let recordWithRuntimeEventsCount = 0
  let defaultedSplitCount = 0

  for (let recordIndex = 0; recordIndex < options.records.length; recordIndex += 1) {
    const record = options.records[recordIndex]!
    const key = runtimeTrajectoryRecordKey(record, recordIndex, options.recordIdOf)
    const splitTag = record.splitTag ?? options.defaultSplitTag ?? DEFAULT_SPLIT_TAG
    if (record.splitTag === undefined) defaultedSplitCount += 1

    const rawEvents = record.runtimeEvents
    if (!Array.isArray(rawEvents)) {
      diagnostics.push(
        `${key}: runtimeEvents is not an array; no runtime run join can be extracted`,
      )
      continue
    }
    if (rawEvents.length === 0) {
      diagnostics.push(`${key}: no runtimeEvents; no runtime run join can be extracted`)
      continue
    }
    recordWithRuntimeEventsCount += 1

    for (let index = 0; index < rawEvents.length; index += 1) {
      const event = parseRuntimeTrajectoryHookEvent(rawEvents[index])
      if (!event) {
        diagnostics.push(`${key}: runtimeEvents[${index}] is not a RuntimeHookEvent`)
        continue
      }
      events.push(event)

      const scenarioId =
        event.scenarioId ??
        stringOrUndefined(options.scenarioIdOf?.(record, recordIndex)) ??
        stringOrUndefined(record.scenarioId)
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

  const runs = [...runsById.values()]
  return {
    runs,
    events,
    summary: {
      recordCount: options.records.length,
      recordWithRuntimeEventsCount,
      runtimeRunCount: runs.length,
      lifecycleEventCount: events.length,
      defaultedSplitCount,
    },
    diagnostics,
  }
}

export function parseRuntimeTrajectoryHookEvent(input: unknown): RuntimeTrajectoryHookEvent | null {
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

function runtimeTrajectoryRecordKey<TRecord extends RuntimeTrajectoryRecord>(
  record: TRecord,
  index: number,
  recordIdOf?: (record: TRecord, index: number) => string | undefined,
): string {
  return (
    stringOrUndefined(recordIdOf?.(record, index)) ??
    stringOrUndefined(record.id) ??
    `record[${index}]`
  )
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
