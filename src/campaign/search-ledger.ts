/**
 * Durable append-only audit log for improvement searches.
 *
 * Existing campaign artifacts keep their own rich records: `RunRecord` owns a
 * measured run and `CostLedger` owns per-call accounting. This ledger does not
 * copy those structures. It binds their immutable ids and receipts into one replayable event stream so a
 * search can answer, after a crash, exactly which candidates and task attempts
 * existed, which surfaces actually fired, what they cost, and why they were
 * selected or rejected.
 *
 * The file format is canonical JSONL with a SHA-256 hash chain. Every append is
 * serialized across processes, fsynced before acknowledgement, and idempotent
 * by `eventId`. A malformed, non-canonical, truncated, reordered, or conflicting
 * log fails loudly; the implementation never skips a bad row.
 *
 * The journal machinery itself (hash chain, locking, fsync, idempotent append)
 * is the generic `ledger-core` journal; this module supplies the campaign
 * codec: event schemas, canonical event ordering, and the search state machine.
 */

import { z } from 'zod'
import {
  canonicalString,
  FileLedgerJournal,
  type LedgerJournalCodec,
  type LedgerLineContext,
  type LedgerTrustedHead,
  type LedgerTrustedHeadRemoval,
  replayLedgerText,
} from '../ledger-core'
import { modelHasSnapshot } from '../run-record'
import {
  SearchLedgerConflictError,
  SearchLedgerError,
  SearchLedgerIntegrityError,
} from './search-ledger-errors'
import { SEARCH_LEDGER_FILE_CONTEXT } from './search-ledger-file'
import { artifactKey, compareStrings } from './search-ledger-ordering'
import { createSearchLedgerProjector } from './search-ledger-projector'
import {
  SEARCH_LEDGER_SCHEMA,
  type SearchArtifactRef,
  type SearchLedgerAppendResult,
  type SearchLedgerEntry,
  type SearchLedgerEvent,
  type SearchLedgerReplay,
} from './search-ledger-types'

export { SearchLedgerConflictError, SearchLedgerError, SearchLedgerIntegrityError }

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

const CandidateSlotSchema = z
  .object({
    slotId: NON_EMPTY,
    generationOperationId: NON_EMPTY,
  })
  .strict()

const PlannedOperationSchema = z
  .object({
    operationId: NON_EMPTY,
    kind: OperationKindSchema,
  })
  .strict()

const SearchPlanExtendedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('search-plan-extended'),
    extension: z
      .object({
        candidateSlots: z.array(CandidateSlotSchema),
        operations: z.array(PlannedOperationSchema),
      })
      .strict()
      .superRefine((extension, ctx) => {
        if (extension.candidateSlots.length === 0 && extension.operations.length === 0) {
          ctx.addIssue({ code: 'custom', message: 'a plan extension must add slots or operations' })
        }
      }),
  })
  .strict()

const SearchPlannedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('search-planned'),
    plan: z
      .object({
        candidateSlots: z.array(CandidateSlotSchema).min(1),
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
        operations: z.array(PlannedOperationSchema).min(1),
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
          status: z.literal('partial'),
          failure: FailureReasonSchema,
        })
        .strict(),
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
  SearchPlanExtendedSchema,
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

/**
 * How this ledger uses its trusted head — the `(sequence, entryHash)` pin kept
 * in the sibling `<path>.head` file that a hash chain needs to prove entries
 * were not deleted from the end. `ledger-core/trusted-head.ts` holds the threat
 * model.
 *
 * - `pin` (default): every append records the new head, and a pin that is
 *   present is verified on every read.
 * - `require`: additionally refuses to read a non-empty ledger whose pin is
 *   gone, so deleting the sibling file cannot downgrade the guarantee. Only for
 *   ledgers written under `pin` from their first entry.
 * - `off`: chain verification only. Truncation to a valid shorter prefix is
 *   undetectable.
 */
export type SearchLedgerTrustedHeadMode = 'pin' | 'require' | 'off'

export interface OpenSearchLedgerOptions {
  path: string
  campaignId: string
  trustedHead?: SearchLedgerTrustedHeadMode
}

export interface SearchLedger {
  readonly path: string
  readonly campaignId: string
  /** Sibling file holding this ledger's trusted head. */
  readonly trustedHeadPath: string
  append(event: SearchLedgerEvent): Promise<SearchLedgerAppendResult>
  replay(): Promise<SearchLedgerReplay>
  /** The pinned head, or null when this ledger has never been pinned. */
  trustedHead(): Promise<LedgerTrustedHead | null>
  /** Pin the current verified head: how a ledger written under `off`, or one
   * whose pin file was removed, acquires a pin without rewriting a byte. */
  pinTrustedHead(): Promise<LedgerTrustedHead>
  /** Discard this ledger's pin, reporting what was discarded. Deleting or
   * rebuilding the ledger file leaves a pin naming history the file no longer
   * carries, and every later read is refused because that is exactly the
   * deletion the pin exists to catch; clearing is the supported way to abandon
   * that history on purpose. It gives up the deletion guarantee for every entry
   * the pin covered. */
  clearTrustedHead(): Promise<LedgerTrustedHeadRemoval>
}

/** Open a durable filesystem search ledger. Construction performs no I/O; the
 * first `append` or `replay` validates the complete existing file. */
export function openSearchLedger(options: OpenSearchLedgerOptions): SearchLedger {
  if (options.path.trim().length === 0) throw new SearchLedgerError('ledger path is empty')
  return new FileSearchLedger(options.path, options.campaignId, options.trustedHead)
}

/** Replay immutable search-ledger JSONL through the same codec as FileSearchLedger. */
export function replaySearchLedgerText(
  text: string,
  campaignId: string,
  source: string,
): SearchLedgerReplay {
  return replayLedgerText(text, source, searchLedgerCodec(campaignId)).projection
}

interface SearchLedgerHeader {
  schema: typeof SEARCH_LEDGER_SCHEMA
  campaignId: string
}

function searchLedgerCodec(
  campaignId: string,
): LedgerJournalCodec<SearchLedgerHeader, SearchLedgerEvent, SearchLedgerReplay> {
  return {
    ...SEARCH_LEDGER_FILE_CONTEXT,
    header: { schema: SEARCH_LEDGER_SCHEMA, campaignId },
    conflictError: (message) => new SearchLedgerConflictError(message),
    parseEntry: parseSearchLedgerEntry,
    checkEntryHeader: (entry, index) => {
      if (entry.campaignId !== campaignId) {
        throw new SearchLedgerIntegrityError(
          `entry ${index} belongs to campaign ${entry.campaignId}, expected ${campaignId}`,
        )
      }
    },
    createProjector: () => createSearchLedgerProjector(campaignId),
  }
}

/** Append-only file-backed search ledger with idempotent writes and replay. */
export class FileSearchLedger implements SearchLedger {
  readonly path: string
  readonly campaignId: string
  readonly trustedHeadPath: string
  private readonly trustedHeadMode: SearchLedgerTrustedHeadMode
  private readonly journal: FileLedgerJournal<
    SearchLedgerHeader,
    SearchLedgerEvent,
    SearchLedgerReplay
  >

  constructor(path: string, campaignId: string, trustedHead: SearchLedgerTrustedHeadMode = 'pin') {
    if (path.trim().length === 0) throw new SearchLedgerError('ledger path is empty')
    if (campaignId.length === 0) throw new SearchLedgerError('campaignId is empty')
    if (campaignId.trim() !== campaignId) {
      throw new SearchLedgerError('campaignId must not contain surrounding whitespace')
    }
    this.campaignId = campaignId
    this.trustedHeadMode = trustedHead
    this.journal = new FileLedgerJournal(path, searchLedgerCodec(campaignId), {
      requireTrustedHead: trustedHead === 'require',
    })
    this.path = this.journal.path
    this.trustedHeadPath = this.journal.trustedHeadPath
  }

  async replay(): Promise<SearchLedgerReplay> {
    return (await this.journal.replay()).projection
  }

  async append(input: SearchLedgerEvent): Promise<SearchLedgerAppendResult> {
    // Normalize before the journal hashes the event so retries from different
    // processes produce byte-identical entries.
    const event = validateSearchLedgerEvent(input)
    const { entry, appended, projection } = await this.journal.append(event, {
      pinHead: this.trustedHeadMode !== 'off',
    })
    return { entry, appended, replay: projection }
  }

  async trustedHead(): Promise<LedgerTrustedHead | null> {
    return this.journal.trustedHead()
  }

  async pinTrustedHead(): Promise<LedgerTrustedHead> {
    return this.journal.pinTrustedHead()
  }

  async clearTrustedHead(): Promise<LedgerTrustedHeadRemoval> {
    return this.journal.clearTrustedHead()
  }
}

function parseSearchLedgerEntry(raw: unknown, context: LedgerLineContext): SearchLedgerEntry {
  const parsed = EntrySchema.safeParse(raw)
  if (!parsed.success) {
    throw new SearchLedgerIntegrityError(
      `search ledger ${context.path} has a malformed entry at line ${context.line}: ${formatZodError(parsed.error)}`,
    )
  }
  const entry = parsed.data as SearchLedgerEntry
  const normalizedEvent = validateSearchLedgerEvent(entry.event)
  if (canonicalString(normalizedEvent) !== canonicalString(entry.event)) {
    throw new SearchLedgerIntegrityError(
      `search ledger ${context.path} has non-canonical event ordering at line ${context.line}`,
    )
  }
  return entry
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
  if (event.kind === 'search-plan-extended') {
    return {
      ...event,
      artifacts,
      extension: {
        candidateSlots: [...event.extension.candidateSlots].sort((a, b) =>
          compareStrings(a.slotId, b.slotId),
        ),
        operations: [...event.extension.operations].sort((a, b) =>
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

function sortedStrings(values: string[]): string[] {
  return [...values].sort()
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ')
}

export type {
  SearchAccountingAudit,
  SearchArtifactRef,
  SearchAttemptAccounting,
  SearchCandidateDecidedEvent,
  SearchCandidateLineage,
  SearchCandidateRegisteredEvent,
  SearchCandidateSlot,
  SearchCandidateSlotClosedEvent,
  SearchCandidateSurface,
  SearchCompletedEvent,
  SearchCostAccounting,
  SearchFailureReason,
  SearchLedgerAppendResult,
  SearchLedgerAudit,
  SearchLedgerEntry,
  SearchLedgerEvent,
  SearchLedgerHash,
  SearchLedgerReplay,
  SearchModelIdentity,
  SearchOperationKind,
  SearchOperationRecordedEvent,
  SearchPlan,
  SearchPlanExtendedEvent,
  SearchPlannedEvent,
  SearchPlannedOperation,
  SearchPlannedTask,
  SearchSourceRef,
  SearchSurfaceEffect,
  SearchSurfaceEvidence,
  SearchSurfaceKind,
  SearchTaskAttemptedEvent,
  SearchTaskOutcome,
  SearchTokenAccounting,
} from './search-ledger-types'
