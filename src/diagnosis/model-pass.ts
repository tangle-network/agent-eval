/**
 * The model pass: one prime-protocol exchange per selected run.
 *
 * The run's filtered spans are inlined into the prompt (prime has no trace
 * tools), the reply is one fenced JSON block of short rows, and each row that
 * claims a defect must cite span ids from that run. A row citing an id the run
 * does not hold, or an id that several runs share, is rejected with the reason
 * recorded, never repaired by guessing. Every accepted finding is `inferred`:
 * it is the model's reading, and the report keeps it apart from what the
 * deterministic pass observed.
 */

import type { PrimeBridgeTransport } from '../analyst/prime-bridge-transport'
import {
  buildPrimePrompt,
  type PrimeRawUsage,
  type PrimeReplyContract,
  primeProtocolSha256,
  runPrimeExchange,
} from '../analyst/prime-protocol'
import { stableId } from './deterministic'
import type { DiagnosisFinding, DiagnosisSeverity } from './findings'
import { type DiagnosisSpan, durationMs } from './spans'

export interface DiagnosisModelOptions {
  /** One POST-shaped call to an OpenAI-compatible chat endpoint, or an equivalent local runner. */
  transport: PrimeBridgeTransport
  /** Endpoint the transport receives, e.g. `http://127.0.0.1:4181/v1/chat/completions`. */
  url: string
  /** Model id as the endpoint names it, e.g. `deepseek/deepseek-v4.1-flash`. */
  model: string
  /** Runs read by the model per diagnosis. Default 6. */
  maxTraces?: number
  /** Deadline for one exchange turn. Default 10 minutes. */
  timeoutMs?: number
  /** Inline budget for one rendered run. Default 400,000 characters. */
  maxInlineChars?: number
  /** Per-attribute character cap for the rendering. Default 600. */
  attributeChars?: number
  /** Segments of one long run the model reads, most errors first. Default 3. */
  maxSegmentsPerRun?: number
  /** Exact token rates; without them cost stays uncaptured. */
  pricing?: { inputUsdPerMillion: number; outputUsdPerMillion: number }
}

export interface ModelRowNote {
  kind: 'operator' | 'topology'
  text: string
  evidence: string[]
  traceId?: string
  project?: string
}

export interface ModelQuestion {
  question: string
  project?: string
  traceId?: string
}

export interface ModelRejection {
  traceId?: string
  reason: string
}

export interface ModelRunRecord {
  traceId: string
  ok: boolean
  failure?: string
  delivery?: { segment: number; segments: number; renderedChars: number }
  usage: PrimeRawUsage
  rows: number
}

export interface ModelPassResult {
  findings: DiagnosisFinding[]
  questions: ModelQuestion[]
  notes: ModelRowNote[]
  summaries: Array<{ traceId: string; answer: string }>
  rejected: ModelRejection[]
  /** Runs the model read only in part, with which segments it read. */
  uncovered: ModelRejection[]
  runs: ModelRunRecord[]
  promptSha256: string
}

export interface ModelPassInput {
  subject: 'internal' | 'customer'
  focus?: string
  projects?: readonly string[]
  contentIncluded: boolean
}

interface RawRow {
  kind: 'finding' | 'question' | 'operator' | 'topology'
  severity?: DiagnosisSeverity
  claim?: string
  consequence?: string
  recommendation?: string
  question?: string
  project?: string
  evidence: string[]
}

const MAX_ROWS = 12
const MAX_STRING = 400
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])

export function modelQuestion(input: ModelPassInput): string {
  const focus = input.focus ? ` The owner's question: ${input.focus}` : ''
  const projects =
    input.projects && input.projects.length > 0
      ? ` The runs belong to these projects: ${input.projects.join(', ')}; set "project" on a row to one of these names when the run shows which one it concerns.`
      : ''
  const withheld = input.contentIncluded
    ? ''
    : " Prompt, response and tool payload content was withheld at the owner's choice; do not report its absence as a defect, and reason from span names, kinds, order, timing, status and the remaining attributes."
  return input.subject === 'internal'
    ? `Diagnose this coding-agent session from our own fleet: find concrete agent failures, wasted work, unsupported claims of success, and where the human operator's instructions caused trouble.${withheld}${projects}${focus}`
    : `Diagnose this agent run: find concrete failures, wasted work, and unsupported claims of success that cost the owner money, time, or correct results.${withheld}${projects}${focus}`
}

export function modelContractLines(subject: 'internal' | 'customer'): string[] {
  const kinds =
    subject === 'internal' ? '"finding" | "question" | "operator"' : '"finding" | "question"'
  return [
    'Reply with ONE fenced ```json block and nothing after it. The object has exactly two fields:',
    '  "answer": one paragraph (at most 400 characters) summarising what went wrong in this run, or that nothing did.',
    `  "rows": an array of at most ${MAX_ROWS} objects, each with "kind": ${kinds}.`,
    'A "finding" row: {"kind":"finding","severity":"critical|high|medium|low","claim":"one sentence stating the defect","consequence":"what it cost in money, time, failed work or escalations","recommendation":"the fix","evidence":["<span_id>", ...]}.',
    'A "question" row: {"kind":"question","question":"a concrete question the owner should answer","evidence":[]}.',
    ...(subject === 'internal'
      ? [
          'An "operator" row: {"kind":"operator","claim":"one sentence critiquing how the human operator instructed or steered the agent","evidence":["<span_id>", ...]}.',
        ]
      : []),
    'Add "project": "<repo or project name>" to any row when the run shows which project it belongs to.',
    'Every "finding" and "operator" row cites 1-8 span ids copied VERBATIM from the "id" fields of the trajectory. Rows citing ids that are not in the trajectory are discarded.',
    'Keep every string under 400 characters. Report only what the trajectory shows; an empty rows array is a valid answer.',
  ]
}

export async function runModelPass(
  traces: ReadonlyArray<{ traceId: string; spans: readonly DiagnosisSpan[] }>,
  ambiguousSpanIds: ReadonlySet<string>,
  input: ModelPassInput,
  options: DiagnosisModelOptions,
  signal?: AbortSignal,
): Promise<ModelPassResult> {
  const question = modelQuestion(input)
  const contractLines = modelContractLines(input.subject)
  const promptSha256 = primeProtocolSha256({
    question,
    contractLines,
    repairContractLines: contractLines,
    limits: { maxRows: MAX_ROWS, maxString: MAX_STRING },
  })
  const result: ModelPassResult = {
    findings: [],
    questions: [],
    notes: [],
    summaries: [],
    rejected: [],
    uncovered: [],
    runs: [],
    promptSha256,
  }
  const maxInlineChars = options.maxInlineChars ?? 400_000
  const attributeChars = options.attributeChars ?? 600

  const maxSegments = options.maxSegmentsPerRun ?? 3
  for (const { traceId, spans } of traces) {
    const segments = segmentRun(spans, attributeChars, input.contentIncluded, maxInlineChars)
    const chosen = segments
      .map((segment, index) => ({ ...segment, index }))
      .sort((a, b) => b.errors - a.errors || a.index - b.index)
      .slice(0, maxSegments)
      .sort((a, b) => a.index - b.index)
    if (segments.length > chosen.length) {
      result.uncovered.push({
        traceId,
        reason: `the run renders to ${segments.length} segments of at most ${maxInlineChars} characters; the model read the ${chosen.length} with the most errors (${chosen.map((segment) => segment.index + 1).join(', ')})`,
      })
    }
    for (const segment of chosen) {
      const label =
        segments.length > 1 ? `${traceId} segment ${segment.index + 1}/${segments.length}` : traceId
      const ids = new Set(segment.spans.map((span) => span.spanId))
      const outcome = await runPrimeExchange({
        contract: {
          rowsField: 'rows',
          contractLines,
          repairContractLines: contractLines,
          maxRows: MAX_ROWS,
          decodeRow: (row) => decodeRow(row, input.subject),
        } satisfies PrimeReplyContract<RawRow>,
        prompt: buildPrimePrompt({
          question,
          contractLines,
          trajectoryHeader: `TRAJECTORY (run ${label}; ${segment.spans.length} of the run's ${spans.length} spans, in start order; secrets redacted as [REDACTED:<kind>]):`,
          renderedTrajectory: segment.rendered,
        }),
        transport: options.transport,
        url: options.url,
        model: options.model,
        timeoutMs: options.timeoutMs ?? 600_000,
        repair: true,
        ...(signal ? { signal } : {}),
      })
      const delivery = {
        segment: segment.index + 1,
        segments: segments.length,
        renderedChars: segment.rendered.length,
      }
      if (!outcome.ok) {
        result.runs.push({
          traceId,
          ok: false,
          failure: `${label}: ${outcome.failure.kind}: ${outcome.failure.message}`,
          delivery,
          usage: outcome.usage,
          rows: 0,
        })
        continue
      }
      for (const rejection of outcome.rejected) {
        result.rejected.push({ traceId, reason: `row ${rejection.index}: ${rejection.reason}` })
      }
      if (outcome.overflow > 0) {
        result.rejected.push({
          traceId,
          reason: `${outcome.overflow} valid rows beyond the ${MAX_ROWS}-row cap were dropped`,
        })
      }
      if (outcome.answer)
        result.summaries.push({ traceId, answer: outcome.answer.slice(0, MAX_STRING) })
      acceptRows(result, outcome.rows, traceId, ids, ambiguousSpanIds)
      result.runs.push({
        traceId,
        ok: true,
        delivery,
        usage: outcome.usage,
        rows: outcome.rows.length,
      })
    }
  }
  return result
}

/** The topology reading: one exchange over the caller's run-graph summary, internal runs only. */
export async function runTopologyPass(
  topology: unknown,
  runIds: ReadonlySet<string>,
  options: DiagnosisModelOptions,
  signal?: AbortSignal,
): Promise<{
  notes: ModelRowNote[]
  questions: ModelQuestion[]
  rejected: ModelRejection[]
  run: ModelRunRecord
}> {
  const contractLines = [
    'Reply with ONE fenced ```json block and nothing after it. The object has exactly two fields:',
    '  "answer": one paragraph (at most 400 characters) on how the agent fleet was organised today.',
    `  "rows": at most ${MAX_ROWS} objects, each either {"kind":"topology","claim":"one sentence on a spawn, messaging, hand-off or resume pattern that helped or hurt","evidence":["<run id>", ...],"project":"<optional>"} or {"kind":"question","question":"...","project":"<optional>","evidence":[]}.`,
    'Every "topology" row cites 1-8 run ids copied VERBATIM from the graph. Keep every string under 400 characters.',
  ]
  const rendered = JSON.stringify(topology)
  const outcome = await runPrimeExchange({
    contract: {
      rowsField: 'rows',
      contractLines,
      repairContractLines: contractLines,
      maxRows: MAX_ROWS,
      decodeRow: (row) => decodeRow(row, 'topology'),
    },
    prompt: buildPrimePrompt({
      question:
        "Analyse the topology of this agent fleet's runs: who spawned whom, who messaged whom, hand-offs and resumes. Name patterns that wasted work or lost context, and what to change.",
      contractLines,
      trajectoryHeader: `RUN GRAPH (${runIds.size} runs):`,
      renderedTrajectory:
        rendered.length > (options.maxInlineChars ?? 400_000)
          ? rendered.slice(0, options.maxInlineChars ?? 400_000)
          : rendered,
    }),
    transport: options.transport,
    url: options.url,
    model: options.model,
    timeoutMs: options.timeoutMs ?? 600_000,
    repair: true,
    ...(signal ? { signal } : {}),
  })
  const notes: ModelRowNote[] = []
  const questions: ModelQuestion[] = []
  const rejected: ModelRejection[] = []
  if (outcome.ok && outcome.overflow > 0) {
    rejected.push({
      reason: `${outcome.overflow} valid topology rows beyond the ${MAX_ROWS}-row cap were dropped`,
    })
  }
  if (!outcome.ok) {
    return {
      notes,
      questions,
      rejected,
      run: {
        traceId: 'topology',
        ok: false,
        failure: `${outcome.failure.kind}: ${outcome.failure.message}`,
        usage: outcome.usage,
        rows: 0,
      },
    }
  }
  for (const row of outcome.rows) {
    if (row.kind === 'question') {
      questions.push({ question: row.question!, ...(row.project ? { project: row.project } : {}) })
      continue
    }
    const cited = row.evidence.filter((id) => runIds.has(id))
    if (cited.length === 0) {
      rejected.push({
        reason: `topology row "${(row.claim ?? '').slice(0, 80)}" cites no run id from the graph`,
      })
      continue
    }
    notes.push({
      kind: 'topology',
      text: row.claim!,
      evidence: cited,
      ...(row.project ? { project: row.project } : {}),
    })
  }
  if (outcome.answer)
    notes.unshift({ kind: 'topology', text: outcome.answer.slice(0, MAX_STRING), evidence: [] })
  return {
    notes,
    questions,
    rejected,
    run: { traceId: 'topology', ok: true, usage: outcome.usage, rows: outcome.rows.length },
  }
}

function acceptRows(
  result: ModelPassResult,
  rows: readonly RawRow[],
  traceId: string,
  ids: ReadonlySet<string>,
  ambiguousSpanIds: ReadonlySet<string>,
): void {
  for (const row of rows) {
    const unresolved = row.evidence.filter((id) => !ids.has(id))
    const ambiguous = row.evidence.filter((id) => ambiguousSpanIds.has(id))
    const cited = row.evidence.filter((id) => ids.has(id) && !ambiguousSpanIds.has(id))
    if (unresolved.length > 0)
      result.rejected.push({
        traceId,
        reason: `${row.kind} row cites ids not in the segment it read: ${unresolved.slice(0, 5).join(', ')}`,
      })
    if (ambiguous.length > 0)
      result.rejected.push({
        traceId,
        reason: `${row.kind} row cites ids shared by several runs: ${ambiguous.slice(0, 5).join(', ')}`,
      })
    if (row.kind === 'question') {
      result.questions.push({
        question: row.question!,
        traceId,
        ...(row.project ? { project: row.project } : {}),
      })
      continue
    }
    // A claim that leaned on an invalid id is not supported by the valid ones
    // left over, so the whole row goes rather than a trimmed version of it.
    if (unresolved.length > 0 || ambiguous.length > 0) {
      result.rejected.push({
        traceId,
        reason: `${row.kind} row "${(row.claim ?? '').slice(0, 80)}" discarded: it cites invalid evidence`,
      })
      continue
    }
    if (cited.length === 0) {
      result.rejected.push({
        traceId,
        reason: `${row.kind} row "${(row.claim ?? '').slice(0, 80)}" has no resolvable evidence`,
      })
      continue
    }
    if (row.kind === 'operator') {
      result.notes.push({
        kind: 'operator',
        text: row.claim!,
        evidence: cited,
        traceId,
        ...(row.project ? { project: row.project } : {}),
      })
      continue
    }
    result.findings.push({
      id: stableId('inferred', traceId, row.claim!),
      severity: row.severity!,
      claim: row.claim!,
      consequence: row.consequence!,
      evidence: cited,
      confidence: 'inferred',
      ...(row.recommendation ? { recommendation: row.recommendation } : {}),
    })
  }
}

interface RunSegment {
  spans: DiagnosisSpan[]
  rendered: string
  errors: number
}

/**
 * Split a run, in start order, into contiguous segments that each render
 * within the inline budget. Inline is prime's only delivery, so a long run is
 * read as whole segments rather than silently truncated; which segments were
 * read and which were not is recorded by the caller.
 */
export function segmentRun(
  spans: readonly DiagnosisSpan[],
  attributeChars: number,
  contentIncluded: boolean,
  maxInlineChars: number,
): RunSegment[] {
  const segments: RunSegment[] = []
  let current: DiagnosisSpan[] = []
  let parts: string[] = []
  let size = 2
  let errors = 0
  const flush = () => {
    if (current.length === 0) return
    segments.push({ spans: current, rendered: `[${parts.join(',')}]`, errors })
    current = []
    parts = []
    size = 2
    errors = 0
  }
  for (const span of spans) {
    let part = JSON.stringify(renderSpan(span, attributeChars, contentIncluded))
    if (part.length + 2 > maxInlineChars)
      part = JSON.stringify(renderSpan(span, 120, contentIncluded))
    if (size + part.length + 1 > maxInlineChars) flush()
    current.push(span)
    parts.push(part)
    size += part.length + 1
    if (span.status === 'ERROR') errors += 1
  }
  flush()
  return segments
}

function decodeRow(
  row: unknown,
  mode: 'internal' | 'customer' | 'topology',
): { ok: true; row: RawRow } | { ok: false; reason: string } {
  if (row === null || typeof row !== 'object' || Array.isArray(row))
    return { ok: false, reason: 'row is not an object' }
  const value = row as Record<string, unknown>
  const kind = value.kind
  const allowed =
    mode === 'internal'
      ? ['finding', 'question', 'operator']
      : mode === 'customer'
        ? ['finding', 'question']
        : ['topology', 'question']
  if (typeof kind !== 'string' || !allowed.includes(kind))
    return { ok: false, reason: `kind ${String(kind)} is not allowed here` }
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, 8)
    : []
  const project = shortString(value.project)
  if (kind === 'question') {
    const question = shortString(value.question)
    if (!question) return { ok: false, reason: 'question row has no question' }
    return { ok: true, row: { kind, question, evidence, ...(project ? { project } : {}) } }
  }
  const claim = shortString(value.claim)
  if (!claim) return { ok: false, reason: `${kind} row has no claim` }
  if (kind !== 'finding')
    return {
      ok: true,
      row: { kind: kind as RawRow['kind'], claim, evidence, ...(project ? { project } : {}) },
    }
  const severity = value.severity
  if (typeof severity !== 'string' || !SEVERITIES.has(severity))
    return { ok: false, reason: `severity ${String(severity)} is invalid` }
  const consequence = shortString(value.consequence)
  if (!consequence) return { ok: false, reason: 'finding row has no consequence' }
  const recommendation = shortString(value.recommendation)
  return {
    ok: true,
    row: {
      kind: 'finding',
      severity: severity as DiagnosisSeverity,
      claim,
      consequence,
      evidence,
      ...(recommendation ? { recommendation } : {}),
      ...(project ? { project } : {}),
    },
  }
}

/** One span as the model reads it: the pivots, then the attributes that remain after filtering. */
function renderSpan(
  span: DiagnosisSpan,
  attributeChars: number,
  contentIncluded: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: span.spanId,
    parent: span.parentSpanId,
    kind: span.kind,
    name: span.name,
  }
  if (span.toolName) out.tool = span.toolName
  if (span.model) out.model = span.model
  if (span.status !== 'UNSET') out.status = span.status
  if (span.statusMessage) out.status_message = clip(span.statusMessage, attributeChars)
  const duration = durationMs(span)
  if (duration !== null) out.ms = duration
  const attrs: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(span.attributes)) {
    if (SKIP_ATTRIBUTES.has(key)) continue
    if (typeof value === 'string') attrs[key] = clip(value, attributeChars)
    else if (typeof value === 'number' || typeof value === 'boolean') attrs[key] = value
    else if (value !== null && value !== undefined)
      attrs[key] = clip(JSON.stringify(value), attributeChars)
  }
  if (Object.keys(attrs).length > 0) out.attrs = attrs
  if (!contentIncluded) out.content = 'withheld'
  return out
}

/** Pivots already rendered above, and resource noise that repeats on every span. */
const SKIP_ATTRIBUTES = new Set([
  'openinference.span.kind',
  'tool.name',
  'gen_ai.tool.name',
  'llm.model_name',
  'gen_ai.request.model',
  'service.name',
  'agent.name',
  'source_file',
  'otel.scope.name',
  'telemetry.sdk.name',
  'telemetry.sdk.language',
  'telemetry.sdk.version',
])

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[+${value.length - max} chars]`
}

function shortString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= MAX_STRING ? trimmed : `${trimmed.slice(0, MAX_STRING)}…`
}
