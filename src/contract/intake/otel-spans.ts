/**
 * # `intake/otel-spans` — OTel `TraceSpanEvent[]` → `RunRecord[]`.
 *
 * Turns an existing observability stream into the substrate-canonical
 * `RunRecord` shape so consumers with logs but no eval discipline can
 * call `analyzeRuns()` against their production traffic immediately.
 *
 * Pivot rule: spans are grouped by `tangle.runId` (the same attribute the
 * hosted-tier wire format uses) or, when absent, by `traceId`. One group
 * becomes one `RunRecord`. The root span (no `parentSpanId`) supplies:
 *
 *   - `runId` (the group key)
 *   - `wallMs` from `endTimeUnixNano - startTimeUnixNano`
 *   - `model` from `gen_ai.request.model` / `llm.model` / `tangle.model`
 *   - task failure class and detail from explicit `tangle.task.*` attributes
 *   - cost from `cost.usd` / `gen_ai.usage.cost_usd` / `tangle.cost.usd`
 *   - token usage from model-call input, output, cache-read, and cache-write
 *     attributes without double-counting aggregate parent spans
 *   - task quality from an explicit `scoreForRun` callback or a designated
 *     evaluation attribute on a root / `EVALUATOR` span; `outcome.raw`
 *     collects every numeric attribute without promoting it to task quality.
 *
 * Errored tool, model, and child-agent spans contribute to execution-error
 * counts. Root process, guardrail, evaluator, propagated parent, and unknown
 * errors retain separate counters. Only one failed root can set
 * `RunRecord.terminalOutcome` and `RunRecord.terminalFailureReason`; a child
 * error cannot become a task failure.
 */

import { ValidationError } from '../../errors'
import type { TraceSpanEvent } from '../../hosted/types'
import type {
  JudgeScoresRecord,
  RunOutcome,
  RunRecord,
  RunSplitTag,
  RunTerminalOutcome,
} from '../../run-record'
import { summarizeTraceErrors, type TraceErrorRole } from '../../trace/error-classification'
import {
  recordAggregateMeasurements,
  summarizeExecutionMeasurements,
} from '../../trace/execution-measurements'
import {
  classifyOtlpSpanRole,
  isOtlpModelCall,
  LLM_MODEL_ATTR_KEYS,
  SPAN_KIND_ATTR_KEYS,
} from '../../trace/otlp-attributes'
import { readTaskFailureLabels } from '../../trace/task-failure-attributes'

const TASK_SCORE_ATTR_KEYS = [
  'gen_ai.evaluation.score.value',
  'tangle.task.score',
  'eval.score',
  'tangle.score',
] as const
const MODEL_KEYS = ['tangle.model', ...LLM_MODEL_ATTR_KEYS, 'model']
const PROMPT_HASH_KEYS = ['tangle.prompt_hash', 'prompt.hash']
const CONFIG_HASH_KEYS = ['tangle.config_hash', 'config.hash']

export interface FromOtelSpansOptions {
  spans: TraceSpanEvent[]
  /** Default split tag for synthesized records. Defaults to `'holdout'`. */
  defaultSplit?: RunSplitTag
  /** Default `experimentId` when not present on any span. */
  experimentId?: string
  /**
   * Explicit task-quality score for a logical run. The callback receives
   * spans in deterministic time/id order. Its value must agree with any
   * designated score attributes present on root or `EVALUATOR` spans.
   */
  scoreForRun?: (runId: string, spans: readonly TraceSpanEvent[]) => number | undefined
}

export function fromOtelSpans(opts: FromOtelSpansOptions): RunRecord[] {
  const { spans, defaultSplit = 'holdout', experimentId = 'otel-corpus' } = opts
  const grouped = groupSpans(spans)

  const runs: RunRecord[] = []
  for (const [groupKey, groupSpans] of grouped) {
    const root = findRoot(groupSpans)
    if (!root) continue
    const measurements = summarizeExecutionMeasurements(
      groupSpans.map((span) => ({
        id: span.spanId,
        ...(span.parentSpanId ? { parentId: span.parentSpanId } : {}),
        attributes: span.attributes,
        modelCall: isExplicitModelCall(span),
        aggregate: isExplicitAggregate(span),
      })),
    )
    const callSpanIds = new Set(measurements.callSpanIds)
    const callSpans = groupSpans.filter((span) => callSpanIds.has(span.spanId))
    const wallMs = unixNanoDurationMs(root.startTimeUnixNano, root.endTimeUnixNano)
    const model =
      readAttrString(callSpans, MODEL_KEYS) ??
      readAttrString(groupSpans, MODEL_KEYS) ??
      'unknown@unknown'
    const capturedCost =
      (measurements.cost.complete ? measurements.cost.value : undefined) ??
      measurements.aggregate?.costUsd
    const costUsd = capturedCost ?? null
    const scenarioId = readConsistentScenarioId(groupKey, groupSpans) ?? groupKey
    const promptHash = readAttrString(groupSpans, PROMPT_HASH_KEYS) ?? 'sha256:unknown'
    const configHash = readAttrString(groupSpans, CONFIG_HASH_KEYS) ?? 'sha256:unknown'
    const score = resolveTaskScore(groupKey, groupSpans, opts.scoreForRun)
    const taskFailure = readTaskFailureLabels(
      groupSpans.filter((span) => !span.parentSpanId && isTerminalRootCandidate(span)),
      `fromOtelSpans: run '${groupKey}'`,
    )

    const rawNumeric = collectNumericAttrs(groupSpans)
    const errorSummary = summarizeTraceErrors(
      groupSpans.map((span) => ({
        id: spanIdentity(span),
        ...(span.parentSpanId ? { parentId: parentIdentity(span) } : {}),
        role: errorRoleForSpan(span),
        error: span.status?.code === 'ERROR',
        processRoot: !span.parentSpanId && isTerminalRootCandidate(span),
      })),
    )
    rawNumeric.error_span_count = errorSummary.total
    rawNumeric.execution_error_count = errorSummary.execution
    rawNumeric.process_error_count = errorSummary.process
    rawNumeric.guardrail_error_count = errorSummary.guardrail
    rawNumeric.judge_error_count = errorSummary.evaluation
    rawNumeric.propagated_error_count = errorSummary.propagated
    rawNumeric.unclassified_error_count = errorSummary.unclassified
    rawNumeric.llm_span_count = measurements.modelCallCount
    if (measurements.cost.value !== undefined && !measurements.cost.complete) {
      rawNumeric.partial_observed_cost_usd = measurements.cost.value
    }
    recordAggregateMeasurements(rawNumeric, measurements.aggregate)

    const judgeScores: JudgeScoresRecord | undefined =
      score !== undefined
        ? {
            perJudge: { 'otel-derived': { score } },
            perDimMean: { score },
            composite: score,
          }
        : undefined

    const terminalOutcome = terminalOutcomeFromRoots(groupSpans)
    const failedRoot =
      terminalOutcome === 'failed'
        ? groupSpans.find(
            (span) =>
              !span.parentSpanId && isTerminalRootCandidate(span) && span.status?.code === 'ERROR',
          )
        : undefined
    const outcome: RunOutcome = {
      raw: rawNumeric,
      ...(judgeScores ? { judgeScores } : {}),
    }
    if (score !== undefined) {
      if (defaultSplit === 'holdout') outcome.holdoutScore = score
      else outcome.searchScore = score
    }

    runs.push({
      runId: groupKey,
      experimentId,
      candidateId: (root.attributes['tangle.candidateId'] as string | undefined) ?? 'otel-default',
      seed: 0,
      model,
      promptHash,
      configHash,
      commitSha: (root.attributes['tangle.commit_sha'] as string | undefined) ?? 'unknown',
      wallMs,
      costUsd,
      costProvenance:
        capturedCost === undefined
          ? { kind: 'uncaptured', usd: null }
          : { kind: 'observed', usd: capturedCost },
      tokenUsage: measurements.tokenUsage,
      terminalOutcome,
      ...(failedRoot
        ? { terminalFailureReason: failedRoot.status?.message ?? failedRoot.name }
        : {}),
      outcome,
      ...taskFailure,
      splitTag: defaultSplit,
      scenarioId,
    })
  }
  return runs
}

function terminalOutcomeFromRoots(spans: TraceSpanEvent[]): RunTerminalOutcome {
  const roots = spans.filter((span) => !span.parentSpanId && isTerminalRootCandidate(span))
  if (roots.length !== 1) return 'unknown'
  if (roots[0]!.status?.code === 'OK') return 'succeeded'
  if (roots[0]!.status?.code === 'ERROR') return 'failed'
  return 'unknown'
}

function isTerminalRootCandidate(span: TraceSpanEvent): boolean {
  const role = errorRoleForSpan(span)
  if (role === 'LLM' || role === 'TOOL' || role === 'GUARDRAIL' || role === 'EVALUATOR') {
    return false
  }
  return true
}

function readSpanKind(span: TraceSpanEvent): string | undefined {
  return readAttrString([span], [...SPAN_KIND_ATTR_KEYS, 'span.kind'])?.toUpperCase()
}

function errorRoleForSpan(span: TraceSpanEvent): TraceErrorRole {
  return classifyOtlpSpanRole({
    kind: readSpanKind(span),
    name: span.name,
    attributes: span.attributes,
  })
}

function spanIdentity(span: TraceSpanEvent): string {
  return `${span.traceId}:${span.spanId}`
}

function parentIdentity(span: TraceSpanEvent): string {
  return `${span.traceId}:${span.parentSpanId}`
}

function isExplicitModelCall(span: TraceSpanEvent): boolean {
  return isOtlpModelCall({
    kind: readSpanKind(span),
    name: span.name,
    attributes: span.attributes,
  })
}

function isExplicitAggregate(span: TraceSpanEvent): boolean {
  const kind = readSpanKind(span)
  return kind !== undefined && kind !== 'LLM'
}

// ── Internal helpers ────────────────────────────────────────────────

function groupSpans(spans: TraceSpanEvent[]): Map<string, TraceSpanEvent[]> {
  const m = new Map<string, TraceSpanEvent[]>()
  for (const span of spans) {
    const key = (span['tangle.runId'] as string | undefined) ?? span.traceId
    const list = m.get(key) ?? []
    list.push(span)
    m.set(key, list)
  }
  return m
}

function findRoot(group: TraceSpanEvent[]): TraceSpanEvent | undefined {
  const structuralRoots = group.filter((span) => !span.parentSpanId)
  const terminalRoots = structuralRoots.filter(isTerminalRootCandidate)
  const pool =
    terminalRoots.length > 0 ? terminalRoots : structuralRoots.length > 0 ? structuralRoots : group
  return orderSpans(pool)[0]
}

function readAttrString(spans: TraceSpanEvent[], keys: string[]): string | undefined {
  for (const span of spans) {
    for (const key of keys) {
      const v = span.attributes[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return undefined
}

function readConsistentScenarioId(
  runId: string,
  spans: readonly TraceSpanEvent[],
): string | undefined {
  const values = new Set<string>()
  for (const span of spans) {
    const topLevel = span['tangle.scenarioId']
    if (typeof topLevel === 'string' && topLevel.length > 0) values.add(topLevel)
    const attribute = span.attributes['tangle.scenarioId']
    if (typeof attribute === 'string' && attribute.length > 0) values.add(attribute)
  }
  if (values.size > 1) {
    throw new ValidationError(
      `fromOtelSpans: conflicting scenario ids for run '${runId}': ${[...values].sort().join(', ')}`,
    )
  }
  return values.values().next().value
}

interface TaskScoreSource {
  label: string
  value: number
}

function resolveTaskScore(
  runId: string,
  spans: TraceSpanEvent[],
  scoreForRun: FromOtelSpansOptions['scoreForRun'],
): number | undefined {
  const orderedSpans = orderSpans(spans)
  const sources: TaskScoreSource[] = []

  if (scoreForRun) {
    const supplied: unknown = scoreForRun(runId, orderedSpans)
    if (supplied !== undefined) {
      if (typeof supplied !== 'number' || !Number.isFinite(supplied)) {
        throw new ValidationError(
          `fromOtelSpans: scoreForRun returned a non-finite number for run '${runId}'`,
        )
      }
      sources.push({ label: 'scoreForRun', value: supplied })
    }
  }

  for (const span of orderedSpans) {
    const role = errorRoleForSpan(span)
    if (span.parentSpanId && role !== 'EVALUATOR') continue
    if (role === 'EVALUATOR' && span.status?.code === 'ERROR') continue
    for (const key of TASK_SCORE_ATTR_KEYS) {
      if (!Object.hasOwn(span.attributes, key)) continue
      sources.push({
        label: `span '${span.spanId}' attribute '${key}'`,
        value: parseTaskScoreAttribute(runId, span.spanId, key, span.attributes[key]),
      })
    }
  }

  if (sources.length === 0) return undefined
  sources.sort((left, right) => left.label.localeCompare(right.label))
  const score = sources[0]!.value
  if (sources.some((source) => source.value !== score)) {
    const details = sources.map((source) => `${source.label}=${source.value}`).join(', ')
    throw new ValidationError(
      `fromOtelSpans: conflicting task-quality scores for run '${runId}': ${details}`,
    )
  }
  return score
}

function parseTaskScoreAttribute(
  runId: string,
  spanId: string,
  key: string,
  value: unknown,
): number {
  const source = `span '${spanId}' attribute '${key}'`
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new ValidationError(
        `fromOtelSpans: ${source} is blank for run '${runId}'; task quality must be finite`,
      )
    }
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  throw new ValidationError(
    `fromOtelSpans: ${source} is not a finite task-quality score for run '${runId}'`,
  )
}

function orderSpans(spans: readonly TraceSpanEvent[]): TraceSpanEvent[] {
  return [...spans].sort(
    (left, right) =>
      compareUnixNano(left.startTimeUnixNano, right.startTimeUnixNano) ||
      left.spanId.localeCompare(right.spanId),
  )
}

function parseUnixNano(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    throw new ValidationError(`fromOtelSpans: invalid Unix nanosecond timestamp '${value}'`)
  }
}

function compareUnixNano(left: string, right: string): number {
  const leftValue = parseUnixNano(left)
  const rightValue = parseUnixNano(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function unixNanoDurationMs(start: string, end: string): number {
  const delta = parseUnixNano(end) - parseUnixNano(start)
  if (delta <= 0n) return 0
  const wholeMs = delta / 1_000_000n
  const fractionalMs = delta % 1_000_000n
  const value = Number(wholeMs) + Number(fractionalMs) / 1_000_000
  if (!Number.isSafeInteger(Number(wholeMs))) {
    throw new ValidationError('fromOtelSpans: span duration exceeds the safe millisecond range')
  }
  return value
}

function collectNumericAttrs(spans: TraceSpanEvent[]): Record<string, number> {
  const raw: Record<string, number> = {}
  for (const span of spans) {
    for (const [k, v] of Object.entries(span.attributes)) {
      if (typeof v === 'number' && Number.isFinite(v)) raw[k] = v
    }
  }
  return raw
}
