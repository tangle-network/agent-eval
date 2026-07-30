import type { AnalystBenchmarkCase } from './benchmark'
import { type AnalystFinding, type EvidenceRef, makeFinding } from './types'

type ExternalId = string | number

export interface AgentRxFailure {
  failure_id: ExternalId
  step_number: number
  step_reason: string
  failure_category: string
  category_reason?: string
  failed_agent?: string
}

export interface AgentRxRow {
  trajectory_id: ExternalId
  failures: readonly AgentRxFailure[]
  root_cause?: { failure_id: ExternalId; reason_for_root_cause?: string }
  root_cause_failure_id?: ExternalId
  root_cause_reason?: string
  failure_summary?: string
  num_failures?: number
}

export interface AgentRxPrediction {
  task_id?: ExternalId
  failure_case: number | string
  step_number: number
  description?: string
  checklist_reasoning?: string | null
}

export interface AgentRxPredictionReport {
  task_id?: ExternalId
  failures: readonly AgentRxPrediction[]
  num_judges?: number
  trajectory_length?: number
  most_common_failure?: number | string
  modes?: readonly (number | string)[]
  step_mean?: number
}

export interface CodeTraceStageAnnotation {
  stage_id: number
  incorrect_step_ids?: readonly number[]
  unuseful_step_ids?: readonly number[]
  reasoning?: string
}

export interface CodeTraceBenchRow {
  traj_id: string
  agent: string
  model: string
  task_name: string
  /** Native artifact extraction path in the public CodeTraceBench manifest. */
  source_relpath?: string
  difficulty?: string
  category?: string
  tags?: string | readonly string[]
  solved?: boolean | null
  step_count: number
  incorrect_stages: string | readonly CodeTraceStageAnnotation[]
}

export interface StepLabelAdapterOptions {
  evidenceKind?: EvidenceRef['kind']
  stepUri?: (trajectoryId: string, step: number) => string
}

export type CodeTraceBenchLabelSet = 'incorrect-only' | 'incorrect-and-unuseful'

export interface CodeTraceBenchLabelOptions {
  /**
   * CodeTraceBench's published metric scores incorrect steps only.
   * Include unuseful steps only for an explicitly combined experiment.
   */
  labelSet?: CodeTraceBenchLabelSet
}

export interface CodeTraceBenchCaseOptions
  extends StepLabelAdapterOptions,
    CodeTraceBenchLabelOptions {}

export interface AgentRxBenchmarkCaseOptions extends StepLabelAdapterOptions {
  stepCount?: number
  /** AgentRx's published task is root-cause localization. */
  target?: 'root-cause' | 'all-failures'
}

export interface UpstreamPredictionAdapterOptions extends StepLabelAdapterOptions {
  analystId?: string
  producedAt?: string
  confidence?: number
  stepCount?: number
}

export interface CodeTracerPredictionAdapterOptions
  extends UpstreamPredictionAdapterOptions,
    CodeTraceBenchLabelOptions {}

export function agentRxBenchmarkCase<TInput>(
  row: AgentRxRow,
  input: TInput,
  options: AgentRxBenchmarkCaseOptions = {},
): AnalystBenchmarkCase<TInput> {
  const trajectoryId = externalId(row.trajectory_id, 'AgentRx trajectory_id')
  if (!Array.isArray(row.failures) || row.failures.length === 0) {
    throw new TypeError(`AgentRx trajectory '${trajectoryId}' must contain failures`)
  }
  if (row.num_failures !== undefined && row.num_failures !== row.failures.length) {
    throw new TypeError(
      `AgentRx trajectory '${trajectoryId}' declares ${row.num_failures} failures but contains ${row.failures.length}`,
    )
  }
  const rootCauseId = externalId(
    row.root_cause_failure_id ?? row.root_cause?.failure_id,
    `AgentRx trajectory '${trajectoryId}' root cause failure id`,
  )
  const failureIds = new Set<string>()
  const evidenceKind = options.evidenceKind ?? 'span'
  const uri = options.stepUri ?? defaultStepUri
  const allIssues = row.failures.map((failure) => {
    const failureId = externalId(
      failure.failure_id,
      `AgentRx trajectory '${trajectoryId}' failure id`,
    )
    if (failureIds.has(failureId)) {
      throw new TypeError(`AgentRx trajectory '${trajectoryId}' repeats failure id '${failureId}'`)
    }
    failureIds.add(failureId)
    const step = positiveStep(failure.step_number, `AgentRx trajectory '${trajectoryId}'`)
    const evidence = [{ kind: evidenceKind, uri: uri(trajectoryId, step) }]
    const category = normalizeAgentRxCategory(failure.failure_category)
    return {
      id: failureId,
      areas: [category],
      ...(failureId === rootCauseId && (options.target ?? 'root-cause') === 'root-cause'
        ? {}
        : { evidence }),
      criticalEvidence: failureId === rootCauseId ? evidence : undefined,
    }
  })
  if (!failureIds.has(rootCauseId)) {
    throw new TypeError(
      `AgentRx trajectory '${trajectoryId}' root cause '${rootCauseId}' is not in failures`,
    )
  }
  if (
    options.stepCount !== undefined &&
    row.failures.some((failure) => failure.step_number > options.stepCount!)
  ) {
    throw new RangeError(
      `AgentRx trajectory '${trajectoryId}' contains a failure beyond stepCount ${options.stepCount}`,
    )
  }
  const expectedIssues =
    (options.target ?? 'root-cause') === 'root-cause'
      ? allIssues.filter((issue) => issue.id === rootCauseId)
      : allIssues

  return {
    id: `agentrx:${trajectoryId}`,
    input,
    expectedIssues,
    labeledEvidence: expectedIssues.flatMap(
      (issue) => issue.evidence ?? issue.criticalEvidence ?? [],
    ),
    tags: ['agentrx'],
    metadata: {
      benchmark: 'AgentRx',
      trajectoryId,
      failureSummary: row.failure_summary,
      rootCauseReason: row.root_cause_reason ?? row.root_cause?.reason_for_root_cause,
      annotatedFailures: row.failures.length,
      target: options.target ?? 'root-cause',
    },
  }
}

export function codeTraceBenchCase<TInput>(
  row: CodeTraceBenchRow,
  input: TInput,
  options: CodeTraceBenchCaseOptions = {},
): AnalystBenchmarkCase<TInput> {
  const trajectoryId = nonEmpty(row.traj_id, 'CodeTraceBench traj_id')
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

  return {
    id: `codetrace:${trajectoryId}`,
    input,
    expectedIssues,
    labeledEvidence: expectedIssues.flatMap((issue) => issue.evidence ?? []),
    tags: [
      'codetracebench',
      row.agent,
      row.model,
      ...(row.difficulty ? [row.difficulty] : []),
      ...(row.category ? [row.category] : []),
      ...parseTags(row.tags, trajectoryId),
    ],
    metadata: {
      benchmark: 'CodeTraceBench',
      trajectoryId,
      taskName: row.task_name,
      agent: row.agent,
      model: row.model,
      solved: row.solved,
      stepCount,
      labelSet,
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

/** Translate AgentRx `Report.to_dict()` output or its `failures` array into findings. */
export function agentRxPredictionsToFindings(
  trajectoryIdValue: ExternalId,
  output: unknown,
  options: UpstreamPredictionAdapterOptions = {},
): AnalystFinding[] {
  const trajectoryId = externalId(trajectoryIdValue, 'AgentRx prediction trajectory id')
  const parsed = parseAgentRxPredictions(output, trajectoryId)
  for (const prediction of parsed.predictions) {
    assertStepWithinRange(
      prediction.step_number,
      parsed.report?.trajectory_length,
      `AgentRx prediction '${trajectoryId}' report`,
    )
    assertStepWithinRange(
      prediction.step_number,
      options.stepCount,
      `AgentRx prediction '${trajectoryId}'`,
    )
  }
  const consensus = agentRxConsensus(parsed, trajectoryId)
  if (consensus.failureCase === 0) return []
  const confidence = predictionConfidence(options.confidence)
  const uri = options.stepUri ?? defaultStepUri
  assertStepWithinRange(consensus.step, options.stepCount, `AgentRx prediction '${trajectoryId}'`)
  const area = AGENT_RX_TAXONOMY.get(consensus.failureCase)!
  return [
    makeFinding({
      analyst_id: options.analystId ?? 'agentrx',
      produced_at: options.producedAt,
      area,
      subject: 'root-cause',
      claim: `AgentRx classified step ${consensus.step} as ${area}.`,
      id_basis: `${area}:${consensus.step}`,
      rationale: consensus.representative.description,
      severity: 'high',
      confidence,
      evidence_refs: [
        {
          kind: options.evidenceKind ?? 'span',
          uri: uri(trajectoryId, consensus.step),
        },
      ],
      metadata: {
        upstream: 'AgentRx',
        failure_case: consensus.failureCase,
        step: consensus.step,
        step_mean: consensus.stepMean,
        judge_votes: parsed.predictions.length,
        consensus_votes: consensus.votes,
        category_agreement: consensus.votes / parsed.predictions.length,
        ...(consensus.representative.checklist_reasoning === undefined ||
        consensus.representative.checklist_reasoning === null
          ? {}
          : { checklist_reasoning: consensus.representative.checklist_reasoning }),
      },
    }),
  ]
}

/** Translate CodeTracer's `codetracer_labels.json` into shared findings. */
export function codeTracerPredictionsToFindings(
  trajectoryIdValue: string,
  predictions: string | readonly CodeTraceStageAnnotation[],
  options: CodeTracerPredictionAdapterOptions = {},
): AnalystFinding[] {
  const trajectoryId = nonEmpty(trajectoryIdValue, 'CodeTracer prediction trajectory id')
  const stages = parseCodeTraceStages(predictions, trajectoryId)
  const confidence = predictionConfidence(options.confidence)
  const uri = options.stepUri ?? defaultStepUri
  const labelSet = codeTraceLabelSet(options.labelSet)
  const seen = new Set<string>()
  const findings: AnalystFinding[] = []
  for (const stage of stages) {
    for (const [area, steps] of [
      ['incorrect', stage.incorrect_step_ids ?? []],
      ['unuseful', stage.unuseful_step_ids ?? []],
    ] as const) {
      for (const rawStep of steps) {
        const step = positiveStep(rawStep, `CodeTracer prediction '${trajectoryId}' ${area} step`)
        assertStepWithinRange(step, options.stepCount, `CodeTracer prediction '${trajectoryId}'`)
        const key = `${area}:${step}`
        if (seen.has(key)) {
          throw new TypeError(`CodeTracer prediction '${trajectoryId}' repeats label '${key}'`)
        }
        seen.add(key)
        if (area === 'unuseful' && labelSet === 'incorrect-only') continue
        findings.push(
          makeFinding({
            analyst_id: options.analystId ?? 'codetracer',
            produced_at: options.producedAt,
            area,
            subject: `step-${step}`,
            claim: `CodeTracer labeled step ${step} as ${area}.`,
            id_basis: key,
            rationale: stage.reasoning,
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
              stage_id: stage.stage_id,
              step,
            },
          }),
        )
      }
    }
  }
  return findings
}

export function normalizeBenchmarkLabel(value: string): string {
  const normalized = nonEmpty(value, 'benchmark label')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!normalized) throw new TypeError('benchmark label must contain letters or digits')
  return normalized
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
  }
  return parsed as unknown as readonly CodeTraceStageAnnotation[]
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
  if (!Array.isArray(parsed) || !parsed.every((tag) => typeof tag === 'string')) {
    throw new TypeError(`CodeTraceBench '${trajectoryId}' tags must be strings`)
  }
  return [...parsed]
}

const AGENT_RX_TAXONOMY = new Map<number, string>([
  [1, 'instruction-plan-adherence-failure'],
  [2, 'invention-of-new-information'],
  [3, 'invalid-invocation'],
  [4, 'misinterpretation-of-tool-output-handoff-failure'],
  [5, 'intent-plan-misalignment'],
  [6, 'underspecified-user-intent'],
  [7, 'intent-not-supported'],
  [8, 'guardrails-triggered'],
  [9, 'system-failure'],
  [10, 'inconclusive'],
])

const AGENT_RX_CATEGORY_ALIASES = new Map<string, string>([
  ['instruction-adherence-failure', 'instruction-plan-adherence-failure'],
  ['misinterpretation-of-tool-output', 'misinterpretation-of-tool-output-handoff-failure'],
])

const AGENT_RX_TAXONOMY_BY_LABEL = new Map(
  [...AGENT_RX_TAXONOMY].map(([failureCase, label]) => [label, failureCase]),
)

export function normalizeAgentRxCategory(value: string): string {
  const normalized = normalizeBenchmarkLabel(value)
  return AGENT_RX_CATEGORY_ALIASES.get(normalized) ?? normalized
}

function parseAgentRxFailureCase(value: unknown, field: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError(`${field} must be a taxonomy number or label`)
  }
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    const normalized = normalizeAgentRxCategory(value)
    const failureCase = AGENT_RX_TAXONOMY_BY_LABEL.get(normalized)
    if (failureCase === undefined) {
      throw new RangeError(`${field} '${value}' is not an AgentRx taxonomy label`)
    }
    return failureCase
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric)) {
    throw new TypeError(`${field} must be a taxonomy number or label`)
  }
  if (numeric < 0 || numeric > 10) {
    throw new RangeError(`${field} ${numeric} is outside 0-10`)
  }
  return numeric
}

function predictionConfidence(value: number | undefined): number {
  const confidence = value ?? 0.5
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError('upstream prediction confidence must be between 0 and 1')
  }
  return confidence
}

function codeTraceLabelSet(value: CodeTraceBenchLabelSet | undefined): CodeTraceBenchLabelSet {
  if (value === undefined || value === 'incorrect-only') return 'incorrect-only'
  if (value === 'incorrect-and-unuseful') return value
  throw new TypeError(
    "CodeTraceBench labelSet must be 'incorrect-only' or 'incorrect-and-unuseful'",
  )
}

function assertStepWithinRange(step: number, stepCount: number | undefined, field: string): void {
  if (stepCount === undefined) return
  const count = positiveStep(stepCount, `${field} stepCount`)
  if (step > count) throw new RangeError(`${field} step ${step} exceeds stepCount ${count}`)
}

interface ParsedAgentRxPredictions {
  predictions: Array<
    Omit<AgentRxPrediction, 'failure_case'> & {
      failure_case: number
    }
  >
  report?: AgentRxPredictionReport
}

function parseAgentRxPredictions(output: unknown, trajectoryId: string): ParsedAgentRxPredictions {
  let failures: unknown
  let report: AgentRxPredictionReport | undefined
  if (Array.isArray(output)) {
    failures = output
  } else if (isRecord(output)) {
    assertMatchingAgentRxTaskId(output.task_id, trajectoryId, 'report.task_id')
    if (!Object.hasOwn(output, 'failures')) {
      throw new TypeError(`AgentRx prediction '${trajectoryId}' report must contain failures`)
    }
    failures = output.failures
    if (output.num_judges !== undefined) {
      if (!Number.isSafeInteger(output.num_judges) || (output.num_judges as number) < 0) {
        throw new RangeError(
          `AgentRx prediction '${trajectoryId}' report.num_judges must be a non-negative safe integer`,
        )
      }
    }
    if (output.trajectory_length !== undefined) {
      positiveStep(
        output.trajectory_length as number,
        `AgentRx prediction '${trajectoryId}' report.trajectory_length`,
      )
    }
    if (output.step_mean !== undefined) {
      if (typeof output.step_mean !== 'number' || !Number.isFinite(output.step_mean)) {
        throw new TypeError(`AgentRx prediction '${trajectoryId}' report.step_mean must be finite`)
      }
    }
    if (output.modes !== undefined && !Array.isArray(output.modes)) {
      throw new TypeError(`AgentRx prediction '${trajectoryId}' report.modes must be an array`)
    }
    report = output as unknown as AgentRxPredictionReport
  } else {
    throw new TypeError(`AgentRx prediction '${trajectoryId}' must be a report or failures array`)
  }
  if (!Array.isArray(failures)) {
    throw new TypeError(`AgentRx prediction '${trajectoryId}' failures must be an array`)
  }
  if (failures.length === 0) {
    throw new TypeError(
      `AgentRx prediction '${trajectoryId}' failures must contain a judge prediction`,
    )
  }
  if (
    isRecord(output) &&
    output.num_judges !== undefined &&
    output.num_judges !== failures.length
  ) {
    throw new TypeError(
      `AgentRx prediction '${trajectoryId}' declares ${output.num_judges} judges but contains ${failures.length} failures`,
    )
  }
  const predictions = failures.map((value, index) => {
    const field = `AgentRx prediction '${trajectoryId}' failures[${index}]`
    if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
    assertMatchingAgentRxTaskId(value.task_id, trajectoryId, `${field}.task_id`)
    const failureCase = parseAgentRxFailureCase(value.failure_case, `${field}.failure_case`)
    if (!Number.isSafeInteger(value.step_number)) {
      throw new TypeError(`${field}.step_number must be a safe integer`)
    }
    const stepNumber = value.step_number as number
    if (failureCase === 0 ? stepNumber !== 0 : stepNumber < 1) {
      throw new RangeError(
        failureCase === 0
          ? `${field}.step_number must be 0 when failure_case is 0`
          : `${field}.step_number must be positive when failure_case is 1-10`,
      )
    }
    if (value.description !== undefined && typeof value.description !== 'string') {
      throw new TypeError(`${field}.description must be a string`)
    }
    if (
      value.checklist_reasoning !== undefined &&
      value.checklist_reasoning !== null &&
      typeof value.checklist_reasoning !== 'string'
    ) {
      throw new TypeError(`${field}.checklist_reasoning must be a string or null`)
    }
    return {
      ...(value.task_id === undefined ? {} : { task_id: value.task_id as ExternalId }),
      failure_case: failureCase,
      step_number: stepNumber,
      ...(value.description === undefined ? {} : { description: value.description as string }),
      ...(value.checklist_reasoning === undefined
        ? {}
        : { checklist_reasoning: value.checklist_reasoning as string | null }),
    }
  })
  return { predictions, report }
}

function agentRxConsensus(
  parsed: ParsedAgentRxPredictions,
  trajectoryId: string,
): {
  failureCase: number
  step: number
  stepMean: number
  votes: number
  representative: ParsedAgentRxPredictions['predictions'][number]
} {
  const counts = new Map<number, number>()
  for (const prediction of parsed.predictions) {
    counts.set(prediction.failure_case, (counts.get(prediction.failure_case) ?? 0) + 1)
  }
  const maxVotes = Math.max(...counts.values())
  let failureCase = [...counts].find(([, count]) => count === maxVotes)![0]
  if (parsed.report?.most_common_failure !== undefined) {
    const declared = parseAgentRxFailureCase(
      parsed.report.most_common_failure,
      `AgentRx prediction '${trajectoryId}' report.most_common_failure`,
    )
    if ((counts.get(declared) ?? 0) !== maxVotes) {
      throw new TypeError(
        `AgentRx prediction '${trajectoryId}' report.most_common_failure disagrees with failures`,
      )
    }
    failureCase = declared
  }
  if (parsed.report?.modes !== undefined) {
    const declaredModes = parsed.report.modes.map((value, index) =>
      parseAgentRxFailureCase(value, `AgentRx prediction '${trajectoryId}' report.modes[${index}]`),
    )
    if (new Set(declaredModes).size !== declaredModes.length) {
      throw new TypeError(`AgentRx prediction '${trajectoryId}' report.modes contains duplicates`)
    }
    const expectedModes = [...counts]
      .filter(([, count]) => count === maxVotes)
      .map(([value]) => value)
      .sort((left, right) => left - right)
    if (
      [...new Set(declaredModes)].sort((left, right) => left - right).join(',') !==
      expectedModes.join(',')
    ) {
      throw new TypeError(
        `AgentRx prediction '${trajectoryId}' report.modes disagrees with failures`,
      )
    }
  }

  const computedStepMean =
    parsed.predictions.reduce((sum, prediction) => sum + prediction.step_number, 0) /
    parsed.predictions.length
  if (
    parsed.report?.step_mean !== undefined &&
    Math.abs(parsed.report.step_mean - computedStepMean) > 1e-12
  ) {
    throw new TypeError(
      `AgentRx prediction '${trajectoryId}' report.step_mean disagrees with failures`,
    )
  }
  const stepMean = parsed.report?.step_mean ?? computedStepMean
  const step =
    failureCase === 0
      ? 0
      : positiveStep(
          roundHalfToEven(stepMean),
          `AgentRx prediction '${trajectoryId}' consensus step`,
        )
  const representative =
    parsed.predictions
      .filter((prediction) => prediction.failure_case === failureCase)
      .sort(
        (left, right) => Math.abs(left.step_number - step) - Math.abs(right.step_number - step),
      )[0] ?? parsed.predictions[0]!
  return {
    failureCase,
    step,
    stepMean,
    votes: counts.get(failureCase)!,
    representative,
  }
}

function roundHalfToEven(value: number): number {
  const lower = Math.floor(value)
  const fraction = value - lower
  if (Math.abs(fraction - 0.5) <= Number.EPSILON * Math.max(1, Math.abs(value))) {
    return lower % 2 === 0 ? lower : lower + 1
  }
  return Math.round(value)
}

function assertMatchingAgentRxTaskId(value: unknown, trajectoryId: string, field: string): void {
  if (value === undefined) return
  const taskId = externalId(value as ExternalId, `AgentRx prediction '${trajectoryId}' ${field}`)
  if (taskId !== trajectoryId) {
    throw new TypeError(
      `AgentRx prediction '${trajectoryId}' ${field} '${taskId}' does not match trajectory id`,
    )
  }
}

function defaultStepUri(trajectoryId: string, step: number): string {
  return `trace://${encodeURIComponent(trajectoryId)}/span/step-${step}`
}

function optionalStepArray(value: readonly number[] | undefined): boolean {
  return value === undefined || (Array.isArray(value) && value.every(Number.isSafeInteger))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveStep(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value
}

function externalId(value: ExternalId | undefined, field: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${field} must be a string or number`)
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer when numeric`)
  }
  return nonEmpty(String(value), field)
}

function nonEmpty(value: string, field: string): string {
  if (!value.trim()) throw new TypeError(`${field} must not be empty`)
  return value
}
