/**
 * Pure handler functions — the "business logic" behind every wire-protocol
 * method. The HTTP server (`server.ts`) and the stdio RPC (`rpc.ts`) both
 * call these. Tests call these directly without spinning a server.
 *
 * Each handler:
 *   - Takes a parsed request (already Zod-validated by the transport).
 *   - Returns a result that matches the response schema.
 *   - Throws `WireError` for caller-fixable errors (404, 400, 422).
 *   - Lets unexpected errors bubble — the transport maps them to 500.
 */

import { CostLedger, type CostLedgerHandle } from '../cost-ledger'
import type { FeedbackTrajectoryStore } from '../feedback-trajectory'
import {
  callLlmJson,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type LlmCallRequest,
  type LlmClientOptions,
  maximumChargeForLlmRequest,
} from '../llm-client'
import type { TraceEvent as InternalTraceEvent } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { getBuiltinRubric, listBuiltinRubrics } from './rubrics'
import {
  type FeedbackIngestResponse,
  hashRubric,
  type JudgeRequest,
  type JudgeResult,
  type ListRubricsResponse,
  type Rubric,
  type TracesIngestRequest,
  type TracesIngestResponse,
  type VersionResponse,
  WIRE_VERSION,
  type FeedbackTrajectory as WireFeedbackTrajectory,
} from './schemas'

/** Caller-fixable error. The transport renders this to 4xx + ErrorResponse. */
export class WireError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'WireError'
  }
}

// ── judge ───────────────────────────────────────────────────────────

/** The JSON schema we ask the judging LLM to fill in. */
function judgeOutputSchema(rubric: Rubric) {
  return {
    name: 'JudgeOutput',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimensions: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            rubric.dimensions.map((d) => [
              d.id,
              { type: 'number', minimum: d.min, maximum: d.max },
            ]),
          ),
          required: rubric.dimensions.map((d) => d.id),
        },
        failureModes: {
          type: 'array',
          items: { type: 'string', enum: rubric.failureModes.map((f) => f.id) },
        },
        wins: {
          type: 'array',
          items: { type: 'string', enum: rubric.wins.map((w) => w.id) },
        },
        rationale: { type: 'string' },
      },
      required: ['dimensions', 'rationale'],
    } as Record<string, unknown>,
  }
}

interface JudgeOutput {
  dimensions: Record<string, number>
  failureModes?: string[]
  wins?: string[]
  rationale: string
}

function validateJudgeOutput(value: unknown, rubric: Rubric): JudgeOutput {
  if (!value || typeof value !== 'object') {
    throw new WireError('judge_error', 'Judge returned malformed output.', 500, value)
  }
  const raw = value as Record<string, unknown>
  const rawDimensions = raw.dimensions
  if (!rawDimensions || typeof rawDimensions !== 'object' || Array.isArray(rawDimensions)) {
    throw new WireError('judge_error', 'Judge returned malformed dimensions.', 500, value)
  }

  const dimensions: Record<string, number> = {}
  const dimensionRecord = rawDimensions as Record<string, unknown>
  for (const dim of rubric.dimensions) {
    const score = dimensionRecord[dim.id]
    if (
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < dim.min ||
      score > dim.max
    ) {
      throw new WireError(
        'judge_error',
        `Judge returned invalid score for dimension "${dim.id}".`,
        500,
        value,
      )
    }
    dimensions[dim.id] = score
  }

  const allowedFailures = new Set(rubric.failureModes.map((mode) => mode.id))
  const allowedWins = new Set(rubric.wins.map((win) => win.id))
  const failureModes = validateIdArray(raw.failureModes, allowedFailures, 'failureModes', value)
  const wins = validateIdArray(raw.wins, allowedWins, 'wins', value)
  if (typeof raw.rationale !== 'string' || raw.rationale.trim().length === 0) {
    throw new WireError('judge_error', 'Judge returned missing rationale.', 500, value)
  }

  return { dimensions, failureModes, wins, rationale: raw.rationale }
}

function validateIdArray(
  raw: unknown,
  allowed: Set<string>,
  field: 'failureModes' | 'wins',
  original: unknown,
): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new WireError('judge_error', `Judge returned non-array ${field}.`, 500, original)
  }
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !allowed.has(item)) {
      throw new WireError(
        'judge_error',
        `Judge returned unknown ${field} id "${String(item)}".`,
        500,
        original,
      )
    }
    out.push(item)
  }
  return out
}

function compositeScore(dimensions: Record<string, number>, rubric: Rubric): number {
  let weighted = 0
  let totalWeight = 0
  for (const dim of rubric.dimensions) {
    const raw = dimensions[dim.id] ?? 0
    const range = dim.max - dim.min || 1
    const normalized = Math.max(0, Math.min(1, (raw - dim.min) / range))
    weighted += normalized * dim.weight
    totalWeight += dim.weight
  }
  return totalWeight > 0 ? weighted / totalWeight : 0
}

function buildJudgePrompt(content: string, context: unknown): string {
  const ctx = context && Object.keys(context as object).length ? JSON.stringify(context) : ''
  return [
    `CONTENT TO JUDGE:`,
    content,
    '',
    ctx ? `CONTEXT (metadata, analytics, etc.):` : '',
    ctx ? ctx : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const DEFAULT_JUDGE_MODEL = 'claude-sonnet-4-6'

export interface HandleJudgeOptions {
  costLedger?: CostLedgerHandle
  costPhase?: string
  llm?: LlmClientOptions
  signal?: AbortSignal
}

export async function handleJudge(
  req: JudgeRequest,
  options: HandleJudgeOptions = {},
): Promise<JudgeResult> {
  // Resolve rubric
  let rubric: Rubric
  if (req.rubricName) {
    const found = getBuiltinRubric(req.rubricName)
    if (!found) {
      throw new WireError('rubric_not_found', `No built-in rubric named "${req.rubricName}".`, 404)
    }
    rubric = found
  } else if (req.rubric) {
    rubric = req.rubric
  } else {
    // refine() in the schema should already have caught this — defense in depth
    throw new WireError('validation_error', 'Provide either `rubricName` or `rubric`.', 422)
  }

  const startedAt = Date.now()
  const model = req.model ?? DEFAULT_JUDGE_MODEL

  const request = {
    model,
    messages: [
      { role: 'system', content: rubric.systemPrompt },
      { role: 'user', content: buildJudgePrompt(req.content, req.context) },
    ],
    jsonSchema: judgeOutputSchema(rubric),
    temperature: 0.0,
    maxTokens: 4_000,
    timeoutMs: 60_000,
  } satisfies LlmCallRequest
  const ledger = options.costLedger ?? new CostLedger()
  const paid = await ledger.runPaidCall({
    channel: 'judge',
    phase: options.costPhase ?? 'wire.judge',
    actor: `wire.${req.rubricName ?? 'inline'}`,
    model,
    maximumCharge: maximumChargeForLlmRequest(request, options.llm),
    signal: options.signal,
    execute: (signal, callId) =>
      callLlmJson<JudgeOutput>(request, {
        ...options.llm,
        signal,
        idempotencyKey: callId,
      }),
    receipt: ({ result }) => costReceiptFromLlm(result),
    receiptFromError: costReceiptFromLlmError,
  })
  if (!paid.succeeded) throw paid.error
  const { value, result } = paid.value

  const output = validateJudgeOutput(value, rubric)

  const composite = compositeScore(output.dimensions, rubric)
  const durationMs = Date.now() - startedAt

  return {
    composite,
    dimensions: output.dimensions,
    failureModes: output.failureModes ?? [],
    wins: output.wins ?? [],
    rationale: output.rationale,
    rubricVersion: hashRubric(rubric),
    model: result.model,
    durationMs,
  }
}

// ── listRubrics ─────────────────────────────────────────────────────

export function handleListRubrics(): ListRubricsResponse {
  return { rubrics: listBuiltinRubrics() }
}

// ── version ─────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let CACHED_VERSION: string | undefined

function readPackageVersion(): string {
  if (CACHED_VERSION) return CACHED_VERSION
  // Walk up from this file looking for the nearest package.json.
  // In dist/ this is dist/.., in src/wire/ this is ../../package.json.
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '..', '..', 'package.json'), // src/wire → repo root
    resolve(here, '..', 'package.json'), // dist → repo root
  ]
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { version?: string }
      if (pkg.version) {
        CACHED_VERSION = pkg.version
        return pkg.version
      }
    } catch {
      // try next
    }
  }
  return '0.0.0-unknown'
}

export function handleVersion(): VersionResponse {
  return {
    package: '@tangle-network/agent-eval',
    version: readPackageVersion(),
    wireVersion: WIRE_VERSION,
    apiSurface: ['judge', 'listRubrics', 'version', 'feedback.ingest', 'traces.ingest'],
  }
}

// ── Ingestion handlers ───────────────────────────────────────────────

/**
 * Pluggable stores the wire layer routes ingestion writes into. Both
 * are optional — when omitted, the corresponding endpoint returns 503.
 *
 * Production deployments wire a `FileSystemTraceStore` and
 * `FileSystemFeedbackTrajectoryStore` here. Tests substitute in-memory
 * stores.
 */
export interface IngestionStores {
  traceStore?: TraceStore
  feedbackStore?: FeedbackTrajectoryStore
}

/**
 * `POST /v1/traces/ingest` — accept a batch of `TraceEvent`s from the
 * production runtime. Best-effort: each event is appended independently;
 * one bad event does not poison the batch.
 *
 * Idempotency: the underlying store is append-only; consumers retrying
 * the same payload will get duplicate events. Consumers should
 * de-duplicate by `eventId` downstream — production traces frequently
 * land via at-least-once buses (Kafka, SQS) where dedup is unavoidable.
 */
export async function handleTracesIngest(
  req: TracesIngestRequest,
  stores: IngestionStores,
): Promise<TracesIngestResponse> {
  if (!stores.traceStore) {
    throw new WireError(
      'service_unavailable',
      'No trace store configured on this server. Pass `traceStore` to `createApp`.',
      503,
    )
  }
  const errors: Array<{ eventId: string; message: string }> = []
  let accepted = 0
  for (const event of req.events) {
    try {
      // The wire `TraceEvent` is structurally identical to the internal one.
      await stores.traceStore.appendEvent(event as InternalTraceEvent)
      accepted++
    } catch (err) {
      errors.push({
        eventId: event.eventId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { accepted, rejected: errors.length, errors }
}

/**
 * `POST /v1/feedback` — accept a single `FeedbackTrajectory` from the
 * production runtime. Idempotent on `id`: re-posting the same trajectory
 * replaces the prior record.
 */
export async function handleFeedbackIngest(
  req: WireFeedbackTrajectory,
  stores: IngestionStores,
): Promise<FeedbackIngestResponse> {
  if (!stores.feedbackStore) {
    throw new WireError(
      'service_unavailable',
      'No feedback store configured on this server. Pass `feedbackStore` to `createApp`.',
      503,
    )
  }
  // The wire `FeedbackTrajectory` aligns 1:1 with the internal type;
  // cast through `unknown` since the wire schema is a Zod-inferred
  // structural type with optional fields the internal store consumes.
  await stores.feedbackStore.save(req as unknown as Parameters<FeedbackTrajectoryStore['save']>[0])
  return { id: req.id, persisted: true }
}
