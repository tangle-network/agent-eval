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
import { type AnalystDefinition, AnalystExpressivenessError } from './definition'
import { nodeHttpPrimeBridgeTransport, type PrimeBridgeTransport } from './prime-bridge-transport'
import {
  analystUsageReceiptFromPrimeUsage,
  buildPrimePrompt,
  type PrimeFailure,
  type PrimeProjectionSource,
  type PrimeProtocolIdentity,
  type PrimeReplyContract,
  type PrimeTurnRecord,
  primeProtocolSha256,
  projectPrimeTrajectory,
  runPrimeExchange,
} from './prime-protocol'
import type { AnalystRunInputs, AnalystSeverity, AnalystUsageReceipt } from './types'

/**
 * Prime analyst arm: the RLM coding agent reached through an OpenAI-compatible
 * cli-bridge solves the CodeTraceBench incorrect-step task as a one-shot trace
 * analyst.
 *
 * The arm is expressed as an `AnalystDefinition`
 * (`primeCodeTraceAnalystDefinition`): the question, task text, output
 * contract, inline projection budget, and repair-turn declaration are all
 * definition content, and `createPrimeBenchmarkRunner` is a thin shell that
 * builds the definition and runs it through the inline strategy below. The
 * same strategy is what `bindAnalyst` (./bind) dispatches to, so a compiled
 * definition and this entry point send byte-identical requests — the parity
 * suite asserts exactly that.
 *
 * The protocol machinery — prompt composition, the bounded repair turn, reply
 * extraction, the projection ladder, usage normalization — lives in
 * `./prime-protocol`, which knows nothing about CodeTraceBench. This file adds
 * the benchmark's binding to it (block row grammar, store-backed projection,
 * observation shape) plus the projection-generic inline execution strategy.
 *
 * Trajectory delivery is inline JSON in the prompt. The dspy typed path binds
 * the viewTrace span projection as a REPL variable; prime has no REPL, so the
 * same projection is serialized into the prompt. When the full projection is
 * oversized the strategy falls back to chunked viewSpans over the same
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
 * Short-strings rule: long reply strings get corrupted when the bridge splices
 * its backend's stream, so the contract forbids a rationale field and caps
 * every string the model must emit.
 */
const PRIME_OUTPUT_CONTRACT_LINES: readonly string[] = [
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

const PRIME_REPAIR_CONTRACT_LINES: readonly string[] = [
  '  "answer": string (ONE short sentence, max 300 chars)',
  '  "blocks": array (possibly empty) of {"first_step": int, "last_step": int, "consequence_step": int,',
  '   "escape_status": "escaped"|"unescaped", "severity": "critical"|"high"|"medium"|"low"|"info",',
  '   "claim": string (max 200 chars), "confidence": number 0..1}',
  'No rationale field. Keep every string SHORT. Preserve the step numbers and verdicts of your previous reply exactly; shorten prose freely.',
]

const PRIME_PROTOCOL_IDENTITY: PrimeProtocolIdentity = {
  question: PRIME_QUESTION,
  taskDefinition: CODE_TRACE_BENCH_ANALYST_PROMPT,
  contractLines: PRIME_OUTPUT_CONTRACT_LINES,
  repairContractLines: PRIME_REPAIR_CONTRACT_LINES,
  limits: {
    maxBlocks: MAX_INCORRECT_BLOCKS,
    maxBlockSteps: MAX_INCORRECT_BLOCK_STEPS,
    maxInlineTrajectoryChars: MAX_INLINE_TRAJECTORY_CHARS,
    chunkedProjectionAttributeByteCap: CHUNKED_PROJECTION_ATTRIBUTE_BYTE_CAP,
  },
}

/**
 * The block row grammar. No `maxRows`: the count cap belongs to
 * `expandCodeTraceFailureBlocks`, which drops the offending block and names it
 * in `diagnostics.droppedBlocks`, so capping here would erase that record.
 */
const PRIME_BLOCK_CONTRACT: PrimeReplyContract<CodeTraceFailureBlock> = {
  rowsField: 'blocks',
  contractLines: PRIME_OUTPUT_CONTRACT_LINES,
  repairContractLines: PRIME_REPAIR_CONTRACT_LINES,
  decodeRow(row) {
    const reason = blockRowDefect(row)
    if (reason !== null) return { ok: false, reason }
    return { ok: true, row: blockFromRow(row as PrimeBlockRow) }
  },
}

/**
 * Digest of everything this arm can send to the bridge, recorded per
 * observation so a prime result names the exact contract that produced it.
 */
export function primeAnalystProtocolSha256(): string {
  return primeProtocolSha256(PRIME_PROTOCOL_IDENTITY)
}

export interface PrimeCodeTraceDefinitionArgs {
  /** Deadline for one bridge call. */
  timeoutMs: number
  /** 1 grants the bounded repair turn; 0 disables it. */
  repairTurns: number
}

/**
 * The prime arm as a declarative unit. CodeTraceBench-only: the question,
 * task text, and block grammar speak its incorrect-step definition.
 */
export function primeCodeTraceAnalystDefinition(
  args: PrimeCodeTraceDefinitionArgs,
): AnalystDefinition<CodeTraceFailureBlock> {
  return {
    id: PRIME_ANALYST_ID,
    description:
      'One-shot RLM over an OpenAI-compatible bridge answering the CodeTraceBench incorrect-step task.',
    version: '1.0.0',
    area: 'incorrect',
    // The bridge owns model selection and reasoning control; the fragment pins nothing.
    profile: {},
    question: PRIME_QUESTION,
    taskDefinition: CODE_TRACE_BENCH_ANALYST_PROMPT,
    projection: {
      mode: 'inline',
      maxInlineChars: MAX_INLINE_TRAJECTORY_CHARS,
      cappedAttributeBytes: CHUNKED_PROJECTION_ATTRIBUTE_BYTE_CAP,
    },
    replyContract: PRIME_BLOCK_CONTRACT,
    // Insertion order is digest-bearing: it mirrors PRIME_PROTOCOL_IDENTITY.limits.
    contractLimits: {
      maxBlocks: MAX_INCORRECT_BLOCKS,
      maxBlockSteps: MAX_INCORRECT_BLOCK_STEPS,
    },
    budget: { timeoutMs: args.timeoutMs },
    repair: { turns: args.repairTurns },
    protocolSha256: primeAnalystProtocolSha256(),
    binding: {
      kind: 'inline',
      subjectFromCaseId: trajectoryIdFromCaseId,
      baseMetadata: { analysisMode: 'prime-rlm', engine: 'prime' },
      header(subject, spans) {
        const stepSpans = spans.filter((span) => /^step-\d+$/.test(String(span.span_id)))
        if (stepSpans.length === 0) {
          throw new PrimeTraceProjectionError(`no step-<n> spans in trace '${subject}'`)
        }
        return `TRAJECTORY (trace_id ${subject}; ${stepSpans.length} assistant step spans; full span projection as JSON):`
      },
      trailer(_subject, spans) {
        const finalVerification = spans.filter(isFinalVerificationSpan)
        return finalVerification.length > 0
          ? `FINAL VERIFICATION SPANS:\n${JSON.stringify(finalVerification)}`
          : 'FINAL VERIFICATION: unavailable for this trajectory — trace backward from the latest failure evidence inside the trajectory itself.'
      },
      async expandRows({ subject, rows, store, analystId, signal }) {
        const expanded = await expandCodeTraceFailureBlocks({
          trajectoryId: subject,
          blocks: rows,
          store,
          analystId,
          ...(signal ? { signal } : {}),
        })
        return { findings: expanded.findings, diagnostics: expanded.diagnostics }
      },
    },
  }
}

/** Thin shell: validate options, declare the definition, run the inline strategy. */
export function createPrimeBenchmarkRunner(
  options: PrimeBenchmarkRunnerOptions,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const timeoutMs = positiveSafeInteger(options.timeoutMs, 'timeoutMs')
  const repair = options.repair
  if (typeof repair !== 'boolean') throw new TypeError('repair must be a boolean')
  return runInlineAnalystDefinition(
    primeCodeTraceAnalystDefinition({ timeoutMs, repairTurns: repair ? 1 : 0 }),
    {
      baseUrl: options.baseUrl,
      model: options.model,
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.pricing ? { pricing: options.pricing } : {}),
    },
  )
}

// ── Inline execution strategy ───────────────────────────────────────

/** The transport half of an inline-projection binding: the bridge endpoint. */
export interface InlineBridgeTransports {
  /** OpenAI-compatible bridge base URL. */
  baseUrl: string
  /** Bridge model id. */
  model: string
  /** Bridge transport. Default: node:http POST. */
  transport?: PrimeBridgeTransport
  /** Exact token rates. Default: the agent-eval catalog rates for `model`. */
  pricing?: CustomTokenPricing
}

/**
 * Compile an inline-projection definition into a runnable arm. Projection,
 * prompt composition, the bounded repair turn, and usage accounting are all
 * driven by the definition; nothing in this strategy names a benchmark.
 */
export function runInlineAnalystDefinition<TRow>(
  definition: AnalystDefinition<TRow>,
  transports: InlineBridgeTransports,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const { projection, binding } = definition
  if (projection.mode !== 'inline' || binding.kind !== 'inline') {
    throw new AnalystExpressivenessError(
      `the inline strategy compiles only inline projections; definition '${definition.id}' ` +
        `declares projection '${projection.mode}' with a '${binding.kind}' binding`,
    )
  }
  if (definition.repair.turns > 1) {
    throw new AnalystExpressivenessError(
      `the inline exchange grants at most one bounded repair turn; definition ` +
        `'${definition.id}' declares ${definition.repair.turns}`,
    )
  }
  const baseUrl = requiredString(transports.baseUrl, 'baseUrl').replace(/\/+$/, '')
  const model = requiredString(transports.model, 'model')
  const timeoutMs = positiveSafeInteger(definition.budget.timeoutMs, 'timeoutMs')
  const repair = definition.repair.turns === 1
  const pricing = transports.pricing ?? pricingForModel(model)
  const transport = transports.transport ?? nodeHttpPrimeBridgeTransport()
  const url = `${baseUrl}/v1/chat/completions`

  return {
    id: definition.id,
    async analyze(input, context) {
      const subject = binding.subjectFromCaseId(context.caseId)
      let usage: AnalystUsageReceipt | undefined
      let metadata: Record<string, unknown> = {
        ...binding.baseMetadata,
        bridgeUrl: baseUrl,
        model,
        protocolSha256: definition.protocolSha256,
      }
      try {
        const store = input.traceStore
        if (!store) throw new Error(`inline analyst '${definition.id}' requires a trace store`)
        const storeContext: TraceAnalysisStoreContext | undefined = context.signal
          ? { signal: context.signal }
          : undefined
        const projected = await projectPrimeTrajectory(
          inlineProjectionSource(store, subject, projection.cappedAttributeBytes, storeContext),
          { maxInlineChars: projection.maxInlineChars },
        )
        if (!projected.ok) throw new PrimeTraceProjectionError(projected.reason)
        const delivery: InlineTrajectoryDelivery = {
          mode: projected.delivery.mode,
          fetch: projected.delivery.fetch === 'full' ? 'view-trace' : 'view-spans-chunked',
          perAttributeByteCap:
            projected.delivery.fetch === 'full' ? null : projection.cappedAttributeBytes,
          renderedChars: projected.delivery.renderedChars,
        }
        metadata = { ...metadata, delivery }
        const prompt = buildPrimePrompt({
          question: definition.question,
          ...(definition.taskDefinition === undefined
            ? {}
            : { taskDefinition: definition.taskDefinition }),
          contractLines: definition.replyContract.contractLines,
          trajectoryHeader: binding.header(subject, projected.items),
          renderedTrajectory: projected.rendered,
          trailer: binding.trailer(subject, projected.items),
        })
        metadata = { ...metadata, promptChars: prompt.length }

        const outcome = await runPrimeExchange({
          contract: definition.replyContract,
          prompt,
          transport,
          url,
          model,
          timeoutMs,
          repair,
          ...(context.signal ? { signal: context.signal } : {}),
        })
        if (!outcome.ok && outcome.failure.kind === 'aborted') throw abortCause(outcome.failure)
        if (outcome.turns.length > 0) {
          usage = analystUsageReceiptFromPrimeUsage(outcome.usage, pricing)
          metadata = { ...metadata, bridgeUsage: bridgeUsageFromTurns(outcome.turns) }
        }
        metadata = { ...metadata, repair: outcome.repair }
        if (!outcome.ok) {
          // The raw reply is the diagnostic artifact for a malformed case.
          if (outcome.reply !== undefined) {
            metadata = { ...metadata, reply: outcome.reply.slice(0, 4_000) }
          }
          throw primeFailureError(outcome.failure)
        }

        const expanded = await binding.expandRows({
          subject,
          rows: outcome.rows,
          store,
          analystId: definition.id,
          ...(context.signal ? { signal: context.signal } : {}),
        })
        return {
          findings: expanded.findings,
          usage,
          metadata: {
            ...metadata,
            answer: outcome.answer,
            reportedRows: outcome.reportedRows,
            rejectedRows: outcome.rejected,
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

interface InlineTrajectoryDelivery {
  mode: 'inline-json'
  fetch: 'view-trace' | 'view-spans-chunked'
  perAttributeByteCap: number | null
  renderedChars: number
}

/**
 * The trace store, seen through the protocol's two-move projection contract:
 * the full viewTrace projection, or the chunked viewSpans projection at a
 * per-attribute byte cap.
 */
function inlineProjectionSource(
  store: TraceAnalysisStore,
  trajectoryId: string,
  cappedAttributeBytes: number,
  context: TraceAnalysisStoreContext | undefined,
): PrimeProjectionSource<TraceAnalystSpan> {
  return {
    async full() {
      const view = await store.viewTrace({ trace_id: trajectoryId }, context)
      return view.spans ?? null
    },
    capped: () => projectSpansChunked(store, trajectoryId, cappedAttributeBytes, context),
    cappedDescription: `per-attribute cap ${cappedAttributeBytes}`,
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
  cappedAttributeBytes: number,
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
        per_attribute_byte_cap: cappedAttributeBytes,
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

/** Map the protocol's terminal reason onto this benchmark's typed error classes. */
function primeFailureError(failure: PrimeFailure): Error {
  switch (failure.kind) {
    case 'http-status':
      return new PrimeBridgeHttpError(failure.status, failure.bodySnippet)
    case 'malformed-reply':
      return new PrimeMalformedReplyError(failure.message)
    default:
      return new PrimeBridgeTransportError(failure.message)
  }
}

/** A cancelled run is not a result: the caller's error propagates unchanged. */
function abortCause(failure: Extract<PrimeFailure, { kind: 'aborted' }>): unknown {
  return failure.cause instanceof Error ? failure.cause : new Error(failure.message)
}

function bridgeUsageFromTurns(turns: readonly PrimeTurnRecord[]): Record<string, unknown> {
  return {
    first: turns.find((turn) => turn.turn === 'first')?.rawUsage ?? null,
    repair: turns.find((turn) => turn.turn === 'repair')?.rawUsage ?? null,
  }
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
  // The contract asks the model not to send a rationale, but a volunteered one
  // is model-produced evidence: discarding it is unrecoverable, while carrying
  // a bounded string costs nothing and the destination field exists.
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
