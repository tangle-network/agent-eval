import type { AnalystBenchmarkCase } from './benchmark'
import type {
  CodeTraceBenchCaseOptions,
  CodeTraceBenchLabelSet,
  CodeTraceBenchRow,
  CodeTracerPredictionAdapterOptions,
  CodeTracerPredictions,
  CodeTracerStepLabel,
  CodeTraceStageAnnotation,
} from './benchmark-dataset-types'
import {
  assertStepWithinRange,
  defaultStepUri,
  isRecord,
  nonEmpty,
  positiveStep,
  predictionConfidence,
} from './benchmark-dataset-utils'
import { type AnalystFinding, makeFinding } from './types'

export function codeTraceBenchCase<TInput>(
  row: CodeTraceBenchRow,
  input: TInput,
  options: CodeTraceBenchCaseOptions = {},
): AnalystBenchmarkCase<TInput> {
  const trajectoryId = requiredCodeTraceString(row.traj_id, 'CodeTraceBench traj_id')
  const taskName = requiredCodeTraceString(
    row.task_name,
    `CodeTraceBench '${trajectoryId}' task_name`,
  )
  const agent = requiredCodeTraceString(row.agent, `CodeTraceBench '${trajectoryId}' agent`)
  const model = requiredCodeTraceString(row.model, `CodeTraceBench '${trajectoryId}' model`)
  const difficulty = optionalCodeTraceString(
    row.difficulty,
    `CodeTraceBench '${trajectoryId}' difficulty`,
  )
  const category = optionalCodeTraceString(
    row.category,
    `CodeTraceBench '${trajectoryId}' category`,
  )
  const sourceRelpath = optionalSourceRelativePath(row.source_relpath, trajectoryId)
  const solved = codeTraceSolved(row.solved, trajectoryId)
  const tags = parseTags(row.tags, trajectoryId)
  const stepCount = positiveStep(row.step_count, `CodeTraceBench '${trajectoryId}' step_count`)
  const stages = parseCodeTraceStages(row.incorrect_stages, trajectoryId)
  const evidenceKind = options.evidenceKind ?? 'span'
  const uri = options.stepUri ?? defaultStepUri
  const labelSet = codeTraceLabelSet(options.labelSet)
  const labels = new Set<string>()
  const expectedIssues = stages.flatMap((stage) => {
    const incorrect = stepIssues('incorrect', stage.incorrect_step_ids ?? [])
    const unuseful = stepIssues('unuseful', stage.unuseful_step_ids ?? [])
    return labelSet === 'incorrect-only' ? incorrect : [...incorrect, ...unuseful]
  })
  const labelState =
    expectedIssues.length > 0 ? 'positive' : solved === true ? 'trusted-negative' : 'unlabeled'

  return {
    id: `codetrace:${trajectoryId}`,
    clusterId: `codetrace-task:${taskName}`,
    labelState,
    input,
    expectedIssues,
    ...(labelState === 'unlabeled'
      ? {}
      : { labeledEvidence: expectedIssues.flatMap((issue) => issue.evidence ?? []) }),
    tags: [
      'codetracebench',
      agent,
      model,
      ...(difficulty === undefined ? [] : [difficulty]),
      ...(category === undefined ? [] : [category]),
      ...tags,
    ],
    metadata: {
      benchmark: 'CodeTraceBench',
      trajectoryId,
      taskName,
      agent,
      model,
      solved,
      stepCount,
      labelSet,
      ...(sourceRelpath === undefined ? {} : { sourceRelpath }),
      ...(difficulty === undefined ? {} : { difficulty }),
      ...(category === undefined ? {} : { category }),
    },
  }

  function stepIssues(label: 'incorrect' | 'unuseful', steps: readonly number[]) {
    return steps.map((rawStep) => {
      const step = positiveStep(rawStep, `CodeTraceBench '${trajectoryId}' ${label} step`)
      if (step > stepCount) {
        throw new RangeError(
          `CodeTraceBench '${trajectoryId}' ${label} step ${step} exceeds step_count ${stepCount}`,
        )
      }
      const id = `${label}:${step}`
      if (labels.has(id)) {
        throw new TypeError(`CodeTraceBench '${trajectoryId}' repeats label '${id}'`)
      }
      labels.add(id)
      return {
        id,
        areas: [label],
        evidence: [{ kind: evidenceKind, uri: uri(trajectoryId, step) }],
      }
    })
  }
}

/** Translate CodeTracer's `codetracer_labels.json` into shared findings. */
export function codeTracerPredictionsToFindings(
  trajectoryIdValue: string,
  predictions: CodeTracerPredictions,
  options: CodeTracerPredictionAdapterOptions = {},
): AnalystFinding[] {
  const trajectoryId = nonEmpty(trajectoryIdValue, 'CodeTracer prediction trajectory id')
  const labels = parseCodeTracerPredictionLabels(predictions, trajectoryId)
  const confidence = predictionConfidence(options.confidence)
  const uri = options.stepUri ?? defaultStepUri
  const labelSet = codeTraceLabelSet(options.labelSet)
  const seen = new Set<string>()
  const findings: AnalystFinding[] = []
  for (const label of labels) {
    const step = positiveStep(
      label.step,
      `CodeTracer prediction '${trajectoryId}' ${label.area} step`,
    )
    assertStepWithinRange(step, options.stepCount, `CodeTracer prediction '${trajectoryId}'`)
    const key = `${label.area}:${step}`
    if (seen.has(key)) {
      throw new TypeError(`CodeTracer prediction '${trajectoryId}' repeats label '${key}'`)
    }
    seen.add(key)
    if (label.area === 'unuseful' && labelSet === 'incorrect-only') continue
    findings.push(
      makeFinding({
        analyst_id: options.analystId ?? 'codetracer',
        produced_at: options.producedAt,
        area: label.area,
        subject: `step-${step}`,
        claim: `CodeTracer labeled step ${step} as ${label.area}.`,
        id_basis: key,
        rationale: label.reasoning,
        severity: 'medium',
        confidence,
        evidence_refs: [
          {
            kind: options.evidenceKind ?? 'span',
            uri: uri(trajectoryId, step),
          },
        ],
        metadata: {
          upstream: 'CodeTracer',
          stage_id: label.stageId,
          step,
        },
      }),
    )
  }
  return findings
}

function parseCodeTraceStages(
  value: CodeTraceBenchRow['incorrect_stages'],
  trajectoryId: string,
): readonly CodeTraceStageAnnotation[] {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch (error) {
      throw new TypeError(
        `CodeTraceBench '${trajectoryId}' incorrect_stages is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`CodeTraceBench '${trajectoryId}' incorrect_stages must be an array`)
  }
  const stageIds = new Set<number>()
  for (const stage of parsed) {
    if (
      !stage ||
      typeof stage !== 'object' ||
      !Number.isSafeInteger((stage as CodeTraceStageAnnotation).stage_id) ||
      (stage as CodeTraceStageAnnotation).stage_id < 1 ||
      !optionalStepArray((stage as CodeTraceStageAnnotation).incorrect_step_ids) ||
      !optionalStepArray((stage as CodeTraceStageAnnotation).unuseful_step_ids) ||
      ((stage as CodeTraceStageAnnotation).reasoning !== undefined &&
        typeof (stage as CodeTraceStageAnnotation).reasoning !== 'string')
    ) {
      throw new TypeError(`CodeTraceBench '${trajectoryId}' contains an invalid stage annotation`)
    }
    const stageId = (stage as CodeTraceStageAnnotation).stage_id
    if (stageIds.has(stageId)) {
      throw new TypeError(`CodeTraceBench '${trajectoryId}' repeats stage_id ${stageId}`)
    }
    stageIds.add(stageId)
  }
  return parsed as unknown as readonly CodeTraceStageAnnotation[]
}

function parseCodeTracerPredictionLabels(
  value: CodeTracerPredictions,
  trajectoryId: string,
): Array<{
  stageId: string | number
  area: CodeTracerStepLabel['label']
  step: number
  reasoning?: string
}> {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch (error) {
      throw new TypeError(
        `CodeTracer prediction '${trajectoryId}' is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`CodeTracer prediction '${trajectoryId}' must be an array`)
  }
  if (parsed.length === 0) return []

  if (parsed.every(isCodeTraceStageAnnotation)) {
    return (parsed as readonly CodeTraceStageAnnotation[]).flatMap((stage) => [
      ...(stage.incorrect_step_ids ?? []).map((step) => ({
        stageId: stage.stage_id,
        area: 'incorrect' as const,
        step,
        ...(stage.reasoning === undefined ? {} : { reasoning: stage.reasoning }),
      })),
      ...(stage.unuseful_step_ids ?? []).map((step) => ({
        stageId: stage.stage_id,
        area: 'unuseful' as const,
        step,
        ...(stage.reasoning === undefined ? {} : { reasoning: stage.reasoning }),
      })),
    ])
  }

  const flat: Array<{
    stageId: string | number
    area: CodeTracerStepLabel['label']
    step: number
    reasoning?: string
  }> = []
  for (const [index, item] of parsed.entries()) {
    if (isCodeTracerStepLabel(item)) {
      flat.push(
        toCodeTracerPredictionLabel(
          item,
          codeTracerStageId(item, index + 1, trajectoryId),
          trajectoryId,
        ),
      )
      continue
    }
    if (!isRecord(item) || !Array.isArray(item.labels)) {
      throw new TypeError(
        `CodeTracer prediction '${trajectoryId}' contains an unsupported label row`,
      )
    }
    const stageId = codeTracerStageId(item, index + 1, trajectoryId)
    for (const label of item.labels) {
      if (!isCodeTracerStepLabel(label)) {
        throw new TypeError(
          `CodeTracer prediction '${trajectoryId}' contains an invalid step label`,
        )
      }
      flat.push(toCodeTracerPredictionLabel(label, stageId, trajectoryId))
    }
  }
  return flat
}

function isCodeTraceStageAnnotation(value: unknown): value is CodeTraceStageAnnotation {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.stage_id) &&
    (value.stage_id as number) > 0 &&
    optionalStepArray(value.incorrect_step_ids as readonly number[] | undefined) &&
    optionalStepArray(value.unuseful_step_ids as readonly number[] | undefined) &&
    (value.reasoning === undefined || typeof value.reasoning === 'string')
  )
}

function isCodeTracerStepLabel(value: unknown): value is CodeTracerStepLabel {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.step_id) &&
    (value.step_id as number) > 0 &&
    (value.stage === undefined ||
      typeof value.stage === 'string' ||
      typeof value.stage === 'number') &&
    (value.stage_name === undefined ||
      typeof value.stage_name === 'string' ||
      typeof value.stage_name === 'number') &&
    (value.stage_id === undefined ||
      typeof value.stage_id === 'string' ||
      typeof value.stage_id === 'number') &&
    (value.label === 'incorrect' || value.label === 'unuseful') &&
    (value.rationale === undefined || typeof value.rationale === 'string') &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.note === undefined || typeof value.note === 'string') &&
    (value.comment === undefined || typeof value.comment === 'string')
  )
}

function toCodeTracerPredictionLabel(
  label: CodeTracerStepLabel,
  stageId: string | number,
  trajectoryId: string,
): {
  stageId: string | number
  area: CodeTracerStepLabel['label']
  step: number
  reasoning?: string
} {
  if (!isCodeTracerStepLabel(label)) {
    throw new TypeError(`CodeTracer prediction '${trajectoryId}' contains an invalid step label`)
  }
  return {
    stageId,
    area: label.label,
    step: label.step_id,
    ...codeTracerReason(label, trajectoryId),
  }
}

function codeTracerStageId(
  value: { stage?: unknown; stage_name?: unknown; stage_id?: unknown },
  fallback: number,
  trajectoryId: string,
): string | number {
  const candidates = [value.stage, value.stage_name, value.stage_id].filter(
    (candidate): candidate is string | number =>
      typeof candidate === 'string' || typeof candidate === 'number',
  )
  if (new Set(candidates).size > 1) {
    throw new TypeError(`CodeTracer prediction '${trajectoryId}' has conflicting stage fields`)
  }
  return candidates[0] ?? fallback
}

function codeTracerReason(
  label: CodeTracerStepLabel,
  trajectoryId: string,
): { reasoning?: string } {
  const candidates = [label.rationale, label.reason, label.note, label.comment].filter(
    (candidate): candidate is string => candidate !== undefined,
  )
  if (new Set(candidates).size > 1) {
    throw new TypeError(
      `CodeTracer prediction '${trajectoryId}' step ${label.step_id} has conflicting reason fields`,
    )
  }
  return candidates[0] === undefined ? {} : { reasoning: candidates[0] }
}

function parseTags(value: CodeTraceBenchRow['tags'], trajectoryId: string): string[] {
  if (value === undefined) return []
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch (error) {
      throw new TypeError(
        `CodeTraceBench '${trajectoryId}' tags is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`CodeTraceBench '${trajectoryId}' tags must be an array of strings`)
  }
  const tags = parsed.map((tag, index) =>
    requiredCodeTraceString(tag, `CodeTraceBench '${trajectoryId}' tags[${index}]`),
  )
  if (new Set(tags).size !== tags.length) {
    throw new TypeError(`CodeTraceBench '${trajectoryId}' tags must not repeat values`)
  }
  return tags
}

function codeTraceLabelSet(value: CodeTraceBenchLabelSet | undefined): CodeTraceBenchLabelSet {
  if (value === undefined || value === 'incorrect-only') return 'incorrect-only'
  if (value === 'incorrect-and-unuseful') return value
  throw new TypeError(
    "CodeTraceBench labelSet must be 'incorrect-only' or 'incorrect-and-unuseful'",
  )
}

function optionalStepArray(value: readonly number[] | undefined): boolean {
  return value === undefined || (Array.isArray(value) && value.every(Number.isSafeInteger))
}

function requiredCodeTraceString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  return nonEmpty(value, field)
}

function optionalCodeTraceString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requiredCodeTraceString(value, field)
}

function optionalSourceRelativePath(value: unknown, trajectoryId: string): string | undefined {
  const path = optionalCodeTraceString(value, `CodeTraceBench '${trajectoryId}' source_relpath`)
  if (path === undefined) return undefined
  const segments = path.replaceAll('\\', '/').split('/')
  if (
    path.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    segments.some((segment) => segment === '..')
  ) {
    throw new TypeError(
      `CodeTraceBench '${trajectoryId}' source_relpath must stay within the artifact root`,
    )
  }
  return path
}

function codeTraceSolved(value: unknown, trajectoryId: string): boolean | null | undefined {
  if (value === undefined || value === null || typeof value === 'boolean') return value
  throw new TypeError(`CodeTraceBench '${trajectoryId}' solved must be a boolean or null`)
}
