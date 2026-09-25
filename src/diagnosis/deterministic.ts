/**
 * The deterministic pass: everything the engine can say without a model.
 *
 * It produces the capability table (the trace contract's own validator, so the
 * reasons are the trace's reasons), execution facts with token and cost
 * accounting (agent-eval's `fromOtelSpans` + `summarizeExecution`), and
 * `observed` findings computed directly from span data. Every observed finding
 * carries a measure with its denominator and cites the spans it counted.
 */

import { createHash } from 'node:crypto'
import { type TraceValidation, validateTraceSpans } from '@tangle-network/agent-trace-contract'
import { type ExecutionReport, summarizeExecution } from '../contract/analyze-runs'
import { fromOtelSpans } from '../contract/intake/otel-spans'
import type { TraceSpanEvent } from '../hosted/types'
import type {
  DiagnosisCapability,
  DiagnosisFinding,
  DiagnosisSeverity,
  DiagnosisSkippedAnalysis,
} from './findings'
import { type FirstFailure, rankFirstFailure } from './first-failure'
import { type DiagnosisSpan, durationMs, toContractSpan } from './spans'

/** Evidence ids cited per finding; the measure carries the full count. */
export const MAX_EVIDENCE_PER_FINDING = 8
/**
 * Identical tool calls with no different tool call between them that count as
 * a repeated-call run. Model turns between the calls do not break the run: an
 * agent that calls, reads, and calls again with the same input is the waste
 * this detects.
 */
export const REPEAT_RUN_LENGTH = 3
/** A tool is reported only once it has at least this many calls. */
export const MIN_TOOL_CALLS = 3

/** The analysis each capability gates, as the report names it. */
const CAPABILITY_ANALYSES: Record<string, string> = {
  'token-accounting': 'token accounting',
  'cost-attribution': 'cost attribution',
  'tool-usage': 'tool failure rates and repeated-call detection',
  'loop-convergence': 'loop convergence (did round N+1 improve on round N)',
  'tree-comparison': 'arm-vs-arm comparison across branches of one run',
  'steering-chain': 'steering chain (which verdict caused which retry)',
  'latency-analysis': 'latency distribution',
}

/** Capabilities the engine reports but does not analyze, with where to go instead. */
const NOT_BUILT = new Map([
  ['loop-convergence', 'the engine has no round-over-round convergence analysis yet'],
  [
    'tree-comparison',
    'the engine does not pick which arms to compare; diff two arms with diffSteps from /pipelines ' +
      '(traces diff <file>#branch=<a> <file>#branch=<b>)',
  ],
  ['steering-chain', 'the engine has no steering-chain analysis yet'],
])

export interface ExecutionFacts {
  runs: number
  spans: number
  spansByKind: Record<string, number>
  errorSpans: number
  toolCalls: number
  models: string[]
  /** The first failure of each run, in trace id order. See `rankFirstFailure`. */
  firstFailures: FirstFailure[]
  /** agent-eval execution summary; null with a reason when it could not be computed. */
  execution: ExecutionReport | null
  executionError?: string
}

export interface DeterministicResult {
  validation: TraceValidation
  capabilities: Record<string, DiagnosisCapability>
  skipped: DiagnosisSkippedAnalysis[]
  facts: ExecutionFacts
  findings: DiagnosisFinding[]
  window: string
}

export function runDeterministicPass(spans: readonly DiagnosisSpan[]): DeterministicResult {
  const validation = validateTraceSpans(spans.map(toContractSpan))
  const capabilities: Record<string, DiagnosisCapability> = {}
  const skipped: DiagnosisSkippedAnalysis[] = []
  for (const capability of validation.capabilities) {
    capabilities[capability.name] = capability.available
      ? { available: true }
      : {
          available: false,
          reason: capability.reason ?? 'the trace contract validator gave no reason',
        }
    const analysis = CAPABILITY_ANALYSES[capability.name] ?? capability.name
    if (!capability.available) {
      skipped.push({ analysis, reason: capability.reason ?? 'capability unavailable' })
    } else if (NOT_BUILT.has(capability.name)) {
      skipped.push({ analysis, reason: NOT_BUILT.get(capability.name)! })
    }
  }

  const traces = groupByTrace(spans)
  const findings: DiagnosisFinding[] = []
  const tools = spans.filter((span) => span.kind === 'TOOL')
  if (tools.length > 0) {
    findings.push(...toolFailureFindings(tools))
    const withDigest = tools.filter((span) => span.inputDigest !== null).length
    if (withDigest > 0) findings.push(...repeatedCallFindings(traces))
    else
      skipped.push({
        analysis: 'repeated identical tool calls',
        reason: `none of ${tools.length} tool spans carries its input, so identical calls cannot be told apart`,
      })
  } else {
    skipped.push({ analysis: 'tool failure rates', reason: 'no span resolves to kind TOOL' })
  }
  findings.push(...failedRunFindings(traces))

  const facts = executionFacts(spans, traces)
  return { validation, capabilities, skipped, facts, findings, window: timeWindow(spans) }
}

export function groupByTrace(spans: readonly DiagnosisSpan[]): Map<string, DiagnosisSpan[]> {
  const traces = new Map<string, DiagnosisSpan[]>()
  for (const span of spans) {
    const list = traces.get(span.traceId)
    if (list) list.push(span)
    else traces.set(span.traceId, [span])
  }
  for (const list of traces.values()) list.sort(byStart)
  return traces
}

function toolFailureFindings(tools: readonly DiagnosisSpan[]): DiagnosisFinding[] {
  const byTool = new Map<string, DiagnosisSpan[]>()
  for (const span of tools) {
    const name = span.toolName ?? span.name
    const list = byTool.get(name)
    if (list) list.push(span)
    else byTool.set(name, [span])
  }
  const findings: DiagnosisFinding[] = []
  for (const [tool, calls] of byTool) {
    const failed = calls.filter((span) => span.status === 'ERROR')
    if (calls.length < MIN_TOOL_CALLS || failed.length < 2) continue
    const rate = failed.length / calls.length
    const severity: DiagnosisSeverity =
      rate >= 0.5 && failed.length >= 5 ? 'high' : rate >= 0.2 ? 'medium' : 'low'
    findings.push({
      id: stableId('tool-failures', tool),
      severity,
      claim: `${failed.length} of ${calls.length} calls to the ${tool} tool failed.`,
      consequence: `Each failed call spends a model turn noticing the error and retrying, so ${pct(rate)} of this tool's calls bought no progress.`,
      measure: {
        name: `${tool} tool failure rate`,
        value: round(rate * 100),
        unit: '%',
        denominator: `${calls.length} calls to ${tool}`,
      },
      evidence: failed.slice(0, MAX_EVIDENCE_PER_FINDING).map((span) => span.spanId),
      confidence: 'observed',
      recommendation: `Read the failed ${tool} calls' status messages and fix the most common cause, or give the agent the precondition it keeps missing.`,
    })
  }
  return findings.sort((a, b) => (b.measure?.value ?? 0) - (a.measure?.value ?? 0)).slice(0, 10)
}

function repeatedCallFindings(traces: ReadonlyMap<string, DiagnosisSpan[]>): DiagnosisFinding[] {
  const runs: DiagnosisSpan[][] = []
  let digestCalls = 0
  for (const spans of traces.values()) {
    let current: DiagnosisSpan[] = []
    for (const span of spans) {
      if (span.kind !== 'TOOL' || span.inputDigest === null) continue
      digestCalls += 1
      const last = current[current.length - 1]
      if (
        last &&
        last.inputDigest === span.inputDigest &&
        (last.toolName ?? last.name) === (span.toolName ?? span.name)
      ) {
        current.push(span)
      } else {
        if (current.length >= REPEAT_RUN_LENGTH) runs.push(current)
        current = [span]
      }
    }
    if (current.length >= REPEAT_RUN_LENGTH) runs.push(current)
  }
  if (runs.length === 0) return []
  const wasted = runs.reduce((sum, run) => sum + run.length - 1, 0)
  const tracesAffected = new Set(runs.map((run) => run[0]!.traceId)).size
  runs.sort((a, b) => b.length - a.length)
  const evidence = runs
    .flatMap((run) => run.slice(0, 2).map((span) => span.spanId))
    .slice(0, MAX_EVIDENCE_PER_FINDING)
  const rate = wasted / digestCalls
  return [
    {
      id: stableId('repeated-calls', String(runs.length)),
      severity: rate >= 0.1 ? 'high' : rate >= 0.03 ? 'medium' : 'low',
      claim: `The agent made the same tool call with the same input ${REPEAT_RUN_LENGTH} or more times with no other tool call in between, ${runs.length} times across ${tracesAffected} runs; the longest streak was ${runs[0]!.length} calls.`,
      consequence: `${wasted} calls repeated the previous tool call with the same input, which is work the agent paid for twice without new information.`,
      measure: {
        name: 'repeated identical tool calls',
        value: wasted,
        unit: 'calls',
        denominator: `${digestCalls} tool calls with recorded input`,
      },
      evidence,
      confidence: 'observed',
      recommendation:
        'Detect a repeated identical call in the harness and stop or change strategy after the second attempt.',
    },
  ]
}

function failedRunFindings(traces: ReadonlyMap<string, DiagnosisSpan[]>): DiagnosisFinding[] {
  const failedRoots: DiagnosisSpan[] = []
  for (const spans of traces.values()) {
    const ids = new Set(spans.map((span) => span.spanId))
    const root = spans.find((span) => span.parentSpanId === null || !ids.has(span.parentSpanId))
    if (root?.status === 'ERROR') failedRoots.push(root)
  }
  if (failedRoots.length === 0) return []
  const rate = failedRoots.length / traces.size
  return [
    {
      id: stableId('failed-runs', String(traces.size)),
      severity: rate >= 0.25 ? 'critical' : rate >= 0.1 ? 'high' : 'medium',
      claim: `${failedRoots.length} of ${traces.size} runs ended with an error on their root span.`,
      consequence:
        'A run that ends in an error delivered nothing its caller can use, and any tokens it spent are lost.',
      measure: {
        name: 'failed runs',
        value: round(rate * 100),
        unit: '%',
        denominator: `${traces.size} runs`,
      },
      evidence: failedRoots.slice(0, MAX_EVIDENCE_PER_FINDING).map((span) => span.spanId),
      confidence: 'observed',
      recommendation:
        'Group the failed runs by their root status message and fix the largest group first.',
    },
  ]
}

function executionFacts(
  spans: readonly DiagnosisSpan[],
  traces: ReadonlyMap<string, DiagnosisSpan[]>,
): ExecutionFacts {
  const spansByKind: Record<string, number> = {}
  const models = new Set<string>()
  let errorSpans = 0
  let toolCalls = 0
  for (const span of spans) {
    spansByKind[span.kind] = (spansByKind[span.kind] ?? 0) + 1
    if (span.status === 'ERROR') errorSpans += 1
    if (span.kind === 'TOOL') toolCalls += 1
    if (span.model) models.add(span.model)
  }
  const facts: ExecutionFacts = {
    runs: traces.size,
    spans: spans.length,
    spansByKind,
    errorSpans,
    toolCalls,
    models: [...models].sort(),
    firstFailures: [...traces.keys()]
      .sort()
      .map((traceId) => rankFirstFailure(traces.get(traceId)!)),
    execution: null,
  }
  try {
    facts.execution = summarizeExecution({
      runs: fromOtelSpans({ spans: spans.map(toTraceSpanEvent) }),
    })
  } catch (error) {
    facts.executionError = error instanceof Error ? error.message : String(error)
  }
  return facts
}

function toTraceSpanEvent(span: DiagnosisSpan): TraceSpanEvent {
  const attributes: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === 'string' || typeof value === 'boolean') attributes[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) attributes[key] = value
  }
  if (span.kind !== 'UNKNOWN' && attributes['openinference.span.kind'] === undefined) {
    attributes['openinference.span.kind'] = span.kind
  }
  const start = span.startMs ?? 0
  const end = span.endMs ?? start
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    startTimeUnixNano: `${BigInt(Math.trunc(start)) * 1_000_000n}`,
    endTimeUnixNano: `${BigInt(Math.trunc(end)) * 1_000_000n}`,
    attributes,
    status: { code: span.status, ...(span.statusMessage ? { message: span.statusMessage } : {}) },
  }
}

function timeWindow(spans: readonly DiagnosisSpan[]): string {
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  for (const span of spans) {
    if (span.startMs !== null) first = Math.min(first, span.startMs)
    const end = span.endMs ?? span.startMs
    if (end !== null) last = Math.max(last, end)
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 'unknown'
  return `${new Date(first).toISOString()}/${new Date(last).toISOString()}`
}

function byStart(a: DiagnosisSpan, b: DiagnosisSpan): number {
  return (a.startMs ?? 0) - (b.startMs ?? 0) || (durationMs(b) ?? 0) - (durationMs(a) ?? 0)
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 12)}`
}

function pct(rate: number): string {
  return `${round(rate * 100)}%`
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
