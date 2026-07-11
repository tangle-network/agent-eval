/**
 * Durable append-only audit log for improvement searches.
 *
 * Existing campaign artifacts keep their own rich records: `RunRecord` owns a
 * measured run, `Lineage` owns the candidate graph, and `CostLedger` owns
 * per-call accounting. This ledger does not copy those structures. It binds
 * their immutable ids and receipts into one replayable event stream so a
 * search can answer, after a crash, exactly which candidates and task attempts
 * existed, which surfaces actually fired, what they cost, and why they were
 * selected or rejected.
 *
 * The file format is canonical JSONL with a SHA-256 hash chain. Every append is
 * serialized across processes, fsynced before acknowledgement, and idempotent
 * by `eventId`. A malformed, non-canonical, truncated, reordered, or conflicting
 * log fails loudly; the implementation never skips a bad row.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { Mutex } from '../concurrency'
import { canonicalize } from '../pre-registration'
import { modelHasSnapshot } from '../run-record'
import {
  SearchLedgerConflictError,
  SearchLedgerError,
  SearchLedgerIntegrityError,
} from './search-ledger-errors'
import { appendSearchLedgerLine, withSearchLedgerFileLock } from './search-ledger-file'

export { SearchLedgerConflictError, SearchLedgerError, SearchLedgerIntegrityError }

export const SEARCH_LEDGER_SCHEMA = 'tangle.search-ledger.v1' as const

export type SearchLedgerHash = `sha256:${string}`

export type SearchSurfaceKind =
  | 'prompt'
  | 'tool-contract'
  | 'runtime-config'
  | 'memory'
  | 'knowledge'
  | 'agent-profile'
  | 'code'
  | 'deployment'

/** Content-addressed artifact or receipt. Mutable paths are locators only; the
 * digest and byte length bind the exact bytes used by the search. */
export interface SearchArtifactRef {
  role: string
  uri: string
  sha256: SearchLedgerHash
  byteLength: number
}

/** Repository, dataset, or package source pinned to an immutable commit or
 * content digest. Branches, tags, and bare package versions are rejected. */
export interface SearchSourceRef {
  uri: string
  revision: string
}

export interface SearchModelIdentity {
  provider: string
  snapshot: string
}

export interface SearchCandidateSurface {
  surfaceId: string
  kind: SearchSurfaceKind
  artifact: SearchArtifactRef
}

export interface SearchCandidateLineage {
  /** Existing `LineageNode.id`; this ledger references rather than embeds it. */
  lineageNodeId: string
  parentCandidateIds: string[]
  generation: number
  proposer: string
  proposerSource: SearchSourceRef
}

export type SearchOperationKind =
  | 'candidate-generation'
  | 'analysis'
  | 'selection'
  | 'judge'
  | 'other'

export interface SearchPlannedTask {
  taskId: string
  source: SearchSourceRef
  benchmark: SearchSourceRef
  /** Maximum transport attempts for this task and candidate. Only an explicit
   * passed/failed outcome satisfies the planned denominator. */
  maxAttempts: number
}

export interface SearchPlannedOperation {
  operationId: string
  kind: SearchOperationKind
}

export interface SearchCandidateSlot {
  slotId: string
  /** Planned candidate-generation call that must either produce this slot or
   * fail before the slot can be closed. Several slots may share one batched call. */
  generationOperationId: string
}

export interface SearchPlan {
  /** Stable slots and their proposer calls are frozen before search begins. */
  candidateSlots: SearchCandidateSlot[]
  /** Every task applies to every successfully registered candidate. */
  tasks: SearchPlannedTask[]
  /** Non-task spend slots: proposal, analysis, selection, extra judges, etc. */
  operations: SearchPlannedOperation[]
}

export type SearchTokenAccounting =
  | {
      status: 'known'
      inputTokens: number
      outputTokens: number
      cachedTokens: number
    }
  | {
      status: 'unknown'
      reason: string
    }

export type SearchCostAccounting =
  | {
      status: 'known'
      usd: number
      source: 'provider' | 'pricing-table' | 'free'
    }
  | {
      status: 'unknown'
      /** Known spend may still be a lower bound when one call was unpriced. */
      knownLowerBoundUsd: number
      reason: string
    }

export interface SearchAttemptAccounting {
  tokens: SearchTokenAccounting
  cost: SearchCostAccounting
}

export interface SearchFailureReason {
  code: string
  message: string
}

export type SearchTaskOutcome =
  | {
      status: 'passed'
      score: number
      metrics: Record<string, number>
    }
  | {
      status: 'failed'
      score: number
      metrics: Record<string, number>
      failure: SearchFailureReason
    }
  | {
      status: 'errored'
      metrics: Record<string, number>
      error: SearchFailureReason & { retryable: boolean }
    }

export type SearchSurfaceEffect =
  | {
      status: 'measured'
      metric: string
      baselineValue: number
      candidateValue: number
      delta: number
    }
  | {
      status: 'not-measured'
      reason: string
    }

/** Per-attempt proof that a declared candidate surface was or was not active,
 * plus measured effect when the experiment supports attribution. */
export interface SearchSurfaceEvidence {
  surfaceId: string
  fired: boolean
  firingCount: number
  effect: SearchSurfaceEffect
  evidence: SearchArtifactRef[]
}

interface SearchLedgerEventBase {
  eventId: string
  occurredAt: string
  artifacts: SearchArtifactRef[]
}

export interface SearchPlannedEvent extends SearchLedgerEventBase {
  kind: 'search-planned'
  plan: SearchPlan
}

export interface SearchCandidateRegisteredEvent extends SearchLedgerEventBase {
  kind: 'candidate-registered'
  slotId: string
  generationOperationId: string
  candidateId: string
  lineage: SearchCandidateLineage
  surfaces: SearchCandidateSurface[]
}

export interface SearchCandidateSlotClosedEvent extends SearchLedgerEventBase {
  kind: 'candidate-slot-closed'
  slotId: string
  generationOperationId: string
  reason: SearchFailureReason
}

export interface SearchTaskAttemptedEvent extends SearchLedgerEventBase {
  kind: 'task-attempted'
  candidateId: string
  runId: string
  attemptIndex: number
  task: {
    taskId: string
    source: SearchSourceRef
  }
  identity: {
    model: SearchModelIdentity
    agent: SearchSourceRef
    benchmark: SearchSourceRef
  }
  outcome: SearchTaskOutcome
  accounting: SearchAttemptAccounting
  surfaceEvidence: SearchSurfaceEvidence[]
}

export interface SearchOperationRecordedEvent extends SearchLedgerEventBase {
  kind: 'search-operation-recorded'
  operationId: string
  operationKind: SearchOperationKind
  execution:
    | {
        kind: 'model'
        model: SearchModelIdentity
        source: SearchSourceRef
      }
    | {
        kind: 'deterministic'
        source: SearchSourceRef
      }
  outcome: { status: 'completed' } | { status: 'failed'; failure: SearchFailureReason }
  accounting: SearchAttemptAccounting
}

export interface SearchCandidateDecidedEvent extends SearchLedgerEventBase {
  kind: 'candidate-decided'
  candidateId: string
  decision:
    | { status: 'selected' }
    | {
        status: 'rejected'
        reason: SearchFailureReason
      }
}

export interface SearchCompletedEvent extends SearchLedgerEventBase {
  kind: 'search-completed'
  result:
    | {
        status: 'selected'
        candidateId: string
      }
    | {
        status: 'all-rejected'
        reason: SearchFailureReason
      }
}

export type SearchLedgerEvent =
  | SearchPlannedEvent
  | SearchCandidateRegisteredEvent
  | SearchCandidateSlotClosedEvent
  | SearchTaskAttemptedEvent
  | SearchOperationRecordedEvent
  | SearchCandidateDecidedEvent
  | SearchCompletedEvent

export interface SearchLedgerEntry {
  schema: typeof SEARCH_LEDGER_SCHEMA
  campaignId: string
  sequence: number
  previousHash: SearchLedgerHash | null
  event: SearchLedgerEvent
  entryHash: SearchLedgerHash
}

export type SearchAccountingAudit =
  | {
      status: 'known'
      inputTokens: number
      outputTokens: number
      cachedTokens: number
      costUsd: number
    }
  | {
      status: 'partial'
      knownInputTokens: number
      knownOutputTokens: number
      knownCachedTokens: number
      knownCostUsd: number
      unknownTokenEventIds: string[]
      unknownCostEventIds: string[]
    }

export interface SearchLedgerAudit {
  campaignId: string
  eventCount: number
  candidateCount: number
  closedCandidateSlotCount: number
  attemptCount: number
  operationCount: number
  outcomes: { passed: number; failed: number; errored: number }
  operationOutcomes: { completed: number; failed: number }
  decisions: { selected: number; rejected: number; pending: number }
  expected: {
    candidateSlots: number
    taskOutcomes: number
    operations: number
    missingCandidateSlots: string[]
    missingTaskOutcomes: string[]
    missingOperations: string[]
  }
  status: 'in-progress' | 'selected' | 'all-rejected'
  selectedCandidateId: string | null
  accounting: SearchAccountingAudit
  headHash: SearchLedgerHash | null
}

export interface SearchLedgerReplay {
  entries: SearchLedgerEntry[]
  plan: SearchPlannedEvent | null
  candidates: SearchCandidateRegisteredEvent[]
  closedCandidateSlots: SearchCandidateSlotClosedEvent[]
  attempts: SearchTaskAttemptedEvent[]
  operations: SearchOperationRecordedEvent[]
  decisions: SearchCandidateDecidedEvent[]
  completion: SearchCompletedEvent | null
  audit: SearchLedgerAudit
}

export interface SearchLedgerAppendResult {
  entry: SearchLedgerEntry
  /** False when the exact event was already durably present. */
  appended: boolean
  replay: SearchLedgerReplay
}

const NON_EMPTY = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must not contain surrounding whitespace')
const HASH = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const LINEAGE_NODE_ID = z.string().regex(/^[a-f0-9]{16}$/)
const IMMUTABLE_REVISION = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64}|sha512:[A-Za-z0-9+/=]+)$/)
const ISO_TIMESTAMP = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp')
const NON_NEGATIVE_INT = z.number().int().nonnegative().safe()
const FINITE_NUMBER = z.number().finite()

const ArtifactRefSchema = z
  .object({
    role: NON_EMPTY,
    uri: NON_EMPTY,
    sha256: HASH,
    byteLength: NON_NEGATIVE_INT,
  })
  .strict()

const SourceRefSchema = z
  .object({
    uri: NON_EMPTY,
    revision: IMMUTABLE_REVISION,
  })
  .strict()

const FailureReasonSchema = z
  .object({
    code: NON_EMPTY,
    message: NON_EMPTY,
  })
  .strict()

const EventBaseShape = {
  eventId: NON_EMPTY,
  occurredAt: ISO_TIMESTAMP,
  artifacts: z.array(ArtifactRefSchema).min(1),
}

const OperationKindSchema = z.enum([
  'candidate-generation',
  'analysis',
  'selection',
  'judge',
  'other',
])

const SearchPlannedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('search-planned'),
    plan: z
      .object({
        candidateSlots: z
          .array(
            z
              .object({
                slotId: NON_EMPTY,
                generationOperationId: NON_EMPTY,
              })
              .strict(),
          )
          .min(1),
        tasks: z
          .array(
            z
              .object({
                taskId: NON_EMPTY,
                source: SourceRefSchema,
                benchmark: SourceRefSchema,
                maxAttempts: z.number().int().positive().safe(),
              })
              .strict(),
          )
          .min(1),
        operations: z
          .array(
            z
              .object({
                operationId: NON_EMPTY,
                kind: OperationKindSchema,
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  })
  .strict()

const CandidateRegisteredSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('candidate-registered'),
    slotId: NON_EMPTY,
    generationOperationId: NON_EMPTY,
    candidateId: NON_EMPTY,
    lineage: z
      .object({
        lineageNodeId: LINEAGE_NODE_ID,
        parentCandidateIds: z.array(NON_EMPTY),
        generation: NON_NEGATIVE_INT,
        proposer: NON_EMPTY,
        proposerSource: SourceRefSchema,
      })
      .strict(),
    surfaces: z
      .array(
        z
          .object({
            surfaceId: NON_EMPTY,
            kind: z.enum([
              'prompt',
              'tool-contract',
              'runtime-config',
              'memory',
              'knowledge',
              'agent-profile',
              'code',
              'deployment',
            ]),
            artifact: ArtifactRefSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()

const CandidateSlotClosedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('candidate-slot-closed'),
    slotId: NON_EMPTY,
    generationOperationId: NON_EMPTY,
    reason: FailureReasonSchema,
  })
  .strict()

const KnownTokensSchema = z
  .object({
    status: z.literal('known'),
    inputTokens: NON_NEGATIVE_INT,
    outputTokens: NON_NEGATIVE_INT,
    cachedTokens: NON_NEGATIVE_INT,
  })
  .strict()

const UnknownSchema = z
  .object({
    status: z.literal('unknown'),
    reason: NON_EMPTY,
  })
  .strict()

const KnownCostSchema = z
  .object({
    status: z.literal('known'),
    usd: z.number().finite().nonnegative(),
    source: z.enum(['provider', 'pricing-table', 'free']),
  })
  .strict()
  .superRefine((cost, ctx) => {
    if (cost.source === 'free' && cost.usd !== 0) {
      ctx.addIssue({ code: 'custom', message: 'free cost source must have usd 0' })
    }
  })

const UnknownCostSchema = z
  .object({
    status: z.literal('unknown'),
    knownLowerBoundUsd: z.number().finite().nonnegative(),
    reason: NON_EMPTY,
  })
  .strict()

const AccountingSchema = z
  .object({
    tokens: z.discriminatedUnion('status', [KnownTokensSchema, UnknownSchema]),
    cost: z.discriminatedUnion('status', [KnownCostSchema, UnknownCostSchema]),
  })
  .strict()

const MetricsSchema = z.record(NON_EMPTY, FINITE_NUMBER).superRefine((metrics, ctx) => {
  for (const key of Object.keys(metrics)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      ctx.addIssue({ code: 'custom', message: `unsafe metric key ${key}` })
    }
  }
})

const OutcomeSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('passed'),
      score: FINITE_NUMBER,
      metrics: MetricsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      score: FINITE_NUMBER,
      metrics: MetricsSchema,
      failure: FailureReasonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('errored'),
      metrics: MetricsSchema,
      error: FailureReasonSchema.extend({ retryable: z.boolean() }).strict(),
    })
    .strict(),
])

const EffectSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('measured'),
      metric: NON_EMPTY,
      baselineValue: FINITE_NUMBER,
      candidateValue: FINITE_NUMBER,
      delta: FINITE_NUMBER,
    })
    .strict()
    .superRefine((effect, ctx) => {
      const expected = effect.candidateValue - effect.baselineValue
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(expected), Math.abs(effect.delta)) * 8
      if (Math.abs(effect.delta - expected) > tolerance) {
        ctx.addIssue({ code: 'custom', message: 'delta must equal candidateValue - baselineValue' })
      }
    }),
  z
    .object({
      status: z.literal('not-measured'),
      reason: NON_EMPTY,
    })
    .strict(),
])

const SurfaceEvidenceSchema = z
  .object({
    surfaceId: NON_EMPTY,
    fired: z.boolean(),
    firingCount: NON_NEGATIVE_INT,
    effect: EffectSchema,
    evidence: z.array(ArtifactRefSchema).min(1),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.fired && evidence.firingCount === 0) {
      ctx.addIssue({ code: 'custom', message: 'a fired surface must have firingCount >= 1' })
    }
    if (!evidence.fired && evidence.firingCount !== 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a surface that did not fire must have firingCount 0',
      })
    }
    if (!evidence.fired && evidence.effect.status === 'measured' && evidence.effect.delta !== 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a surface that did not fire cannot claim non-zero effect',
      })
    }
  })

const TaskAttemptedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('task-attempted'),
    candidateId: NON_EMPTY,
    runId: NON_EMPTY,
    attemptIndex: NON_NEGATIVE_INT,
    task: z.object({ taskId: NON_EMPTY, source: SourceRefSchema }).strict(),
    identity: z
      .object({
        model: z
          .object({
            provider: NON_EMPTY,
            snapshot: NON_EMPTY.refine(
              modelHasSnapshot,
              'model must include an immutable snapshot',
            ),
          })
          .strict(),
        agent: SourceRefSchema,
        benchmark: SourceRefSchema,
      })
      .strict(),
    outcome: OutcomeSchema,
    accounting: AccountingSchema,
    surfaceEvidence: z.array(SurfaceEvidenceSchema).min(1),
  })
  .strict()

const SearchOperationRecordedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('search-operation-recorded'),
    operationId: NON_EMPTY,
    operationKind: OperationKindSchema,
    execution: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('model'),
          model: z
            .object({
              provider: NON_EMPTY,
              snapshot: NON_EMPTY.refine(
                modelHasSnapshot,
                'model must include an immutable snapshot',
              ),
            })
            .strict(),
          source: SourceRefSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('deterministic'),
          source: SourceRefSchema,
        })
        .strict(),
    ]),
    outcome: z.discriminatedUnion('status', [
      z.object({ status: z.literal('completed') }).strict(),
      z
        .object({
          status: z.literal('failed'),
          failure: FailureReasonSchema,
        })
        .strict(),
    ]),
    accounting: AccountingSchema,
  })
  .strict()

const CandidateDecidedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('candidate-decided'),
    candidateId: NON_EMPTY,
    decision: z.discriminatedUnion('status', [
      z.object({ status: z.literal('selected') }).strict(),
      z
        .object({
          status: z.literal('rejected'),
          reason: FailureReasonSchema,
        })
        .strict(),
    ]),
  })
  .strict()

const SearchCompletedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('search-completed'),
    result: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('selected'),
          candidateId: NON_EMPTY,
        })
        .strict(),
      z
        .object({
          status: z.literal('all-rejected'),
          reason: FailureReasonSchema,
        })
        .strict(),
    ]),
  })
  .strict()

const EventSchema = z.discriminatedUnion('kind', [
  SearchPlannedSchema,
  CandidateRegisteredSchema,
  CandidateSlotClosedSchema,
  TaskAttemptedSchema,
  SearchOperationRecordedSchema,
  CandidateDecidedSchema,
  SearchCompletedSchema,
])

const EntrySchema = z
  .object({
    schema: z.literal(SEARCH_LEDGER_SCHEMA),
    campaignId: NON_EMPTY,
    sequence: NON_NEGATIVE_INT,
    previousHash: z.union([HASH, z.null()]),
    event: EventSchema,
    entryHash: HASH,
  })
  .strict()

/** Validate and return a canonical copy. Arrays whose order is not semantic are
 * sorted so retries from different processes produce byte-identical events. */
export function validateSearchLedgerEvent(input: unknown): SearchLedgerEvent {
  const parsed = EventSchema.safeParse(input)
  if (!parsed.success) {
    throw new SearchLedgerError(`invalid search ledger event: ${formatZodError(parsed.error)}`)
  }
  return normalizeEvent(parsed.data as SearchLedgerEvent)
}

export interface OpenSearchLedgerOptions {
  path: string
  campaignId: string
}

export interface SearchLedger {
  readonly path: string
  readonly campaignId: string
  append(event: SearchLedgerEvent): Promise<SearchLedgerAppendResult>
  replay(): Promise<SearchLedgerReplay>
}

/** Open a durable filesystem search ledger. Construction performs no I/O; the
 * first `append` or `replay` validates the complete existing file. */
export function openSearchLedger(options: OpenSearchLedgerOptions): SearchLedger {
  if (options.path.trim().length === 0) throw new SearchLedgerError('ledger path is empty')
  return new FileSearchLedger(options.path, options.campaignId)
}

const ledgerMutexes = new Map<string, Mutex>()

function mutexFor(path: string): Mutex {
  const existing = ledgerMutexes.get(path)
  if (existing) return existing
  const mutex = new Mutex()
  ledgerMutexes.set(path, mutex)
  return mutex
}

export class FileSearchLedger implements SearchLedger {
  readonly path: string
  readonly campaignId: string
  private readonly mutex: Mutex

  constructor(path: string, campaignId: string) {
    if (path.trim().length === 0) throw new SearchLedgerError('ledger path is empty')
    if (campaignId.length === 0) throw new SearchLedgerError('campaignId is empty')
    if (campaignId.trim() !== campaignId) {
      throw new SearchLedgerError('campaignId must not contain surrounding whitespace')
    }
    this.path = resolve(path)
    this.campaignId = campaignId
    this.mutex = mutexFor(this.path)
  }

  async replay(): Promise<SearchLedgerReplay> {
    return this.mutex.runExclusive(() =>
      withSearchLedgerFileLock(this.path, () => replayFile(this.path, this.campaignId)),
    )
  }

  async append(input: SearchLedgerEvent): Promise<SearchLedgerAppendResult> {
    const event = validateSearchLedgerEvent(input)
    return this.mutex.runExclusive(() =>
      withSearchLedgerFileLock(this.path, () => {
        const before = replayFile(this.path, this.campaignId)
        const existing = before.entries.find((entry) => entry.event.eventId === event.eventId)
        if (existing) {
          if (canonicalString(existing.event) !== canonicalString(event)) {
            throw new SearchLedgerConflictError(
              `eventId ${event.eventId} already exists with different content`,
            )
          }
          return { entry: existing, appended: false, replay: before }
        }

        const previousHash = before.audit.headHash
        const material = {
          schema: SEARCH_LEDGER_SCHEMA,
          campaignId: this.campaignId,
          sequence: before.entries.length,
          previousHash,
          event,
        } as const
        const entry: SearchLedgerEntry = {
          ...material,
          entryHash: hashCanonical(material),
        }

        // Apply the state transition before spending an append. This catches
        // unknown parents, missing task attempts, duplicate decisions, and
        // invalid completion records without touching the durable file.
        const replay = replayEntries([...before.entries, entry], this.campaignId)
        appendSearchLedgerLine(this.path, `${canonicalString(entry)}\n`)
        return { entry, appended: true, replay }
      }),
    )
  }
}

function replayFile(path: string, campaignId: string): SearchLedgerReplay {
  if (!existsSync(path)) return replayEntries([], campaignId)
  const text = readFileSync(path, 'utf8')
  if (text.length === 0) return replayEntries([], campaignId)
  if (!text.endsWith('\n')) {
    throw new SearchLedgerIntegrityError(
      `search ledger ${path} has a truncated final record (missing newline)`,
    )
  }

  const lines = text.slice(0, -1).split('\n')
  const entries: SearchLedgerEntry[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.length === 0) {
      throw new SearchLedgerIntegrityError(
        `search ledger ${path} has a blank row at line ${index + 1}`,
      )
    }
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw new SearchLedgerIntegrityError(
        `search ledger ${path} has invalid JSON at line ${index + 1}`,
        { cause: error },
      )
    }
    const parsed = EntrySchema.safeParse(raw)
    if (!parsed.success) {
      throw new SearchLedgerIntegrityError(
        `search ledger ${path} has a malformed entry at line ${index + 1}: ${formatZodError(parsed.error)}`,
      )
    }
    const entry = parsed.data as SearchLedgerEntry
    const normalizedEvent = validateSearchLedgerEvent(entry.event)
    if (canonicalString(normalizedEvent) !== canonicalString(entry.event)) {
      throw new SearchLedgerIntegrityError(
        `search ledger ${path} has non-canonical event ordering at line ${index + 1}`,
      )
    }
    if (line !== canonicalString(entry)) {
      throw new SearchLedgerIntegrityError(
        `search ledger ${path} has non-canonical bytes at line ${index + 1}`,
      )
    }
    entries.push(entry)
  }
  return replayEntries(entries, campaignId)
}

interface CandidateState {
  registered: SearchCandidateRegisteredEvent
  attempts: SearchTaskAttemptedEvent[]
  decision: SearchCandidateDecidedEvent | null
}

function replayEntries(entries: SearchLedgerEntry[], campaignId: string): SearchLedgerReplay {
  const candidates = new Map<string, CandidateState>()
  const candidateBySlot = new Map<string, string>()
  const closedSlots = new Map<string, SearchCandidateSlotClosedEvent>()
  const lineageNodes = new Map<string, string>()
  const eventIds = new Set<string>()
  const runIds = new Set<string>()
  const attemptKeys = new Set<string>()
  const candidateEvents: SearchCandidateRegisteredEvent[] = []
  const closedSlotEvents: SearchCandidateSlotClosedEvent[] = []
  const attempts: SearchTaskAttemptedEvent[] = []
  const operationEvents: SearchOperationRecordedEvent[] = []
  const operationsById = new Map<string, SearchOperationRecordedEvent>()
  const decisions: SearchCandidateDecidedEvent[] = []
  let planEvent: SearchPlannedEvent | null = null
  let completion: SearchCompletedEvent | null = null
  let expectedPrevious: SearchLedgerHash | null = null
  let previousOccurredAt = Number.NEGATIVE_INFINITY

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.campaignId !== campaignId) {
      throw new SearchLedgerIntegrityError(
        `entry ${index} belongs to campaign ${entry.campaignId}, expected ${campaignId}`,
      )
    }
    if (entry.sequence !== index) {
      throw new SearchLedgerIntegrityError(
        `entry ${entry.event.eventId} has sequence ${entry.sequence}, expected ${index}`,
      )
    }
    if (entry.previousHash !== expectedPrevious) {
      throw new SearchLedgerIntegrityError(
        `entry ${entry.event.eventId} does not extend the previous hash`,
      )
    }
    const { entryHash: _entryHash, ...material } = entry
    const expectedHash = hashCanonical(material)
    if (entry.entryHash !== expectedHash) {
      throw new SearchLedgerIntegrityError(
        `entry ${entry.event.eventId} hash mismatch: expected ${expectedHash}, got ${entry.entryHash}`,
      )
    }
    expectedPrevious = entry.entryHash

    const event = entry.event
    if (eventIds.has(event.eventId)) {
      throw new SearchLedgerIntegrityError(`duplicate eventId ${event.eventId} in durable ledger`)
    }
    eventIds.add(event.eventId)
    if (completion) {
      throw new SearchLedgerIntegrityError(
        `event ${event.eventId} appears after terminal event ${completion.eventId}`,
      )
    }
    const occurredAt = Date.parse(event.occurredAt)
    if (occurredAt < previousOccurredAt) {
      throw new SearchLedgerIntegrityError(
        `event ${event.eventId} occurred before the preceding durable event`,
      )
    }
    previousOccurredAt = occurredAt
    assertUnique(event.artifacts.map(artifactKey), 'artifact receipt', event.eventId)

    if (event.kind === 'search-planned') {
      if (index !== 0 || planEvent) {
        throw new SearchLedgerIntegrityError('search plan must be the first and only plan event')
      }
      assertUnique(
        event.plan.candidateSlots.map((slot) => slot.slotId),
        'candidate slot',
        event.eventId,
      )
      assertUnique(
        event.plan.tasks.map((task) => task.taskId),
        'planned taskId',
        event.eventId,
      )
      assertUnique(
        event.plan.operations.map((operation) => operation.operationId),
        'planned operationId',
        event.eventId,
      )
      for (const slot of event.plan.candidateSlots) {
        const generationOperation = event.plan.operations.find(
          (operation) => operation.operationId === slot.generationOperationId,
        )
        if (!generationOperation || generationOperation.kind !== 'candidate-generation') {
          throw new SearchLedgerIntegrityError(
            `candidate slot ${slot.slotId} references unplanned candidate-generation operation ${slot.generationOperationId}`,
          )
        }
      }
      planEvent = event
      continue
    }

    if (!planEvent) {
      throw new SearchLedgerIntegrityError(
        `event ${event.eventId} appears before the required search plan`,
      )
    }

    if (event.kind === 'candidate-registered') {
      if (candidates.has(event.candidateId)) {
        throw new SearchLedgerIntegrityError(`candidate ${event.candidateId} was registered twice`)
      }
      const plannedSlot = planEvent.plan.candidateSlots.find((slot) => slot.slotId === event.slotId)
      if (!plannedSlot) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} binds unknown slot ${event.slotId}`,
        )
      }
      if (candidateBySlot.has(event.slotId)) {
        throw new SearchLedgerIntegrityError(`candidate slot ${event.slotId} was bound twice`)
      }
      if (closedSlots.has(event.slotId)) {
        throw new SearchLedgerIntegrityError(`candidate slot ${event.slotId} was already closed`)
      }
      if (event.generationOperationId !== plannedSlot.generationOperationId) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} generation operation ${event.generationOperationId} does not match slot ${event.slotId} plan ${plannedSlot.generationOperationId}`,
        )
      }
      const generationOperation = operationsById.get(event.generationOperationId)
      if (!generationOperation) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} precedes generation operation ${event.generationOperationId}`,
        )
      }
      if (generationOperation.outcome.status !== 'completed') {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} cannot bind failed generation operation ${event.generationOperationId}`,
        )
      }
      const previousCandidate = lineageNodes.get(event.lineage.lineageNodeId)
      if (previousCandidate) {
        throw new SearchLedgerIntegrityError(
          `lineage node ${event.lineage.lineageNodeId} is already bound to ${previousCandidate}`,
        )
      }
      assertUnique(event.lineage.parentCandidateIds, 'parentCandidateId', event.eventId)
      const parents = event.lineage.parentCandidateIds.map((id) => {
        const parent = candidates.get(id)
        if (!parent) {
          throw new SearchLedgerIntegrityError(
            `candidate ${event.candidateId} references unknown parent ${id}`,
          )
        }
        return parent
      })
      const expectedGeneration =
        parents.length === 0
          ? 0
          : Math.max(...parents.map((parent) => parent.registered.lineage.generation)) + 1
      if (event.lineage.generation !== expectedGeneration) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} generation ${event.lineage.generation} does not follow its parents (expected ${expectedGeneration})`,
        )
      }
      assertUnique(
        event.surfaces.map((surface) => surface.surfaceId),
        'surfaceId',
        event.eventId,
      )
      candidates.set(event.candidateId, { registered: event, attempts: [], decision: null })
      candidateBySlot.set(event.slotId, event.candidateId)
      lineageNodes.set(event.lineage.lineageNodeId, event.candidateId)
      candidateEvents.push(event)
      continue
    }

    if (event.kind === 'task-attempted') {
      const candidate = candidates.get(event.candidateId)
      if (!candidate) {
        throw new SearchLedgerIntegrityError(
          `attempt ${event.eventId} references unknown candidate ${event.candidateId}`,
        )
      }
      if (candidate.decision) {
        throw new SearchLedgerIntegrityError(
          `attempt ${event.eventId} appears after candidate ${event.candidateId} was decided`,
        )
      }
      const plannedTask = planEvent.plan.tasks.find((task) => task.taskId === event.task.taskId)
      if (!plannedTask) {
        throw new SearchLedgerIntegrityError(
          `attempt ${event.eventId} references unplanned task ${event.task.taskId}`,
        )
      }
      if (
        canonicalString(plannedTask.source) !== canonicalString(event.task.source) ||
        canonicalString(plannedTask.benchmark) !== canonicalString(event.identity.benchmark)
      ) {
        throw new SearchLedgerIntegrityError(
          `task ${event.task.taskId} does not match its planned source identity`,
        )
      }
      if (event.attemptIndex >= plannedTask.maxAttempts) {
        throw new SearchLedgerIntegrityError(
          `task ${event.task.taskId} attempt ${event.attemptIndex} exceeds planned maxAttempts ${plannedTask.maxAttempts}`,
        )
      }
      if (runIds.has(event.runId)) {
        throw new SearchLedgerIntegrityError(`runId ${event.runId} was recorded twice`)
      }
      runIds.add(event.runId)
      const attemptKey = canonicalString([event.candidateId, event.task.taskId, event.attemptIndex])
      if (attemptKeys.has(attemptKey)) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} task ${event.task.taskId} attempt ${event.attemptIndex} was recorded twice`,
        )
      }
      const expectedAttemptIndex = candidate.attempts.filter(
        (attempt) => attempt.task.taskId === event.task.taskId,
      ).length
      if (event.attemptIndex !== expectedAttemptIndex) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} task ${event.task.taskId} attempt index ${event.attemptIndex} is not contiguous (expected ${expectedAttemptIndex})`,
        )
      }
      const previousAttempt = candidate.attempts.find(
        (attempt) => attempt.task.taskId === event.task.taskId,
      )
      if (
        previousAttempt?.outcome.status !== undefined &&
        previousAttempt.outcome.status !== 'errored'
      ) {
        throw new SearchLedgerIntegrityError(
          `task ${event.task.taskId} was retried after a measured outcome`,
        )
      }
      if (
        previousAttempt &&
        canonicalString({ task: previousAttempt.task, identity: previousAttempt.identity }) !==
          canonicalString({ task: event.task, identity: event.identity })
      ) {
        throw new SearchLedgerIntegrityError(
          `candidate ${event.candidateId} task ${event.task.taskId} changed immutable execution identity between attempts`,
        )
      }
      attemptKeys.add(attemptKey)

      const declared = candidate.registered.surfaces.map((surface) => surface.surfaceId).sort()
      const observed = event.surfaceEvidence.map((surface) => surface.surfaceId).sort()
      assertUnique(observed, 'surface evidence', event.eventId)
      for (const evidence of event.surfaceEvidence) {
        assertUnique(evidence.evidence.map(artifactKey), 'surface evidence receipt', event.eventId)
      }
      if (canonicalString(declared) !== canonicalString(observed)) {
        throw new SearchLedgerIntegrityError(
          `attempt ${event.eventId} surface evidence does not exactly cover candidate ${event.candidateId}`,
        )
      }
      candidate.attempts.push(event)
      attempts.push(event)
      continue
    }

    if (event.kind === 'search-operation-recorded') {
      const plannedOperation = planEvent.plan.operations.find(
        (operation) => operation.operationId === event.operationId,
      )
      if (!plannedOperation) {
        throw new SearchLedgerIntegrityError(
          `operation ${event.operationId} was not declared in the search plan`,
        )
      }
      if (plannedOperation.kind !== event.operationKind) {
        throw new SearchLedgerIntegrityError(
          `operation ${event.operationId} kind ${event.operationKind} does not match planned ${plannedOperation.kind}`,
        )
      }
      if (operationsById.has(event.operationId)) {
        throw new SearchLedgerIntegrityError(`operation ${event.operationId} was recorded twice`)
      }
      operationsById.set(event.operationId, event)
      operationEvents.push(event)
      continue
    }

    if (event.kind === 'candidate-slot-closed') {
      const plannedSlot = planEvent.plan.candidateSlots.find((slot) => slot.slotId === event.slotId)
      if (!plannedSlot) {
        throw new SearchLedgerIntegrityError(
          `candidate slot closure ${event.eventId} references unknown slot ${event.slotId}`,
        )
      }
      if (event.generationOperationId !== plannedSlot.generationOperationId) {
        throw new SearchLedgerIntegrityError(
          `candidate slot closure ${event.eventId} generation operation ${event.generationOperationId} does not match slot ${event.slotId} plan ${plannedSlot.generationOperationId}`,
        )
      }
      if (candidateBySlot.has(event.slotId)) {
        throw new SearchLedgerIntegrityError(
          `candidate slot ${event.slotId} was already bound to a candidate`,
        )
      }
      if (closedSlots.has(event.slotId)) {
        throw new SearchLedgerIntegrityError(`candidate slot ${event.slotId} was closed twice`)
      }
      const operation = operationsById.get(event.generationOperationId)
      if (!operation) {
        throw new SearchLedgerIntegrityError(
          `candidate slot closure ${event.eventId} precedes operation ${event.generationOperationId}`,
        )
      }
      if (operation.outcome.status !== 'failed') {
        throw new SearchLedgerIntegrityError(
          `candidate slot ${event.slotId} cannot close from completed operation ${event.generationOperationId}`,
        )
      }
      closedSlots.set(event.slotId, event)
      closedSlotEvents.push(event)
      continue
    }

    if (event.kind === 'candidate-decided') {
      const candidate = candidates.get(event.candidateId)
      if (!candidate) {
        throw new SearchLedgerIntegrityError(
          `decision ${event.eventId} references unknown candidate ${event.candidateId}`,
        )
      }
      if (candidate.decision) {
        throw new SearchLedgerIntegrityError(`candidate ${event.candidateId} was decided twice`)
      }
      if (event.decision.status === 'selected') {
        if (!candidate.attempts.some((attempt) => attempt.outcome.status !== 'errored')) {
          throw new SearchLedgerIntegrityError(
            `candidate ${event.candidateId} cannot be selected without a measured task outcome`,
          )
        }
        if (decisions.some((decision) => decision.decision.status === 'selected')) {
          throw new SearchLedgerIntegrityError('more than one candidate was selected')
        }
      }
      candidate.decision = event
      decisions.push(event)
      continue
    }

    const missingCandidateSlots = planEvent.plan.candidateSlots
      .filter((slot) => !candidateBySlot.has(slot.slotId) && !closedSlots.has(slot.slotId))
      .map((slot) => slot.slotId)
    if (missingCandidateSlots.length > 0) {
      throw new SearchLedgerIntegrityError(
        `search completed with missing candidate slots: ${missingCandidateSlots.join(', ')}`,
      )
    }
    const missingTaskOutcomes = plannedTaskOutcomeKeys(planEvent, candidates)
    if (missingTaskOutcomes.length > 0) {
      throw new SearchLedgerIntegrityError(
        `search completed with missing task outcomes: ${missingTaskOutcomes.join(', ')}`,
      )
    }
    const missingOperations = planEvent.plan.operations
      .filter((operation) => !operationsById.has(operation.operationId))
      .map((operation) => operation.operationId)
    if (missingOperations.length > 0) {
      throw new SearchLedgerIntegrityError(
        `search completed with missing search operations: ${missingOperations.join(', ')}`,
      )
    }
    const pending = [...candidates.values()].filter((candidate) => candidate.decision === null)
    if (pending.length > 0) {
      throw new SearchLedgerIntegrityError(
        `search completed with ${pending.length} candidate decision(s) missing`,
      )
    }
    const selected = decisions.filter((decision) => decision.decision.status === 'selected')
    if (event.result.status === 'selected') {
      if (selected.length !== 1 || selected[0]!.candidateId !== event.result.candidateId) {
        throw new SearchLedgerIntegrityError(
          `search completion winner ${event.result.candidateId} does not match candidate decisions`,
        )
      }
    } else if (selected.length !== 0) {
      throw new SearchLedgerIntegrityError('all-rejected completion contains a selected candidate')
    }
    completion = event
  }

  const selectedDecisions = decisions.filter((decision) => decision.decision.status === 'selected')
  const rejectedDecisions = decisions.filter((decision) => decision.decision.status === 'rejected')
  const outcomeCounts = { passed: 0, failed: 0, errored: 0 }
  const operationOutcomeCounts = { completed: 0, failed: 0 }
  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let costUsd = 0
  const unknownTokenEventIds: string[] = []
  const unknownCostEventIds: string[] = []
  for (const attempt of attempts) {
    outcomeCounts[attempt.outcome.status] += 1
  }
  for (const operation of operationEvents) {
    operationOutcomeCounts[operation.outcome.status] += 1
  }
  for (const costedEvent of [...attempts, ...operationEvents]) {
    if (costedEvent.accounting.tokens.status === 'known') {
      inputTokens += costedEvent.accounting.tokens.inputTokens
      outputTokens += costedEvent.accounting.tokens.outputTokens
      cachedTokens += costedEvent.accounting.tokens.cachedTokens
    } else {
      unknownTokenEventIds.push(costedEvent.eventId)
    }
    if (costedEvent.accounting.cost.status === 'known') {
      costUsd += costedEvent.accounting.cost.usd
    } else {
      costUsd += costedEvent.accounting.cost.knownLowerBoundUsd
      unknownCostEventIds.push(costedEvent.eventId)
    }
  }
  const accounting: SearchAccountingAudit =
    unknownTokenEventIds.length === 0 && unknownCostEventIds.length === 0
      ? {
          status: 'known',
          inputTokens,
          outputTokens,
          cachedTokens,
          costUsd,
        }
      : {
          status: 'partial',
          knownInputTokens: inputTokens,
          knownOutputTokens: outputTokens,
          knownCachedTokens: cachedTokens,
          knownCostUsd: costUsd,
          unknownTokenEventIds,
          unknownCostEventIds,
        }

  const selectedCandidateId =
    completion?.result.status === 'selected' ? completion.result.candidateId : null
  const status: SearchLedgerAudit['status'] =
    completion?.result.status === 'selected'
      ? 'selected'
      : completion?.result.status === 'all-rejected'
        ? 'all-rejected'
        : 'in-progress'
  const missingCandidateSlots =
    planEvent?.plan.candidateSlots
      .filter((slot) => !candidateBySlot.has(slot.slotId) && !closedSlots.has(slot.slotId))
      .map((slot) => slot.slotId) ?? []
  const missingTaskOutcomes = planEvent ? plannedTaskOutcomeKeys(planEvent, candidates) : []
  const missingOperations =
    planEvent?.plan.operations
      .filter((operation) => !operationsById.has(operation.operationId))
      .map((operation) => operation.operationId) ?? []
  return {
    entries: [...entries],
    plan: planEvent,
    candidates: candidateEvents,
    closedCandidateSlots: closedSlotEvents,
    attempts,
    operations: operationEvents,
    decisions,
    completion,
    audit: {
      campaignId,
      eventCount: entries.length,
      candidateCount: candidates.size,
      closedCandidateSlotCount: closedSlots.size,
      attemptCount: attempts.length,
      operationCount: operationEvents.length,
      outcomes: outcomeCounts,
      operationOutcomes: operationOutcomeCounts,
      decisions: {
        selected: selectedDecisions.length,
        rejected: rejectedDecisions.length,
        pending: candidates.size - decisions.length,
      },
      expected: {
        candidateSlots: planEvent?.plan.candidateSlots.length ?? 0,
        taskOutcomes: candidates.size * (planEvent?.plan.tasks.length ?? 0),
        operations: planEvent?.plan.operations.length ?? 0,
        missingCandidateSlots,
        missingTaskOutcomes,
        missingOperations,
      },
      status,
      selectedCandidateId,
      accounting,
      headHash: entries.at(-1)?.entryHash ?? null,
    },
  }
}

function plannedTaskOutcomeKeys(
  planEvent: SearchPlannedEvent,
  candidates: Map<string, CandidateState>,
): string[] {
  const missing: string[] = []
  const registeredCandidates = [...candidates.values()].sort((a, b) =>
    compareStrings(a.registered.slotId, b.registered.slotId),
  )
  for (const candidate of registeredCandidates) {
    const slotId = candidate.registered.slotId
    for (const task of planEvent.plan.tasks) {
      const measured = candidate.attempts.some(
        (attempt) => attempt.task.taskId === task.taskId && attempt.outcome.status !== 'errored',
      )
      if (!measured) missing.push(`${slotId}/${task.taskId}`)
    }
  }
  return missing
}

function normalizeEvent(event: SearchLedgerEvent): SearchLedgerEvent {
  const artifacts = sortArtifacts(event.artifacts)
  if (event.kind === 'search-planned') {
    return {
      ...event,
      artifacts,
      plan: {
        candidateSlots: [...event.plan.candidateSlots].sort((a, b) =>
          compareStrings(a.slotId, b.slotId),
        ),
        tasks: [...event.plan.tasks].sort((a, b) => compareStrings(a.taskId, b.taskId)),
        operations: [...event.plan.operations].sort((a, b) =>
          compareStrings(a.operationId, b.operationId),
        ),
      },
    }
  }
  if (event.kind === 'candidate-registered') {
    return {
      ...event,
      artifacts,
      lineage: {
        ...event.lineage,
        parentCandidateIds: sortedStrings(event.lineage.parentCandidateIds),
      },
      surfaces: [...event.surfaces]
        .map((surface) => ({ ...surface, artifact: { ...surface.artifact } }))
        .sort((a, b) => compareStrings(a.surfaceId, b.surfaceId)),
    }
  }
  if (event.kind === 'task-attempted') {
    return {
      ...event,
      artifacts,
      surfaceEvidence: [...event.surfaceEvidence]
        .map((evidence) => ({ ...evidence, evidence: sortArtifacts(evidence.evidence) }))
        .sort((a, b) => compareStrings(a.surfaceId, b.surfaceId)),
    }
  }
  return { ...event, artifacts }
}

function sortArtifacts(artifacts: SearchArtifactRef[]): SearchArtifactRef[] {
  return [...artifacts]
    .map((artifact) => ({ ...artifact }))
    .sort((a, b) => compareStrings(artifactKey(a), artifactKey(b)))
}

function artifactKey(artifact: SearchArtifactRef): string {
  return canonicalString(artifact)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortedStrings(values: string[]): string[] {
  return [...values].sort()
}

function assertUnique(values: string[], label: string, eventId: string): void {
  if (new Set(values).size !== values.length) {
    throw new SearchLedgerIntegrityError(`event ${eventId} contains duplicate ${label} values`)
  }
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function hashCanonical(value: unknown): SearchLedgerHash {
  return `sha256:${createHash('sha256').update(canonicalString(value)).digest('hex')}`
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ')
}
