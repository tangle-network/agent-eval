import type { AnalystBenchmarkCase } from './benchmark'
import type {
  AgentRxBenchmarkCaseOptions,
  AgentRxPrediction,
  AgentRxPredictionReport,
  AgentRxRow,
  ExternalId,
  UpstreamPredictionAdapterOptions,
} from './benchmark-dataset-types'
import {
  assertStepWithinRange,
  defaultStepUri,
  externalId,
  isRecord,
  normalizeBenchmarkLabel,
  positiveStep,
  predictionConfidence,
} from './benchmark-dataset-utils'
import { type AnalystFinding, makeFinding } from './types'

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
  const failureMetadata: Array<{ id: string; step: number; category: string }> = []
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
    if (typeof failure.failure_category !== 'string') {
      throw new TypeError(
        `AgentRx trajectory '${trajectoryId}' failure '${failureId}' category must be a string`,
      )
    }
    const category = normalizeAgentRxCategory(failure.failure_category)
    if (!AGENT_RX_TAXONOMY_BY_LABEL.has(category)) {
      throw new RangeError(
        `AgentRx trajectory '${trajectoryId}' failure '${failureId}' category '${failure.failure_category}' is outside the AgentRx taxonomy`,
      )
    }
    failureMetadata.push({ id: failureId, step, category })
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
  const rootCause = failureMetadata.find((failure) => failure.id === rootCauseId)!
  const orderedFailures = [...failureMetadata].sort(
    (left, right) => left.step - right.step || left.id.localeCompare(right.id),
  )

  return {
    id: `agentrx:${trajectoryId}`,
    clusterId: `agentrx:${trajectoryId}`,
    labelState: 'positive',
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
      rootCauseStep: rootCause.step,
      rootCauseCategory: rootCause.category,
      allFailureCategories: [...new Set(failureMetadata.map((failure) => failure.category))].sort(),
      earliestFailureCategory: orderedFailures[0]!.category,
      terminalFailureCategory: orderedFailures.at(-1)!.category,
      ...(options.stepCount === undefined ? {} : { trajectoryLength: options.stepCount }),
    },
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
          roundAgentRxStep(stepMean),
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

/** Match Python's round() behavior used by AgentRx for consensus steps. */
export function roundAgentRxStep(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError('AgentRx step mean must be finite')
  }
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
