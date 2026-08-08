import { request } from 'node:http'
import type { CustomTokenPricing } from '../cost-ledger'
import { resolveModelPricing } from '../metrics'
import type { TraceAnalysisStore, TraceAnalysisStoreContext } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import type { AnalystBenchmarkRunner } from './benchmark'
import {
  type CodeTraceFailureBlock,
  expandCodeTraceFailureBlocks,
} from './benchmark-public-adapters'
import { publicBenchmarkError } from './benchmark-public-errors'
import {
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  MAX_INCORRECT_BLOCK_STEPS,
  MAX_INCORRECT_BLOCKS,
} from './benchmark-public-prompt'
import { positiveSafeInteger, requiredString } from './benchmark-public-types'
import { sha256Digest } from './benchmark-verification-artifacts'
import type { AnalystRunInputs, AnalystSeverity, AnalystUsageReceipt } from './types'

/**
 * Prime analyst arm: the RLM coding agent reached through an OpenAI-compatible
 * cli-bridge solves the CodeTraceBench incorrect-step task as a one-shot trace
 * analyst.
 *
 * The runner consumes the same prepared benchmark cases every other runner
 * receives — the trace store already carries the appended final-verification
 * spans — and produces findings through the same published block expansion, so
 * a prime observation and a dspy-rlm observation differ only in which analyst
 * produced the blocks.
 *
 * Trajectory delivery is inline JSON in the prompt. The dspy typed path binds
 * the viewTrace span projection as a REPL variable; prime has no REPL, so the
 * same projection is serialized into the prompt. When the full projection is
 * oversized the runner falls back to chunked viewSpans over the same
 * projection surface with a per-attribute byte cap, and fails loud if the
 * result still exceeds the inline budget.
 *
 * A structurally malformed reply gets ONE bounded repair turn (disable with
 * `repair: false`): a second stateless call carrying the malformed reply plus
 * the output contract — never the trajectory — mirroring the dspy arm's typed
 * repair so both arms face the same structured-output affordance. Still
 * malformed after repair = failed observation with a typed error, exactly how
 * a dspy-rlm failure is recorded. Zero valid blocks from a well-formed reply
 * is an honest null, not a failure.
 */

const PRIME_ANALYST_ID = 'prime'
const PRIME_QUESTION = 'Which assistant steps are incorrect under the CodeTraceBench definition?'
/** Ceiling on the serialized trajectory JSON embedded in the prompt. */
const MAX_INLINE_TRAJECTORY_CHARS = 360_000
/** Per-attribute projection cap used by the chunked viewSpans fallback. */
const CHUNKED_PROJECTION_ATTRIBUTE_BYTE_CAP = 1_200
/** Minimal per-attribute cap used only to enumerate span ids in store order. */
const SPAN_ID_ENUMERATION_ATTRIBUTE_BYTE_CAP = 64
/** viewSpans accepts at most 100 ids per call; 40 keeps each response bounded. */
const VIEW_SPANS_CHUNK_SIZE = 40
const PRIME_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low', 'info'])

export interface PrimeBridgeTransportRequest {
  url: string
  body: {
    model: string
    messages: Array<{ role: 'user'; content: string }>
  }
  /** Deadline the runner also enforces through `signal`. */
  timeoutMs: number
  signal?: AbortSignal
}

export interface PrimeBridgeTransportResult {
  status: number
  text: string
}

/** One POST to the bridge's /v1/chat/completions. Injectable for tests. */
export type PrimeBridgeTransport = (
  request: PrimeBridgeTransportRequest,
) => Promise<PrimeBridgeTransportResult>

export interface PrimeBenchmarkRunnerOptions {
  /** OpenAI-compatible cli-bridge base URL, e.g. `http://localhost:4181`. */
  baseUrl: string
  /** Bridge model id in `<backend>/<provider>/<model>` form, e.g. `prime/zai/glm-5.2`. */
  model: string
  /** Deadline for one bridge call. Prime analyses routinely exceed 5 minutes. */
  timeoutMs: number
  /** Whether a structurally malformed reply gets one bounded repair turn. */
  repair: boolean
  /** Exact token rates. Default: the agent-eval catalog rates for `model`. */
  pricing?: CustomTokenPricing
  /** Bridge transport. Default: node:http POST (see nodeHttpPrimeBridgeTransport). */
  transport?: PrimeBridgeTransport
}

export class PrimeBridgeTransportError extends Error {}
export class PrimeBridgeHttpError extends Error {
  readonly status: number
  constructor(status: number, bodySnippet: string) {
    super(`bridge HTTP ${status}: ${bodySnippet}`)
    this.status = status
  }
}
export class PrimeMalformedReplyError extends Error {}
export class PrimeTraceProjectionError extends Error {}

/**
 * Digest of everything this runner can send to the bridge, recorded per
 * observation so a prime result names the exact contract that produced it.
 */
export function primeAnalystProtocolSha256(): string {
  return sha256Digest(
    JSON.stringify({
      kind: 'prime-analyst-protocol',
      question: PRIME_QUESTION,
      taskPrompt: CODE_TRACE_BENCH_ANALYST_PROMPT,
      outputContract: primeOutputContractLines(),
      repairContract: primeRepairPrompt('<defect>', '<previous-reply>'),
      limits: {
        maxBlocks: MAX_INCORRECT_BLOCKS,
        maxBlockSteps: MAX_INCORRECT_BLOCK_STEPS,
        maxInlineTrajectoryChars: MAX_INLINE_TRAJECTORY_CHARS,
        chunkedProjectionAttributeByteCap: CHUNKED_PROJECTION_ATTRIBUTE_BYTE_CAP,
      },
    }),
  )
}

/** CodeTraceBench-only: the prompt and output contract speak its block grammar. */
export function createPrimeBenchmarkRunner(
  options: PrimeBenchmarkRunnerOptions,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const baseUrl = requiredString(options.baseUrl, 'baseUrl').replace(/\/+$/, '')
  const model = requiredString(options.model, 'model')
  const timeoutMs = positiveSafeInteger(options.timeoutMs, 'timeoutMs')
  const repair = options.repair
  if (typeof repair !== 'boolean') throw new TypeError('repair must be a boolean')
  const pricing = options.pricing ?? pricingForModel(model)
  const transport = options.transport ?? nodeHttpPrimeBridgeTransport()
  const url = `${baseUrl}/v1/chat/completions`

  async function bridgeCall(
    content: string,
    signal: AbortSignal | undefined,
  ): Promise<{ content: string; usage: unknown }> {
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) controller.abort(signal.reason)
    else signal?.addEventListener('abort', forwardAbort, { once: true })
    const deadline = setTimeout(() => controller.abort(), timeoutMs)
    let result: PrimeBridgeTransportResult
    try {
      result = await transport({
        url,
        body: { model, messages: [{ role: 'user', content }] },
        timeoutMs,
        signal: controller.signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      if (controller.signal.aborted) {
        throw new PrimeBridgeTransportError(`bridge call exceeded ${timeoutMs}ms`)
      }
      throw new PrimeBridgeTransportError(
        `bridge transport failure: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', forwardAbort)
    }
    if (result.status !== 200) {
      throw new PrimeBridgeHttpError(result.status, result.text.slice(0, 500))
    }
    let response: unknown
    try {
      response = JSON.parse(result.text)
    } catch {
      throw new PrimeBridgeTransportError(
        `bridge returned unparseable JSON (${result.text.length} bytes)`,
      )
    }
    const reply = extractReplyContent(response)
    if (reply === null)
      throw new PrimeBridgeTransportError('bridge reply carries no message content')
    return { content: reply, usage: extractRawUsage(response) }
  }

  return {
    id: PRIME_ANALYST_ID,
    async analyze(input, context) {
      const trajectoryId = trajectoryIdFromCaseId(context.caseId)
      let usage: AnalystUsageReceipt | undefined
      let metadata: Record<string, unknown> = {
        analysisMode: 'prime-rlm',
        engine: 'prime',
        bridgeUrl: baseUrl,
        model,
        protocolSha256: primeAnalystProtocolSha256(),
      }
      try {
        const store = input.traceStore
        if (!store) throw new Error('codetracebench prime runner requires a trace store')
        const projected = await projectInlineTrajectory(store, trajectoryId, context.signal)
        metadata = { ...metadata, delivery: projected.delivery }
        const prompt = buildPrimePrompt(trajectoryId, projected.spans, projected.rendered)
        metadata = { ...metadata, promptChars: prompt.length }

        const first = await bridgeCall(prompt, context.signal)
        usage = usageFromBridgeUsage(first.usage, pricing)
        metadata = { ...metadata, bridgeUsage: { first: first.usage ?? null, repair: null } }
        let reply = first.content
        let parsed = extractJsonObject(reply)
        let defect = replyDefect(parsed)
        const repairState: { attempted: boolean; succeeded: boolean | null } = {
          attempted: false,
          succeeded: null,
        }
        if (defect !== null && repair) {
          repairState.attempted = true
          const second = await bridgeCall(primeRepairPrompt(defect, reply), context.signal)
          usage = mergePrimeUsage(usage, usageFromBridgeUsage(second.usage, pricing), pricing)
          metadata = {
            ...metadata,
            bridgeUsage: { first: first.usage ?? null, repair: second.usage ?? null },
          }
          reply = second.content
          parsed = extractJsonObject(reply)
          defect = replyDefect(parsed)
          repairState.succeeded = defect === null
        }
        metadata = { ...metadata, repair: repairState }
        if (defect !== null) {
          // The raw reply is the diagnostic artifact for a malformed case.
          metadata = { ...metadata, reply: reply.slice(0, 4_000) }
          throw new PrimeMalformedReplyError(
            `${defect} in prime reply${repairState.attempted ? ' even after the bounded repair turn' : ''}`,
          )
        }

        const rows = (parsed as { blocks: unknown[] }).blocks
        const rejectedRows: Array<{ index: number; reason: string }> = []
        const blocks: CodeTraceFailureBlock[] = []
        rows.forEach((row, index) => {
          const reason = blockRowDefect(row)
          if (reason !== null) {
            rejectedRows.push({ index, reason })
            return
          }
          blocks.push(blockFromRow(row as PrimeBlockRow))
        })
        const expanded = await expandCodeTraceFailureBlocks({
          trajectoryId,
          blocks,
          store,
          analystId: PRIME_ANALYST_ID,
          ...(context.signal ? { signal: context.signal } : {}),
        })
        const answer = (parsed as { answer?: unknown }).answer
        return {
          findings: expanded.findings,
          usage,
          metadata: {
            ...metadata,
            answer: typeof answer === 'string' ? answer : null,
            rejectedRows,
            blockDiagnostics: expanded.diagnostics,
          },
        }
      } catch (error) {
        if (context.signal?.aborted) throw error
        return {
          findings: [],
          ...(usage ? { usage } : {}),
          error: publicBenchmarkError(error, []),
          metadata,
        }
      }
    },
  }
}

/**
 * Default bridge transport on node:http rather than fetch: undici's default
 * response-header timeout kills prime analyses that legitimately run past five
 * minutes, so the caller's AbortSignal is the only deadline.
 */
export function nodeHttpPrimeBridgeTransport(): PrimeBridgeTransport {
  return ({ url, body, signal }) =>
    new Promise((resolvePromise, rejectPromise) => {
      const target = new URL(url)
      if (target.protocol !== 'http:') {
        throw new TypeError(`bridge URL must be http:, got ${target.protocol}`)
      }
      const encoded = JSON.stringify(body)
      const req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(encoded),
          },
          ...(signal ? { signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolvePromise({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          )
          res.on('error', rejectPromise)
        },
      )
      req.on('error', rejectPromise)
      req.end(encoded)
    })
}

interface PrimeTrajectoryDelivery {
  mode: 'inline-json'
  fetch: 'view-trace' | 'view-spans-chunked'
  perAttributeByteCap: number | null
  renderedChars: number
}

async function projectInlineTrajectory(
  store: TraceAnalysisStore,
  trajectoryId: string,
  signal: AbortSignal | undefined,
): Promise<{ spans: TraceAnalystSpan[]; rendered: string; delivery: PrimeTrajectoryDelivery }> {
  const context: TraceAnalysisStoreContext | undefined = signal ? { signal } : undefined
  let fetch: PrimeTrajectoryDelivery['fetch'] = 'view-trace'
  const view = await store.viewTrace({ trace_id: trajectoryId }, context)
  let spans = view.spans ?? null
  if (spans === null) {
    fetch = 'view-spans-chunked'
    spans = await projectSpansChunked(store, trajectoryId, context)
  }
  let rendered = JSON.stringify(spans)
  if (rendered.length > MAX_INLINE_TRAJECTORY_CHARS && fetch === 'view-trace') {
    fetch = 'view-spans-chunked'
    spans = await projectSpansChunked(store, trajectoryId, context)
    rendered = JSON.stringify(spans)
  }
  if (rendered.length > MAX_INLINE_TRAJECTORY_CHARS) {
    throw new PrimeTraceProjectionError(
      `trajectory renders to ${rendered.length} chars even at per-attribute cap ${CHUNKED_PROJECTION_ATTRIBUTE_BYTE_CAP}; inline delivery impossible`,
    )
  }
  return {
    spans,
    rendered,
    delivery: {
      mode: 'inline-json',
      fetch,
      perAttributeByteCap: fetch === 'view-trace' ? null : CHUNKED_PROJECTION_ATTRIBUTE_BYTE_CAP,
      renderedChars: rendered.length,
    },
  }
}

/**
 * Chunked viewSpans projection for traces whose full viewTrace response is
 * oversized. Span ids come from a minimal-cap viewTrace in store order; every
 * id must project or the case fails loud — a silently dropped span would
 * understate the trajectory.
 */
async function projectSpansChunked(
  store: TraceAnalysisStore,
  trajectoryId: string,
  context: TraceAnalysisStoreContext | undefined,
): Promise<TraceAnalystSpan[]> {
  const enumeration = await store.viewTrace(
    { trace_id: trajectoryId, per_attribute_byte_cap: SPAN_ID_ENUMERATION_ATTRIBUTE_BYTE_CAP },
    context,
  )
  if (!enumeration.spans) {
    throw new PrimeTraceProjectionError(
      `trace '${trajectoryId}' is oversized even at per-attribute cap ${SPAN_ID_ENUMERATION_ATTRIBUTE_BYTE_CAP}; cannot enumerate span ids`,
    )
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const span of enumeration.spans) {
    if (typeof span.span_id === 'string' && span.span_id.length > 0 && !seen.has(span.span_id)) {
      seen.add(span.span_id)
      ids.push(span.span_id)
    }
  }
  if (ids.length === 0) {
    throw new PrimeTraceProjectionError(`no span ids parsed from trace '${trajectoryId}'`)
  }
  const projected: TraceAnalystSpan[] = []
  for (let index = 0; index < ids.length; index += VIEW_SPANS_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + VIEW_SPANS_CHUNK_SIZE)
    const result = await store.viewSpans(
      {
        trace_id: trajectoryId,
        span_ids: chunk,
        per_attribute_byte_cap: CHUNKED_PROJECTION_ATTRIBUTE_BYTE_CAP,
      },
      context,
    )
    if (
      result.missing_span_ids.length > 0 ||
      result.omitted_span_ids.length > 0 ||
      result.spans.length !== chunk.length
    ) {
      throw new PrimeTraceProjectionError(
        `viewSpans projected ${result.spans.length}/${chunk.length} spans for chunk at ${index} of '${trajectoryId}'`,
      )
    }
    projected.push(...result.spans)
  }
  return projected
}

function buildPrimePrompt(
  trajectoryId: string,
  spans: readonly TraceAnalystSpan[],
  renderedSpans: string,
): string {
  const stepSpans = spans.filter((span) => /^step-\d+$/.test(String(span.span_id)))
  if (stepSpans.length === 0) {
    throw new PrimeTraceProjectionError(`no step-<n> spans in trace '${trajectoryId}'`)
  }
  const finalVerification = spans.filter(isFinalVerificationSpan)
  return [
    `QUESTION: ${PRIME_QUESTION}`,
    '',
    'TASK DEFINITION:',
    CODE_TRACE_BENCH_ANALYST_PROMPT,
    '',
    ...primeOutputContractLines(),
    '',
    `TRAJECTORY (trace_id ${trajectoryId}; ${stepSpans.length} assistant step spans; full span projection as JSON):`,
    renderedSpans,
    '',
    finalVerification.length > 0
      ? `FINAL VERIFICATION SPANS:\n${JSON.stringify(finalVerification)}`
      : 'FINAL VERIFICATION: unavailable for this trajectory — trace backward from the latest failure evidence inside the trajectory itself.',
  ].join('\n')
}

/**
 * Short-strings rule: long reply strings get corrupted when the bridge splices
 * its backend's stream, so the contract forbids a rationale field and caps
 * every string the model must emit.
 */
function primeOutputContractLines(): string[] {
  return [
    'OUTPUT CONTRACT (supersedes any transport wording above — you have no trace tools and no REPL):',
    'You are a one-shot analyst. Every fact you need is in the TRAJECTORY JSON below.',
    'Do not run shell commands, do not read or write files, do not use any tools.',
    'Reply with EXACTLY one fenced ```json code block and no other fenced block. The JSON object has exactly two fields:',
    '  "answer": string — ONE short sentence (max 300 chars) naming the latest failure evidence you traced from.',
    '  "blocks": array (possibly empty) of failure blocks, each exactly:',
    '    {"first_step": int, "last_step": int, "consequence_step": int,',
    '     "escape_status": "escaped"|"unescaped",',
    '     "severity": "critical"|"high"|"medium"|"low"|"info",',
    '     "claim": string (ONE short sentence, max 200 chars),',
    '     "confidence": number 0..1}',
    'Do NOT include a rationale field. Keep every string SHORT — long strings get corrupted in transport and void your work.',
    `Report at most ${MAX_INCORRECT_BLOCKS} blocks; a block spans at most ${MAX_INCORRECT_BLOCK_STEPS} steps.`,
    'Every step number must be the n of an existing assistant span with span_id "step-<n>" and kind "LLM" in the trajectory below; never cite TOOL, CHAIN, or AGENT spans.',
    '"blocks" is [] only for a clean trajectory.',
  ]
}

/** Carries the malformed reply and the contract — never the trajectory. */
function primeRepairPrompt(defect: string, previousReply: string): string {
  return [
    'Your previous reply to a trace-analysis task was structurally malformed and could not be parsed',
    `(${defect}). Below is your previous reply verbatim. Re-emit ONLY the corrected JSON — one`,
    'fenced ```json block, no other text, no tools. The JSON object has exactly two fields:',
    '  "answer": string (ONE short sentence, max 300 chars)',
    '  "blocks": array (possibly empty) of {"first_step": int, "last_step": int, "consequence_step": int,',
    '   "escape_status": "escaped"|"unescaped", "severity": "critical"|"high"|"medium"|"low"|"info",',
    '   "claim": string (max 200 chars), "confidence": number 0..1}',
    'No rationale field. Keep every string SHORT. Preserve the step numbers and verdicts of your previous reply exactly; shorten prose freely.',
    '',
    'PREVIOUS REPLY:',
    previousReply,
  ].join('\n')
}

function isFinalVerificationSpan(span: TraceAnalystSpan): boolean {
  if (span.span_id.startsWith('benchmark-verification')) return true
  const role = span.attributes['benchmark.evidence.role']
  return typeof role === 'string' && role.startsWith('final-verification')
}

function trajectoryIdFromCaseId(caseId: string): string {
  const prefix = 'codetrace:'
  if (!caseId.startsWith(prefix) || caseId.length === prefix.length) {
    throw new Error(`unexpected codetracebench benchmark case id '${caseId}'`)
  }
  return caseId.slice(prefix.length)
}

function extractReplyContent(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null
  const choices = (response as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: unknown })?.message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' && content.length > 0 ? content : null
}

function extractRawUsage(response: unknown): unknown {
  if (typeof response !== 'object' || response === null) return undefined
  return (response as { usage?: unknown }).usage
}

function replyDefect(parsed: Record<string, unknown> | null): string | null {
  if (parsed === null) return 'no parseable JSON object'
  if (!Array.isArray(parsed.blocks)) return 'JSON has no "blocks" array'
  return null
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const direct = tryParseObject(text)
  if (direct) return direct
  const fenced = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)]
  for (let index = fenced.length - 1; index >= 0; index -= 1) {
    const candidate = tryParseObject(fenced[index]![1]!)
    if (candidate) return candidate
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const candidate = tryParseObject(text.slice(start, end + 1))
    if (candidate) return candidate
  }
  return null
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim())
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

interface PrimeBlockRow {
  first_step: number
  last_step: number
  consequence_step: number
  escape_status: 'escaped' | 'unescaped'
  severity: AnalystSeverity
  claim: string
  confidence: number
  rationale?: unknown
}

function blockRowDefect(row: unknown): string | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return 'row is not an object'
  const record = row as Record<string, unknown>
  for (const field of ['first_step', 'last_step', 'consequence_step'] as const) {
    const value = record[field]
    if (!Number.isInteger(value) || (value as number) < 1) {
      return `${field} must be a positive integer`
    }
  }
  const firstStep = record.first_step as number
  const lastStep = record.last_step as number
  const consequenceStep = record.consequence_step as number
  if (lastStep < firstStep) return 'last_step < first_step'
  if (consequenceStep < firstStep) return 'consequence_step < first_step'
  if (lastStep - firstStep + 1 > MAX_INCORRECT_BLOCK_STEPS) {
    return `block spans ${lastStep - firstStep + 1} steps (cap ${MAX_INCORRECT_BLOCK_STEPS})`
  }
  if (record.escape_status !== 'escaped' && record.escape_status !== 'unescaped') {
    return 'escape_status must be escaped|unescaped'
  }
  if (typeof record.severity !== 'string' || !PRIME_SEVERITIES.has(record.severity)) {
    return 'severity outside the analyst severity enum'
  }
  if (
    typeof record.claim !== 'string' ||
    record.claim.trim().length === 0 ||
    record.claim.length > 2000
  ) {
    return 'claim must be a 1-2000 char string'
  }
  if (
    typeof record.confidence !== 'number' ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    return 'confidence must be 0..1'
  }
  return null
}

function blockFromRow(row: PrimeBlockRow): CodeTraceFailureBlock {
  const rationale =
    typeof row.rationale === 'string' && row.rationale.trim().length > 0
      ? row.rationale.trim().slice(0, 4_000)
      : undefined
  return {
    firstStep: row.first_step,
    lastStep: row.last_step,
    consequenceStep: row.consequence_step,
    escapeStatus: row.escape_status,
    severity: row.severity,
    claim: row.claim.trim(),
    confidence: row.confidence,
    ...(rationale === undefined ? {} : { rationale }),
  }
}

/**
 * Receipt from the bridge's OpenAI-shaped usage object. Token counts are the
 * bridge's exact reported counts; USD is a rate-based estimate. A side the
 * bridge did not report stays null/uncaptured — never a silent zero.
 */
function usageFromBridgeUsage(raw: unknown, pricing: CustomTokenPricing): AnalystUsageReceipt {
  if (typeof raw !== 'object' || raw === null) {
    return { calls: null, tokens: null, cost: { kind: 'uncaptured', usd: null } }
  }
  const record = raw as Record<string, unknown>
  const input = nonNegativeSafeIntegerOrNull(record.prompt_tokens)
  const output = nonNegativeSafeIntegerOrNull(record.completion_tokens)
  const tokens = input !== null && output !== null ? { input, output } : null
  return {
    calls: nonNegativeSafeIntegerOrNull(record.model_requests),
    tokens,
    cost: estimatedCost(tokens, pricing),
  }
}

/** Sum two receipts; an uncaptured side poisons the sum to uncaptured rather
 *  than silently under-reporting. */
function mergePrimeUsage(
  a: AnalystUsageReceipt,
  b: AnalystUsageReceipt,
  pricing: CustomTokenPricing,
): AnalystUsageReceipt {
  const calls = a.calls !== null && b.calls !== null ? a.calls + b.calls : null
  const tokens =
    a.tokens !== null && b.tokens !== null
      ? { input: a.tokens.input + b.tokens.input, output: a.tokens.output + b.tokens.output }
      : null
  return { calls, tokens, cost: estimatedCost(tokens, pricing) }
}

function estimatedCost(
  tokens: { input: number; output: number } | null,
  pricing: CustomTokenPricing,
): AnalystUsageReceipt['cost'] {
  if (tokens === null) return { kind: 'uncaptured', usd: null }
  return {
    kind: 'estimated',
    usd:
      (tokens.input * pricing.inputUsdPerMillion + tokens.output * pricing.outputUsdPerMillion) /
      1_000_000,
  }
}

function nonNegativeSafeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function pricingForModel(model: string): CustomTokenPricing {
  const pricing = resolveModelPricing(model)
  if (!pricing) {
    throw new Error(
      `no pricing is configured for '${model}'; provide PrimeBenchmarkRunnerOptions.pricing`,
    )
  }
  return {
    inputUsdPerMillion: pricing.input * 1_000,
    outputUsdPerMillion: pricing.output * 1_000,
  }
}
