import { createHash } from 'node:crypto'
import type { CustomTokenPricing } from '../cost-ledger'
import type { PrimeBridgeTransport, PrimeBridgeTransportResult } from './prime-bridge-transport'
import type { ReplyContract, ReplyRowDecoded } from './reply-contract'
import type { AnalystUsageReceipt } from './types'

/**
 * The prime analyst protocol: a one-shot RLM reached through an
 * OpenAI-compatible bridge, given the whole trajectory inline because it has no
 * REPL and no trace tools, answering in one fenced JSON block of short strings.
 *
 * This module owns every part of that protocol that does not depend on what the
 * rows MEAN: prompt and contract composition, the bounded repair turn, reply
 * extraction, row decoding order, the render-measure-fall-back-fail-loud
 * projection ladder, usage normalization, and the protocol identity digest.
 *
 * The cut: the core speaks RAW ROWS and never names a finding type. It knows a
 * prime reply carries an `answer` string plus an array of rows under a named
 * field, and that each row is decoded by a caller-supplied function. Consumers
 * — the CodeTraceBench benchmark runner here, a span-grounded trace analyzer
 * elsewhere — map decoded rows into their own finding shape on the way out. So
 * nothing in this file may import a block type, a finding type, or a trace
 * store, and no consumer needs another copy of the protocol.
 */

// ── Reply contract ───────────────────────────────────────────────────

/**
 * The prime reply grammar is the general analyst reply contract: these aliases
 * keep every prime-protocol consumer compiling against the shared type in
 * ./reply-contract. The exchange below reads the base fields (`rowsField`,
 * contract lines, `decodeRow`, `maxRows`); the strict-envelope knobs serve
 * one-shot JSON arms and are inert here.
 */
export type PrimeRowDecoded<TRow> = ReplyRowDecoded<TRow>

export type PrimeReplyContract<TRow> = ReplyContract<TRow>

// ── Prompt composition ───────────────────────────────────────────────

export interface PrimePromptSpec {
  question: string
  /** Task definition spliced under a `TASK DEFINITION:` heading. Omit when the question is the whole task. */
  taskDefinition?: string
  contractLines: readonly string[]
  /** Line introducing the trajectory, e.g. `TRAJECTORY (trace_id X; 12 assistant step spans; ...):`. */
  trajectoryHeader: string
  renderedTrajectory: string
  /** Material appended after the trajectory, e.g. the final-verification spans. */
  trailer?: string
}

export function buildPrimePrompt(spec: PrimePromptSpec): string {
  return [
    `QUESTION: ${spec.question}`,
    '',
    ...(spec.taskDefinition === undefined ? [] : ['TASK DEFINITION:', spec.taskDefinition, '']),
    ...spec.contractLines,
    '',
    spec.trajectoryHeader,
    spec.renderedTrajectory,
    ...(spec.trailer === undefined ? [] : ['', spec.trailer]),
  ].join('\n')
}

export interface PrimeRepairPromptSpec {
  defect: string
  previousReply: string
  repairContractLines: readonly string[]
}

/** Carries the malformed reply and the contract — never the trajectory. */
export function buildPrimeRepairPrompt(spec: PrimeRepairPromptSpec): string {
  return [
    'Your previous reply to a trace-analysis task was structurally malformed and could not be parsed',
    `(${spec.defect}). Below is your previous reply verbatim. Re-emit ONLY the corrected JSON — one`,
    'fenced ```json block, no other text, no tools. The JSON object has exactly two fields:',
    ...spec.repairContractLines,
    '',
    'PREVIOUS REPLY:',
    spec.previousReply,
  ].join('\n')
}

// ── Reply extraction ─────────────────────────────────────────────────

/**
 * Recover the reply's JSON object.
 *
 * Distinct from `extractJsonPayload` in ../llm-client, which serves a response
 * that DECLARES a JSON root and therefore must not scan onward. A prime reply
 * is prose plus a fenced block, and when the model emits several fences the
 * last one is its answer — so fences are scanned in reverse, and only then is a
 * brace-to-brace slice tried.
 */
export function extractPrimeJsonObject(text: string): Record<string, unknown> | null {
  const direct = parsePrimeJsonObject(text)
  if (direct) return direct
  const fenced = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)]
  for (let index = fenced.length - 1; index >= 0; index -= 1) {
    const candidate = parsePrimeJsonObject(fenced[index]![1]!)
    if (candidate) return candidate
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const candidate = parsePrimeJsonObject(text.slice(start, end + 1))
    if (candidate) return candidate
  }
  return null
}

/** Why the reply cannot be read as a prime answer, or null when it can. */
export function primeReplyDefect(
  parsed: Record<string, unknown> | null,
  rowsField: string,
): string | null {
  if (parsed === null) return 'no parseable JSON object'
  if (!Array.isArray(parsed[rowsField])) return `JSON has no "${rowsField}" array`
  return null
}

function parsePrimeJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim())
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// ── Usage ────────────────────────────────────────────────────────────

/**
 * Token accounting exactly as the bridge reported it. Lossless on purpose: a
 * side the bridge did not report stays null rather than becoming a zero, and a
 * side it DID report survives even when its partner is missing.
 */
export interface PrimeRawUsage {
  /**
   * Model-usage records the bridge observed. NOT a count of bridge round trips:
   * one prime turn routes several internal model calls, so a single turn
   * typically reports 3-5.
   */
  calls: number | null
  /** Prompt tokens the bridge reported; null when it reported none. */
  inputTokens: number | null
  /** Completion tokens the bridge reported; null when it reported none. */
  outputTokens: number | null
  /**
   * True when the bridge DERIVED the counts (from character lengths) because
   * the backend reported no usage of its own. Pricing derived counts produces a
   * guess about a guess, which a reader must be able to tell apart from a
   * rate-estimated cost over exact tokens.
   */
  bridgeEstimated: boolean
}

export function emptyPrimeRawUsage(): PrimeRawUsage {
  return { calls: null, inputTokens: null, outputTokens: null, bridgeEstimated: false }
}

/** Read the bridge's OpenAI-shaped `usage` object. */
export function normalizePrimeUsage(raw: unknown): PrimeRawUsage {
  if (typeof raw !== 'object' || raw === null) return emptyPrimeRawUsage()
  const record = raw as Record<string, unknown>
  return {
    calls: tokenCountOrNull(record.model_requests),
    inputTokens: tokenCountOrNull(record.prompt_tokens),
    outputTokens: tokenCountOrNull(record.completion_tokens),
    bridgeEstimated: record.estimated === true,
  }
}

/**
 * Sum two turns. Each side poisons independently: two turns that both report
 * input and neither report output yield a real input total beside a null
 * output, because discarding a measured count is as wrong as inventing one.
 */
export function mergePrimeRawUsage(a: PrimeRawUsage, b: PrimeRawUsage): PrimeRawUsage {
  return {
    calls: sumOrNull(a.calls, b.calls),
    inputTokens: sumOrNull(a.inputTokens, b.inputTokens),
    outputTokens: sumOrNull(a.outputTokens, b.outputTokens),
    bridgeEstimated: a.bridgeEstimated || b.bridgeEstimated,
  }
}

function sumOrNull(a: number | null, b: number | null): number | null {
  return a !== null && b !== null ? a + b : null
}

function tokenCountOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Bind raw prime usage to agent-eval's typed receipt.
 *
 * `RunTokenUsage.input` and `.output` are non-nullable, so a one-sided count
 * cannot round-trip through `tokens` without writing a zero nobody measured.
 * The complete-accounting field therefore stays null, the reported side is
 * carried verbatim in `partialTokens`, and its price becomes the receipt's
 * `knownCostUsd` lower bound.
 *
 * Only agent-eval calls this; consumers with no pricing table read
 * `PrimeRawUsage` directly.
 */
export function analystUsageReceiptFromPrimeUsage(
  usage: PrimeRawUsage,
  pricing: CustomTokenPricing,
): AnalystUsageReceipt {
  const { calls, inputTokens, outputTokens, bridgeEstimated } = usage
  const estimatedTokens = bridgeEstimated ? { tokensEstimated: true } : {}
  if (inputTokens !== null && outputTokens !== null) {
    return {
      calls,
      tokens: { input: inputTokens, output: outputTokens },
      cost: { kind: 'estimated', usd: priceTokens(inputTokens, outputTokens, pricing) },
      ...estimatedTokens,
    }
  }
  if (inputTokens === null && outputTokens === null) {
    return { calls, tokens: null, cost: { kind: 'uncaptured', usd: null }, ...estimatedTokens }
  }
  return {
    calls,
    tokens: null,
    partialTokens: { input: inputTokens, output: outputTokens },
    cost: { kind: 'uncaptured', usd: null },
    knownCostUsd: priceTokens(inputTokens ?? 0, outputTokens ?? 0, pricing),
    ...estimatedTokens,
  }
}

function priceTokens(input: number, output: number, pricing: CustomTokenPricing): number {
  return (input * pricing.inputUsdPerMillion + output * pricing.outputUsdPerMillion) / 1_000_000
}

// ── Two-turn exchange ────────────────────────────────────────────────

/**
 * Why an exchange ended without a readable reply. `deadline` and `aborted` are
 * separate members from `transport` on purpose: a model that ran past its
 * deadline, a caller who cancelled, and a bridge that refused the connection
 * demand three different responses, and a record that conflates them cannot be
 * acted on.
 */
export type PrimeFailure =
  | {
      kind: 'transport' | 'unparseable-json' | 'no-content' | 'deadline' | 'malformed-reply'
      message: string
    }
  | { kind: 'http-status'; message: string; status: number; bodySnippet: string }
  | { kind: 'aborted'; message: string; cause: unknown }

export interface PrimeRepairState {
  attempted: boolean
  /** Null when no repair turn ran, or when the repair turn never returned a reply. */
  succeeded: boolean | null
}

/** One completed bridge turn. A turn that failed produces no record. */
export interface PrimeTurnRecord {
  turn: 'first' | 'repair'
  usage: PrimeRawUsage
  /** The reply's `usage` object verbatim; null when the bridge sent none. */
  rawUsage: unknown
}

export interface PrimeRejectedRow {
  index: number
  reason: string
}

export type PrimeExchangeOutcome<TRow> =
  | {
      ok: true
      /** The reply's `answer` field; null when absent or not a string. */
      answer: string | null
      rows: TRow[]
      rejected: PrimeRejectedRow[]
      /** Rows the model reported, before decoding or the count cap. */
      reportedRows: number
      /** Valid rows dropped by `contract.maxRows`. */
      overflow: number
      usage: PrimeRawUsage
      turns: PrimeTurnRecord[]
      repair: PrimeRepairState
      reply: string
    }
  | {
      ok: false
      failure: PrimeFailure
      usage: PrimeRawUsage
      turns: PrimeTurnRecord[]
      repair: PrimeRepairState
      /** The last reply received, when one arrived — the diagnostic artifact for a malformed case. */
      reply?: string
    }

export interface PrimeExchangeOptions<TRow> {
  contract: PrimeReplyContract<TRow>
  prompt: string
  transport: PrimeBridgeTransport
  /** Full endpoint, e.g. `http://localhost:4181/v1/chat/completions`. */
  url: string
  model: string
  /** Deadline for ONE turn. Prime analyses routinely exceed five minutes. */
  timeoutMs: number
  /** Whether a structurally malformed reply gets one bounded repair turn. */
  repair: boolean
  signal?: AbortSignal
}

/**
 * Run the protocol: one call, one bounded repair turn on a structurally
 * malformed reply, then decode. Zero valid rows from a well-formed reply is an
 * honest null, not a failure.
 */
export async function runPrimeExchange<TRow>(
  options: PrimeExchangeOptions<TRow>,
): Promise<PrimeExchangeOutcome<TRow>> {
  const { contract } = options
  const turns: PrimeTurnRecord[] = []
  const repair: PrimeRepairState = { attempted: false, succeeded: null }

  const first = await callPrimeTurn(options, options.prompt)
  if (!first.ok) {
    return { ok: false, failure: first.failure, usage: mergeTurns(turns), turns, repair }
  }
  turns.push({ turn: 'first', usage: first.usage, rawUsage: first.rawUsage })

  let reply = first.content
  let parsed = extractPrimeJsonObject(reply)
  let defect = primeReplyDefect(parsed, contract.rowsField)

  if (defect !== null && options.repair) {
    repair.attempted = true
    const second = await callPrimeTurn(
      options,
      buildPrimeRepairPrompt({
        defect,
        previousReply: reply,
        repairContractLines: contract.repairContractLines,
      }),
    )
    if (!second.ok) {
      return { ok: false, failure: second.failure, usage: mergeTurns(turns), turns, repair, reply }
    }
    turns.push({ turn: 'repair', usage: second.usage, rawUsage: second.rawUsage })
    reply = second.content
    parsed = extractPrimeJsonObject(reply)
    defect = primeReplyDefect(parsed, contract.rowsField)
    repair.succeeded = defect === null
  }

  const usage = mergeTurns(turns)
  if (defect !== null) {
    return {
      ok: false,
      failure: {
        kind: 'malformed-reply',
        message: `${defect} in prime reply${repair.attempted ? ' even after the bounded repair turn' : ''}`,
      },
      usage,
      turns,
      repair,
      reply,
    }
  }

  const rawRows = parsed![contract.rowsField] as unknown[]
  const rows: TRow[] = []
  const rejected: PrimeRejectedRow[] = []
  let overflow = 0
  rawRows.forEach((row, index) => {
    const decoded = contract.decodeRow(row, index)
    if (!decoded.ok) {
      rejected.push({ index, reason: decoded.reason })
      return
    }
    // Shape before count: a malformed row must never consume an accepted slot.
    if (contract.maxRows !== undefined && rows.length >= contract.maxRows) {
      overflow += 1
      return
    }
    rows.push(decoded.row)
  })
  const answer = parsed!.answer
  return {
    ok: true,
    answer: typeof answer === 'string' ? answer : null,
    rows,
    rejected,
    reportedRows: rawRows.length,
    overflow,
    usage,
    turns,
    repair,
    reply,
  }
}

type PrimeTurnOutcome =
  | { ok: true; content: string; usage: PrimeRawUsage; rawUsage: unknown }
  | { ok: false; failure: PrimeFailure }

async function callPrimeTurn<TRow>(
  options: PrimeExchangeOptions<TRow>,
  content: string,
): Promise<PrimeTurnOutcome> {
  const { transport, url, model, timeoutMs, signal } = options
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
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) {
      return {
        ok: false,
        failure: {
          kind: 'aborted',
          message: 'prime exchange cancelled by the caller',
          cause: error,
        },
      }
    }
    if (controller.signal.aborted) {
      return {
        ok: false,
        failure: { kind: 'deadline', message: `bridge call exceeded ${timeoutMs}ms` },
      }
    }
    return {
      ok: false,
      failure: {
        kind: 'transport',
        message: `bridge transport failure: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', forwardAbort)
  }

  if (result.status !== 200) {
    const bodySnippet = result.text.slice(0, 500)
    return {
      ok: false,
      failure: {
        kind: 'http-status',
        message: `bridge HTTP ${result.status}: ${bodySnippet}`,
        status: result.status,
        bodySnippet,
      },
    }
  }
  let response: unknown
  try {
    response = JSON.parse(result.text)
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'unparseable-json',
        message: `bridge returned unparseable JSON (${result.text.length} bytes)`,
      },
    }
  }
  const replyContent = primeReplyContent(response)
  if (replyContent === null) {
    return {
      ok: false,
      failure: { kind: 'no-content', message: 'bridge reply carries no message content' },
    }
  }
  const rawUsage = primeReplyUsage(response)
  return { ok: true, content: replyContent, usage: normalizePrimeUsage(rawUsage), rawUsage }
}

/**
 * Fold from the FIRST turn, never from an empty receipt: an all-null identity
 * would poison every side it merged with and erase counts the bridge reported.
 */
function mergeTurns(turns: readonly PrimeTurnRecord[]): PrimeRawUsage {
  if (turns.length === 0) return emptyPrimeRawUsage()
  return turns
    .slice(1)
    .reduce<PrimeRawUsage>((total, turn) => mergePrimeRawUsage(total, turn.usage), turns[0]!.usage)
}

function primeReplyContent(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null
  const choices = (response as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: unknown })?.message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' && content.length > 0 ? content : null
}

function primeReplyUsage(response: unknown): unknown {
  if (typeof response !== 'object' || response === null) return null
  return (response as { usage?: unknown }).usage ?? null
}

// ── Trajectory projection ────────────────────────────────────────────

/**
 * Where the inlined trajectory comes from. The protocol needs only two moves —
 * fetch it all, or fetch a reduced version — so no store, artifact path, or
 * span type enters the shared signature.
 */
export interface PrimeProjectionSource<TItem> {
  /** The full projection, or null when the source declares itself oversized. */
  full(): Promise<readonly TItem[] | null>
  /** A reduced projection of the same material. */
  capped(): Promise<readonly TItem[]>
  /** How `capped` reduces, named for the failure message, e.g. `per-attribute cap 1200`. */
  cappedDescription: string
}

export interface PrimeProjectionDelivery {
  mode: 'inline-json'
  fetch: 'full' | 'capped'
  renderedChars: number
}

export type PrimeProjectionOutcome<TItem> =
  | {
      ok: true
      items: readonly TItem[]
      rendered: string
      delivery: PrimeProjectionDelivery
    }
  | { ok: false; reason: string; renderedChars: number }

/**
 * Render, measure, fall back to the capped projection, re-measure, fail loud.
 *
 * Inline is the only delivery prime has, so an oversized trajectory is a
 * refusal rather than a silent truncation: dropping spans would understate the
 * trajectory and the analyst would answer a question about a different run.
 */
export async function projectPrimeTrajectory<TItem>(
  source: PrimeProjectionSource<TItem>,
  limits: { maxInlineChars: number },
): Promise<PrimeProjectionOutcome<TItem>> {
  let fetch: PrimeProjectionDelivery['fetch'] = 'full'
  let items = await source.full()
  if (items === null) {
    fetch = 'capped'
    items = await source.capped()
  }
  let rendered = JSON.stringify(items)
  if (rendered.length > limits.maxInlineChars && fetch === 'full') {
    fetch = 'capped'
    items = await source.capped()
    rendered = JSON.stringify(items)
  }
  if (rendered.length > limits.maxInlineChars) {
    return {
      ok: false,
      reason: `trajectory renders to ${rendered.length} chars even at ${source.cappedDescription}; inline delivery impossible`,
      renderedChars: rendered.length,
    }
  }
  return {
    ok: true,
    items,
    rendered,
    delivery: { mode: 'inline-json', fetch, renderedChars: rendered.length },
  }
}

// ── Protocol identity ────────────────────────────────────────────────

export interface PrimeProtocolIdentity {
  question: string
  taskDefinition?: string
  contractLines: readonly string[]
  repairContractLines: readonly string[]
  /** Numeric limits the contract states, e.g. row and width caps. */
  limits: Readonly<Record<string, number>>
}

/**
 * Digest of everything a consumer can send to the bridge under the prime
 * protocol, recorded per observation so a prime result names the exact contract
 * that produced it.
 *
 * Computed over the ACTUALLY composed contract, so two consumers that both
 * stamp `analyst_id: 'prime'` while asking materially different questions get
 * different digests by construction. That is what makes 'prime' a reproducible
 * claim rather than a label.
 */
export function primeProtocolSha256(identity: PrimeProtocolIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'prime-analyst-protocol',
        question: identity.question,
        taskPrompt: identity.taskDefinition ?? null,
        outputContract: identity.contractLines,
        repairContract: buildPrimeRepairPrompt({
          defect: '<defect>',
          previousReply: '<previous-reply>',
          repairContractLines: identity.repairContractLines,
        }),
        limits: identity.limits,
      }),
    )
    .digest('hex')
}
