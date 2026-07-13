/**
 * Deterministic behavioral metrics over OTLP spans — pure arithmetic, no LLM.
 *
 * These are the model-independent multiplier: the four trace-quality signals a
 * tolerant analyzer (e.g. HALO) re-derives per run inside the model — token
 * growth, output decay, tool monoculture, missing self-verification — computed
 * here once, in TypeScript, with zero model judgment. A finding that falls out
 * of arithmetic is trivially model-agnostic and cannot hallucinate the trend.
 *
 * General, not trace-specific: the detectors key off token trajectories and
 * tool usage present in any agentic OTLP trace, not any one benchmark.
 */

import { executionTrackByLane } from '../trace/execution-tracks'
import {
  LLM_INPUT_TOKEN_ATTR_KEYS,
  LLM_OUTPUT_TOKEN_ATTR_KEYS,
  TOOL_NAME_ATTR_KEYS,
} from '../trace/otlp-attributes'
import { spanEpochMillis } from './otlp-span'
import type { TraceAnalystSpan } from './types'

export type SuboptimalCode =
  | 'monotonic-input-growth'
  | 'output-length-decay'
  | 'single-tool-dependency'
  | 'no-self-verification'

export interface SuboptimalSignal {
  code: SuboptimalCode
  severity: 'high' | 'medium' | 'low'
  /** Human-readable claim, with the backing numbers inlined. */
  detail: string
  /** The exact figures the detector fired on — auditable, no model in the loop. */
  evidence: Record<string, number | string | boolean>
}

export interface BehavioralMetrics {
  /** The only trace represented by these metrics; null when spans are empty. */
  traceId: string | null
  llmCallCount: number
  /** Causally serial LLM timelines. Parallel branches are never joined. */
  tokenSequences: BehavioralTokenSequence[]
  /** Token values from the longest serial timeline, retained for convenience. */
  inputTokenTrajectory: number[]
  outputTokenTrajectory: number[]
  toolHistogram: Record<string, number>
  totalToolCalls: number
  distinctTools: number
  /** distinct/total tool calls; 1.0 when there are no tool calls. */
  toolDiversityRatio: number
  hasSelfVerification: boolean
  signals: SuboptimalSignal[]
}

export interface BehavioralTokenSequence {
  scopeId: string
  spanIds: string[]
  inputTokenTrajectory: Array<number | null>
  outputTokenTrajectory: Array<number | null>
}

interface TokenSample {
  span: TraceAnalystSpan
  input: number | null
  output: number | null
  step: number | null
}

/** ≥ this input-token growth ratio across a run, with no compression, fires. */
const INPUT_GROWTH_FACTOR = 3
/** Tool-usage signals need at least this many calls to be meaningful. */
const MIN_TOOL_CALLS = 3
/** Tool names that read or check state count as self-verification, not mutation.
 *  Covers the inspect verbs plus the read/search tools real harnesses use to
 *  verify (Claude Code Read/Grep/Glob, codex read_file/ls/cat, git status/diff,
 *  test/lint). A pure shell tool (Bash/exec_command) is intentionally NOT matched
 *  — its name can't tell a `pytest` from an `rm`. */
const VERIFY_RE =
  /verif|eval|inspect|check|assert|validat|review|confirm|read|grep|glob|search|view|\blist\b|\bls\b|\bcat\b|\bfind\b|diff|status|\btest|lint|typecheck/i

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function numAttr(attrs: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = num(attrs[key])
    if (value !== null) return value
  }
  return null
}
function inputTokensOf(s: TraceAnalystSpan): number | null {
  return (
    numAttr(s.attributes, LLM_INPUT_TOKEN_ATTR_KEYS) ?? num(s.attributes['llm.usage.input_tokens'])
  )
}
function outputTokensOf(s: TraceAnalystSpan): number | null {
  return (
    numAttr(s.attributes, LLM_OUTPUT_TOKEN_ATTR_KEYS) ??
    num(s.attributes['llm.usage.output_tokens'])
  )
}
function stepOf(s: TraceAnalystSpan): number | null {
  return num(s.attributes.step)
}
function toolNameOf(s: TraceAnalystSpan): string | null {
  if (s.tool_name) return s.tool_name
  for (const key of TOOL_NAME_ATTR_KEYS) {
    const t = s.attributes[key]
    if (typeof t === 'string' && t.length > 0) return t
  }
  return null
}

/**
 * Reduce a span list to behavioral metrics + fired suboptimality signals.
 * Pure + deterministic: same spans → same output, on any machine, no model.
 */
export function computeTraceMetrics(spans: readonly TraceAnalystSpan[]): BehavioralMetrics {
  const traceIds = new Set(spans.map((span) => span.trace_id))
  if (traceIds.size > 1) {
    throw new Error(
      `computeTraceMetrics: expected spans from one trace, received ${traceIds.size} traces`,
    )
  }
  const traceId = traceIds.values().next().value ?? null

  const samples: TokenSample[] = spans.map((span) => ({
    span,
    input: inputTokensOf(span),
    output: outputTokensOf(span),
    step: stepOf(span),
  }))
  const llmSamples = samples.filter((sample) => sample.span.kind === 'LLM')
  const tokenSamples =
    llmSamples.length > 0
      ? llmSamples
      : samples.filter((sample) => sample.input !== null || sample.output !== null)
  const tokenSequences = buildTokenSequences(tokenSamples, spans)
  const primarySequence = tokenSequences[0]
  const inputTokenTrajectory =
    primarySequence?.inputTokenTrajectory.filter((value): value is number => value !== null) ?? []
  const outputTokenTrajectory =
    primarySequence?.outputTokenTrajectory.filter((value): value is number => value !== null) ?? []
  const toolHistogram: Record<string, number> = {}
  let hasSelfVerification = false

  for (const s of spans) {
    const tool = toolNameOf(s)
    if (tool) {
      toolHistogram[tool] = (toolHistogram[tool] ?? 0) + 1
      if (VERIFY_RE.test(tool)) hasSelfVerification = true
    }
  }

  const totalToolCalls = Object.values(toolHistogram).reduce((a, b) => a + b, 0)
  const distinctTools = Object.keys(toolHistogram).length
  const toolDiversityRatio = totalToolCalls === 0 ? 1 : distinctTools / totalToolCalls

  const signals: SuboptimalSignal[] = []
  const seenTokenSignals = new Set<SuboptimalCode>()
  for (const sequence of tokenSequences) {
    for (const signal of tokenSignals(sequence)) {
      if (seenTokenSignals.has(signal.code)) continue
      seenTokenSignals.add(signal.code)
      signals.push(signal)
    }
  }

  if (totalToolCalls >= MIN_TOOL_CALLS && distinctTools === 1) {
    const only = Object.keys(toolHistogram)[0]!
    signals.push({
      code: 'single-tool-dependency',
      severity: 'medium',
      detail: `All ${totalToolCalls} observed tool calls are \`${only}\`; no alternate tool call was observed.`,
      evidence: { tool: only, calls: totalToolCalls, distinct_tools: 1 },
    })
  }

  if (totalToolCalls >= MIN_TOOL_CALLS && !hasSelfVerification) {
    signals.push({
      code: 'no-self-verification',
      severity: 'medium',
      detail: `${totalToolCalls} tool calls were observed without a verification-named tool call.`,
      evidence: { tool_calls: totalToolCalls, verification_calls: 0 },
    })
  }

  return {
    traceId,
    llmCallCount: tokenSamples.length,
    tokenSequences,
    inputTokenTrajectory,
    outputTokenTrajectory,
    toolHistogram,
    totalToolCalls,
    distinctTools,
    toolDiversityRatio,
    hasSelfVerification,
    signals,
  }
}

function buildTokenSequences(
  samples: readonly TokenSample[],
  spans: readonly TraceAnalystSpan[],
): BehavioralTokenSequence[] {
  const spansById = new Map(spans.map((span) => [span.span_id, span]))
  const executionScopeFor = createTokenExecutionScopeResolver(spansById)
  const scopedSamples = samples.map((sample) => ({
    sample,
    ...executionScopeFor(sample.span),
  }))
  const trackByLane = executionTrackByLane(scopedSamples)
  const byTrack = new Map<string, { scopeId: string; samples: TokenSample[] }>()
  for (const scoped of scopedSamples) {
    const trackId = trackByLane.get(scoped.key)!
    const track = byTrack.get(trackId) ?? { scopeId: scoped.scopeId, samples: [] }
    track.samples.push(scoped.sample)
    byTrack.set(trackId, track)
  }

  const sequences: BehavioralTokenSequence[] = []
  for (const { scopeId, samples: tracked } of byTrack.values()) {
    const runs = serialTokenRuns([...tracked].sort(compareTokenSamples))
    runs.forEach((run, index) => {
      sequences.push({
        scopeId: runs.length === 1 ? scopeId : `${scopeId}#${index + 1}`,
        spanIds: run.map((sample) => sample.span.span_id),
        inputTokenTrajectory: run.map((sample) => sample.input),
        outputTokenTrajectory: run.map((sample) => sample.output),
      })
    })
  }

  return sequences.sort(
    (a, b) =>
      b.spanIds.length - a.spanIds.length ||
      a.scopeId.localeCompare(b.scopeId) ||
      a.spanIds[0]!.localeCompare(b.spanIds[0]!),
  )
}

interface AncestorScope {
  agentId: string | null
  rootId: string | null
  missingParentId: string | null
  laneSpanId: string | null
}

function createTokenExecutionScopeResolver(spansById: ReadonlyMap<string, TraceAnalystSpan>): (
  span: TraceAnalystSpan,
) => {
  key: string
  scopeKey: string
  scopeId: string
  start: number | null
  end: number | null
} {
  const cache = new Map<string, AncestorScope>()
  return (span) => {
    const ancestry = resolveAncestorScope(span.parent_span_id, spansById, cache)
    const rootId = ancestry.rootId
    const scopeId = ancestry.agentId
      ? `span:${ancestry.agentId}`
      : ancestry.missingParentId
        ? `parent:${ancestry.missingParentId}`
        : rootId
          ? `root:${rootId}`
          : span.agent_name
            ? `agent:${span.agent_name}`
            : `trace:${span.trace_id}`
    const scopeSpanId = ancestry.agentId ?? ancestry.missingParentId ?? rootId
    const laneSpan = ancestry.laneSpanId ? spansById.get(ancestry.laneSpanId) : undefined
    const direct = scopeSpanId === null || ancestry.laneSpanId === scopeSpanId
    const timedSpan = direct ? span : laneSpan
    return {
      key: JSON.stringify([scopeId, direct ? span.span_id : ancestry.laneSpanId]),
      scopeKey: scopeId,
      scopeId,
      start: timedSpan ? spanEpochMillis(timedSpan.start_time) : null,
      end: timedSpan ? spanEpochMillis(timedSpan.end_time) : null,
    }
  }
}

function resolveAncestorScope(
  startId: string | null,
  spansById: ReadonlyMap<string, TraceAnalystSpan>,
  cache: Map<string, AncestorScope>,
): AncestorScope {
  const empty: AncestorScope = {
    agentId: null,
    rootId: null,
    missingParentId: null,
    laneSpanId: null,
  }
  if (!startId) return empty

  const path: string[] = []
  const pathIndex = new Map<string, number>()
  let currentId: string | null = startId
  let resolved = empty
  while (currentId) {
    const cached = cache.get(currentId)
    if (cached) {
      resolved = cached
      break
    }
    const cycleStart = pathIndex.get(currentId)
    if (cycleStart !== undefined) {
      resolved = {
        agentId: null,
        rootId: [...path.slice(cycleStart)].sort()[0]!,
        missingParentId: null,
        laneSpanId: [...path.slice(cycleStart)].sort()[0]!,
      }
      break
    }
    const current = spansById.get(currentId)
    if (!current) {
      resolved = {
        agentId: null,
        rootId: null,
        missingParentId: currentId,
        laneSpanId: currentId,
      }
      break
    }
    if (current.kind === 'AGENT') {
      resolved = {
        agentId: current.span_id,
        rootId: null,
        missingParentId: null,
        laneSpanId: current.span_id,
      }
      break
    }
    pathIndex.set(currentId, path.length)
    path.push(currentId)
    currentId = current.parent_span_id
  }

  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (resolved.agentId === null && resolved.rootId === null) {
      resolved = { ...resolved, rootId: path[index]!, laneSpanId: path[index]! }
    } else if (
      resolved.laneSpanId === (resolved.agentId ?? resolved.missingParentId ?? resolved.rootId)
    ) {
      resolved = { ...resolved, laneSpanId: path[index]! }
    }
    cache.set(path[index]!, resolved)
  }
  return resolved
}

function compareTokenSamples(a: TokenSample, b: TokenSample): number {
  const aStart = spanEpochMillis(a.span.start_time)
  const bStart = spanEpochMillis(b.span.start_time)
  if (aStart === null && bStart !== null) return 1
  if (aStart !== null && bStart === null) return -1
  if (aStart !== null && bStart !== null && aStart !== bStart) return aStart - bStart
  if (a.step !== null && b.step !== null && a.step !== b.step) return a.step - b.step
  return a.span.span_id.localeCompare(b.span.span_id)
}

function serialTokenRuns(ordered: readonly TokenSample[]): TokenSample[][] {
  const runs: TokenSample[][] = []
  let serial: TokenSample[] = []
  let overlap: TokenSample[] = []
  let overlapEnd = Number.NEGATIVE_INFINITY

  const flushSerial = () => {
    if (serial.length > 0) runs.push(serial)
    serial = []
  }
  const flushOverlap = () => {
    if (overlap.length === 1) {
      serial.push(overlap[0]!)
    } else if (overlap.length > 1) {
      flushSerial()
      for (const sample of overlap) runs.push([sample])
    }
    overlap = []
    overlapEnd = Number.NEGATIVE_INFINITY
  }

  for (const sample of ordered) {
    const start = spanEpochMillis(sample.span.start_time)
    const end = spanEpochMillis(sample.span.end_time)
    if (start === null || end === null || sample.span.duration_ms <= 0 || end < start) {
      flushOverlap()
      flushSerial()
      runs.push([sample])
      continue
    }
    if (overlap.length > 0 && start >= overlapEnd) flushOverlap()
    overlap.push(sample)
    overlapEnd = Math.max(overlapEnd, end)
  }
  flushOverlap()
  flushSerial()
  return runs
}

function tokenSignals(sequence: BehavioralTokenSequence): SuboptimalSignal[] {
  const signals: SuboptimalSignal[] = []
  const inputs = sequence.inputTokenTrajectory
  const outputs = sequence.outputTokenTrajectory
  if (inputs.length >= 3 && inputs.every((value): value is number => value !== null)) {
    const first = inputs[0]!
    const last = inputs[inputs.length - 1]!
    const isMonotonic = everyAdjacent(inputs, (previous, current) => current >= previous)
    const growthFromZero = first === 0 && last > 0
    const growth = growthFromZero ? Infinity : first > 0 ? last / first : 0
    if (isMonotonic && last > first && growth >= INPUT_GROWTH_FACTOR) {
      const growthLabel = growthFromZero ? '0→nonzero (unbounded)' : `${growth.toFixed(1)}x`
      signals.push({
        code: 'monotonic-input-growth',
        severity: 'high',
        detail: `LLM input tokens grew ${growthLabel} (${first}→${last}) across ${inputs.length} serial calls without an intervening decrease.`,
        evidence: {
          first,
          last,
          growth_x: growthFromZero ? 'unbounded' : Number(growth.toFixed(2)),
          calls: inputs.length,
          scope: sequence.scopeId,
          first_span_id: sequence.spanIds[0]!,
          last_span_id: sequence.spanIds[sequence.spanIds.length - 1]!,
        },
      })
    }
  }

  if (
    inputs.length >= 3 &&
    inputs.length === outputs.length &&
    inputs.every((value): value is number => value !== null) &&
    outputs.every((value): value is number => value !== null)
  ) {
    const first = outputs[0]!
    const last = outputs[outputs.length - 1]!
    const inputIsMonotonic = everyAdjacent(inputs, (previous, current) => current >= previous)
    const outputIsMonotonic = everyAdjacent(outputs, (previous, current) => current <= previous)
    const inputGrew = inputs[inputs.length - 1]! > inputs[0]!
    if (inputIsMonotonic && inputGrew && outputIsMonotonic && last < first) {
      signals.push({
        code: 'output-length-decay',
        severity: 'medium',
        detail: `LLM output tokens shrank ${first}→${last} over ${outputs.length} serial calls while input tokens increased monotonically.`,
        evidence: {
          first,
          last,
          calls: outputs.length,
          scope: sequence.scopeId,
          first_span_id: sequence.spanIds[0]!,
          last_span_id: sequence.spanIds[sequence.spanIds.length - 1]!,
        },
      })
    }
  }
  return signals
}

function everyAdjacent(
  values: readonly number[],
  predicate: (previous: number, current: number) => boolean,
): boolean {
  return values.slice(1).every((current, index) => predicate(values[index]!, current))
}
