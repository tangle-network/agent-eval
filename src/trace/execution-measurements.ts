import type { RunTokenUsage } from '../run-record'
import {
  LLM_CACHE_WRITE_TOKEN_ATTR_KEYS,
  LLM_CACHED_TOKEN_ATTR_KEYS,
  LLM_COST_ATTR_KEYS,
  LLM_INPUT_TOKEN_ATTR_KEYS,
  LLM_OUTPUT_TOKEN_ATTR_KEYS,
  LLM_REASONING_TOKEN_ATTR_KEYS,
  RUN_COST_ATTR_KEYS,
} from './otlp-attributes'

export interface ExecutionMeasurementSpan {
  id: string
  parentId?: string
  attributes: Record<string, unknown>
  modelCall: boolean
  aggregate: boolean
}

export interface MeasurementCoverage {
  value?: number
  reportingCalls: number
  complete: boolean
}

export interface ExecutionMeasurements {
  tokenUsage: RunTokenUsage
  modelCallCount: number
  callSpanIds: string[]
  cost: MeasurementCoverage
  aggregate?: {
    tokenUsage: RunTokenUsage
    costUsd?: number
  }
}

const TOKEN_MEASUREMENT_KEY_GROUPS = [
  LLM_INPUT_TOKEN_ATTR_KEYS,
  LLM_OUTPUT_TOKEN_ATTR_KEYS,
  LLM_REASONING_TOKEN_ATTR_KEYS,
  LLM_CACHED_TOKEN_ATTR_KEYS,
  LLM_CACHE_WRITE_TOKEN_ATTR_KEYS,
] as const

const EXECUTION_MEASUREMENT_KEY_GROUPS = [
  ...TOKEN_MEASUREMENT_KEY_GROUPS,
  LLM_COST_ATTR_KEYS,
] as const

interface RetainedCallSummary {
  callCount: number
  measurements: Array<{
    total: number
    reportingCalls: number
  }>
}

/**
 * Reconcile execution measurements across nested telemetry wrappers.
 * A measured parent is used only when a descendant call does not report the
 * same field, so aggregate wrappers neither duplicate complete child data nor
 * erase complementary parent fields.
 */
export function summarizeExecutionMeasurements(
  spans: ExecutionMeasurementSpan[],
): ExecutionMeasurements {
  const byId = new Map<string, ExecutionMeasurementSpan>()
  for (const span of spans) {
    if (byId.has(span.id)) {
      throw new Error(`summarizeExecutionMeasurements: duplicate span id "${span.id}"`)
    }
    byId.set(span.id, span)
  }
  const tokenMeasurementKeys = TOKEN_MEASUREMENT_KEY_GROUPS.flat()
  const candidates = spans.filter(
    (span) =>
      span.modelCall ||
      (!span.aggregate && readNumber(span.attributes, tokenMeasurementKeys) !== undefined),
  )
  const candidateIds = new Set(candidates.map((span) => span.id))
  const candidateChildren = new Map<string, ExecutionMeasurementSpan[]>()
  for (const candidate of candidates) {
    const parentId = nearestCandidateParent(candidate, byId, candidateIds)
    if (!parentId) continue
    const children = candidateChildren.get(parentId) ?? []
    children.push(candidate)
    candidateChildren.set(parentId, children)
  }
  const aggregateIds = classifyAggregateSpans(candidates, candidateChildren)
  const untypedRunCostIds = new Set(
    spans
      .filter(
        (span) =>
          !span.modelCall &&
          !span.aggregate &&
          !candidateIds.has(span.id) &&
          readNumber(span.attributes, RUN_COST_ATTR_KEYS) !== undefined,
      )
      .map((span) => span.id),
  )
  const aggregateSourceIds = new Set(
    spans
      .filter(
        (span) => span.aggregate || aggregateIds.has(span.id) || untypedRunCostIds.has(span.id),
      )
      .map((span) => span.id),
  )

  const calls = candidates.filter((span) => !aggregateIds.has(span.id))
  const input = reconcileMeasurement(calls, byId, aggregateSourceIds, LLM_INPUT_TOKEN_ATTR_KEYS)
  const reasoning = reconcileMeasurement(
    calls,
    byId,
    aggregateSourceIds,
    LLM_REASONING_TOKEN_ATTR_KEYS,
  )
  const output = reconcileMeasurement(
    calls,
    byId,
    aggregateSourceIds,
    LLM_OUTPUT_TOKEN_ATTR_KEYS,
    LLM_REASONING_TOKEN_ATTR_KEYS,
  )
  const cached = reconcileMeasurement(calls, byId, aggregateSourceIds, LLM_CACHED_TOKEN_ATTR_KEYS)
  const cacheWrite = reconcileMeasurement(
    calls,
    byId,
    aggregateSourceIds,
    LLM_CACHE_WRITE_TOKEN_ATTR_KEYS,
  )
  const aggregate = summarizeAggregateMeasurements(
    spans,
    byId,
    new Set([...aggregateIds, ...untypedRunCostIds]),
  )

  return {
    tokenUsage: {
      input: input.value ?? 0,
      output: Math.max(output.value ?? 0, reasoning.value ?? 0),
      ...(reasoning.value !== undefined ? { reasoning: reasoning.value } : {}),
      ...(cached.value !== undefined ? { cached: cached.value } : {}),
      ...(cacheWrite.value !== undefined ? { cacheWrite: cacheWrite.value } : {}),
    },
    modelCallCount: calls.length,
    callSpanIds: calls.map((span) => span.id),
    cost: reconcileMeasurement(calls, byId, aggregateSourceIds, LLM_COST_ATTR_KEYS),
    ...(aggregate ? { aggregate } : {}),
  }
}

export function recordAggregateMeasurements(
  raw: Record<string, number>,
  aggregate: ExecutionMeasurements['aggregate'],
): void {
  if (!aggregate) return
  raw.aggregate_prompt_tokens = aggregate.tokenUsage.input
  raw.aggregate_completion_tokens = aggregate.tokenUsage.output
  if (aggregate.tokenUsage.reasoning !== undefined)
    raw.aggregate_reasoning_tokens = aggregate.tokenUsage.reasoning
  if (aggregate.tokenUsage.cached !== undefined)
    raw.aggregate_cached_tokens = aggregate.tokenUsage.cached
  if (aggregate.tokenUsage.cacheWrite !== undefined)
    raw.aggregate_cache_write_tokens = aggregate.tokenUsage.cacheWrite
  if (aggregate.costUsd !== undefined) raw.aggregate_cost_usd = aggregate.costUsd
}

function summarizeAggregateMeasurements(
  spans: ExecutionMeasurementSpan[],
  byId: Map<string, ExecutionMeasurementSpan>,
  aggregateIds: Set<string>,
): ExecutionMeasurements['aggregate'] {
  const aggregates = spans.filter((span) => span.aggregate || aggregateIds.has(span.id))
  const input = reconcileTopLevelMeasurement(aggregates, byId, LLM_INPUT_TOKEN_ATTR_KEYS)
  const output = reconcileTopLevelMeasurement(aggregates, byId, LLM_OUTPUT_TOKEN_ATTR_KEYS)
  const reasoning = reconcileTopLevelMeasurement(aggregates, byId, LLM_REASONING_TOKEN_ATTR_KEYS)
  const cached = reconcileTopLevelMeasurement(aggregates, byId, LLM_CACHED_TOKEN_ATTR_KEYS)
  const cacheWrite = reconcileTopLevelMeasurement(aggregates, byId, LLM_CACHE_WRITE_TOKEN_ATTR_KEYS)
  const costUsd = reconcileTopLevelMeasurement(aggregates, byId, LLM_COST_ATTR_KEYS)
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cached === undefined &&
    cacheWrite === undefined &&
    costUsd === undefined
  )
    return undefined
  return {
    tokenUsage: {
      input: input ?? 0,
      output: output ?? reasoning ?? 0,
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(cached !== undefined ? { cached } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

function reconcileTopLevelMeasurement(
  spans: ExecutionMeasurementSpan[],
  byId: Map<string, ExecutionMeasurementSpan>,
  keys: readonly string[],
): number | undefined {
  const selected = new Map<string, number>()
  for (const span of spans) {
    const value = readNumber(span.attributes, keys)
    if (value !== undefined) selected.set(span.id, value)
  }
  for (const spanId of [...selected.keys()]) {
    const span = byId.get(spanId)
    if (!span) continue
    if (ancestorIds(span, byId).some((ancestorId) => selected.has(ancestorId))) {
      selected.delete(spanId)
    }
  }
  return selected.size > 0
    ? [...selected.values()].reduce((total, value) => total + value, 0)
    : undefined
}

function reconcileMeasurement(
  calls: ExecutionMeasurementSpan[],
  byId: Map<string, ExecutionMeasurementSpan>,
  aggregateSourceIds: Set<string>,
  keys: readonly string[],
  fallbackKeys?: readonly string[],
): MeasurementCoverage {
  const selected = new Map<string, number>()
  const callIds = new Set(calls.map((call) => call.id))
  let reportingCalls = 0

  for (const call of calls) {
    const primary = nearestMeasurement(call, byId, callIds, aggregateSourceIds, keys)
    const fallback = fallbackKeys
      ? nearestMeasurement(call, byId, callIds, aggregateSourceIds, fallbackKeys)
      : undefined
    const source =
      primary && fallback && primary.span.id === fallback.span.id
        ? { span: primary.span, value: Math.max(primary.value, fallback.value) }
        : (primary ?? fallback)
    if (!source) continue
    reportingCalls += 1
    selected.set(source.span.id, source.value)
  }

  for (const spanId of [...selected.keys()]) {
    const span = byId.get(spanId)
    if (!span) continue
    if (
      ancestorIds(span, byId).some(
        (ancestorId) => selected.has(ancestorId) && !callIds.has(ancestorId),
      )
    ) {
      selected.delete(spanId)
    }
  }

  return {
    ...(selected.size > 0
      ? { value: [...selected.values()].reduce((total, value) => total + value, 0) }
      : {}),
    reportingCalls,
    complete: calls.length > 0 && reportingCalls === calls.length,
  }
}

function nearestMeasurement(
  call: ExecutionMeasurementSpan,
  byId: Map<string, ExecutionMeasurementSpan>,
  callIds: Set<string>,
  aggregateSourceIds: Set<string>,
  keys: readonly string[],
): { span: ExecutionMeasurementSpan; value: number } | undefined {
  let current: ExecutionMeasurementSpan | undefined = call
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const value = readNumber(current.attributes, keys)
    if (
      value !== undefined &&
      (current.id === call.id || (!callIds.has(current.id) && aggregateSourceIds.has(current.id)))
    ) {
      return { span: current, value }
    }
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return undefined
}

function classifyAggregateSpans(
  candidates: ExecutionMeasurementSpan[],
  childrenById: Map<string, ExecutionMeasurementSpan[]>,
): Set<string> {
  const aggregateIds = new Set<string>()
  const summaries = new Map<string, RetainedCallSummary>()
  const visiting = new Set<string>()

  const visit = (span: ExecutionMeasurementSpan): RetainedCallSummary => {
    const cached = summaries.get(span.id)
    if (cached) return cached
    if (visiting.has(span.id)) return emptyRetainedCallSummary()
    visiting.add(span.id)

    const descendants = emptyRetainedCallSummary()
    for (const child of childrenById.get(span.id) ?? []) {
      const childDescendants = visit(child)
      if (!aggregateIds.has(child.id)) addRetainedCall(descendants, child)
      addRetainedCallSummary(descendants, childDescendants)
    }

    if (
      descendants.callCount > 0 &&
      (!span.modelCall || hasCompatibleDescendantMeasurements(span, descendants))
    ) {
      aggregateIds.add(span.id)
    }

    visiting.delete(span.id)
    summaries.set(span.id, descendants)
    return descendants
  }

  for (const candidate of candidates) visit(candidate)
  return aggregateIds
}

function emptyRetainedCallSummary(): RetainedCallSummary {
  return {
    callCount: 0,
    measurements: EXECUTION_MEASUREMENT_KEY_GROUPS.map(() => ({
      total: 0,
      reportingCalls: 0,
    })),
  }
}

function addRetainedCall(summary: RetainedCallSummary, span: ExecutionMeasurementSpan): void {
  summary.callCount += 1
  for (let index = 0; index < EXECUTION_MEASUREMENT_KEY_GROUPS.length; index += 1) {
    const value = readNumber(span.attributes, EXECUTION_MEASUREMENT_KEY_GROUPS[index]!)
    if (value === undefined) continue
    const measurement = summary.measurements[index]!
    measurement.total += value
    measurement.reportingCalls += 1
  }
}

function addRetainedCallSummary(target: RetainedCallSummary, source: RetainedCallSummary): void {
  target.callCount += source.callCount
  for (let index = 0; index < target.measurements.length; index += 1) {
    const measurement = target.measurements[index]!
    const sourceMeasurement = source.measurements[index]!
    measurement.total += sourceMeasurement.total
    measurement.reportingCalls += sourceMeasurement.reportingCalls
  }
}

function hasCompatibleDescendantMeasurements(
  span: ExecutionMeasurementSpan,
  descendants: RetainedCallSummary,
): boolean {
  let parentMeasurements = 0
  let descendantMeasurements = 0
  for (let index = 0; index < EXECUTION_MEASUREMENT_KEY_GROUPS.length; index += 1) {
    const keys = EXECUTION_MEASUREMENT_KEY_GROUPS[index]!
    const parentValue = readNumber(span.attributes, keys)
    const measurement = descendants.measurements[index]!
    if (parentValue !== undefined) parentMeasurements += 1
    if (measurement.reportingCalls > 0) descendantMeasurements += 1
    if (parentValue === undefined || measurement.reportingCalls === 0) continue
    if (measurement.reportingCalls !== descendants.callCount) continue
    if (Math.abs(parentValue - measurement.total) > 1e-12) return false
  }
  return parentMeasurements === 0 || descendantMeasurements > 0
}

function ancestorIds(
  span: ExecutionMeasurementSpan,
  byId: Map<string, ExecutionMeasurementSpan>,
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  let parentId = span.parentId
  while (parentId && !seen.has(parentId)) {
    ids.push(parentId)
    seen.add(parentId)
    parentId = byId.get(parentId)?.parentId
  }
  return ids
}

function nearestCandidateParent(
  span: ExecutionMeasurementSpan,
  byId: Map<string, ExecutionMeasurementSpan>,
  candidateIds: Set<string>,
): string | undefined {
  const seen = new Set<string>()
  let parentId = span.parentId
  while (parentId && !seen.has(parentId)) {
    if (candidateIds.has(parentId)) return parentId
    seen.add(parentId)
    parentId = byId.get(parentId)?.parentId
  }
  return undefined
}

function readNumber(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = attributes[key]
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.length > 0
          ? Number(value)
          : Number.NaN
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return undefined
}
