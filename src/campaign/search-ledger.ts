/**
 * Durable, append-only event log of one search: nodes (content-addressed
 * artifacts), edges (the proposals that derived them), cells (one run of one
 * node on one task), operations, decisions, and the claim.
 *
 * The ledger is the search's only lineage record and its only resume
 * checkpoint. A RunRecord owns one measured run and `CostLedger` owns per-call
 * accounting; this ledger binds them by digest instead of copying them.
 *
 * The file format is canonical JSONL with a SHA-256 hash chain. Every append is
 * serialized across processes, fsynced before acknowledgement, and idempotent
 * by `eventId`. A malformed, non-canonical, truncated, reordered, or conflicting
 * log fails loudly; a bad row is never skipped. A ledger written under another
 * schema tag is refused with that tag named, never translated.
 *
 * The journal machinery is the generic `ledger-core` journal. This module is
 * the search codec: event schemas and canonical ordering. `SearchState` is the
 * state machine and read model.
 */

import { z } from 'zod'
import { evaluationClaimSchema } from '../experiment/claim'
import {
  canonicalString,
  FileLedgerJournal,
  hashCanonical,
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
import {
  SEARCH_LEDGER_SCHEMA,
  type SearchArtifactRef,
  type SearchLedgerEntry,
  type SearchLedgerEvent,
  type SearchTask,
} from './search-ledger-types'
import { SearchState, type SearchStateView } from './search-state'

export { SearchLedgerConflictError, SearchLedgerError, SearchLedgerIntegrityError }

const NON_EMPTY = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must not contain surrounding whitespace')

const HASH = z.string().regex(/^sha256:[a-f0-9]{64}$/)

const IMMUTABLE_REVISION = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64}|sha512:[A-Za-z0-9+/=]+)$/)

const ISO_TIMESTAMP = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp')

const NON_NEGATIVE_INT = z.number().int().nonnegative().safe()
const POSITIVE_INT = z.number().int().positive().safe()
const FINITE_NUMBER = z.number().finite()
const USD = z.number().finite().nonnegative()

const NODE_ID = z.string().regex(/^node_[a-f0-9]{32}$/)
const CELL_ID = z.string().regex(/^cell_[a-f0-9]{32}$/)

const ArtifactRefSchema = z
  .object({ role: NON_EMPTY, uri: NON_EMPTY, sha256: HASH, byteLength: NON_NEGATIVE_INT })
  .strict()

const SourceRefSchema = z.object({ uri: NON_EMPTY, revision: IMMUTABLE_REVISION }).strict()

const UnknownRefSchema = z.object({ unknown: NON_EMPTY }).strict()

const FailureReasonSchema = z.object({ code: NON_EMPTY, message: NON_EMPTY }).strict()

const ModelIdentitySchema = z.union([
  z
    .object({
      provider: NON_EMPTY,
      snapshot: NON_EMPTY.refine(modelHasSnapshot, 'model must include an immutable snapshot'),
    })
    .strict(),
  z.object({ provider: NON_EMPTY, alias: NON_EMPTY, unknown: NON_EMPTY }).strict(),
])

const ExecutionIdentitySchema = z
  .object({ model: ModelIdentitySchema, agent: SourceRefSchema, benchmark: SourceRefSchema })
  .strict()

const SURFACE_KINDS = [
  'prompt',
  'tool-contract',
  'runtime-config',
  'memory',
  'knowledge',
  'agent-profile',
  'code',
  'deployment',
] as const

const SPLIT = z.enum(['train', 'selection', 'test'])

const ReservationSchema = z.object({ kind: z.enum(['hard', 'estimate']), usd: USD }).strict()

const EventBaseShape = {
  eventId: NON_EMPTY,
  occurredAt: ISO_TIMESTAMP,
  artifacts: z.array(ArtifactRefSchema),
}

const OperationKindSchema = z.enum([
  'candidate-generation',
  'analysis',
  'selection',
  'judge',
  'other',
])

const KnownTokensSchema = z
  .object({
    status: z.literal('known'),
    inputTokens: NON_NEGATIVE_INT,
    outputTokens: NON_NEGATIVE_INT,
    cachedTokens: NON_NEGATIVE_INT,
  })
  .strict()

const UnknownTokensSchema = z.object({ status: z.literal('unknown'), reason: NON_EMPTY }).strict()

const KnownCostSchema = z
  .object({
    status: z.literal('known'),
    usd: USD,
    source: z.enum(['provider', 'pricing-table', 'free']),
  })
  .strict()
  .superRefine((cost, ctx) => {
    if (cost.source === 'free' && cost.usd !== 0) {
      ctx.addIssue({ code: 'custom', message: 'free cost source must have usd 0' })
    }
  })

const UnknownCostSchema = z
  .object({ status: z.literal('unknown'), knownLowerBoundUsd: USD, reason: NON_EMPTY })
  .strict()

const AccountingSchema = z
  .object({
    tokens: z.discriminatedUnion('status', [KnownTokensSchema, UnknownTokensSchema]),
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
  z.object({ status: z.literal('passed'), score: FINITE_NUMBER, metrics: MetricsSchema }).strict(),
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
  z.object({ status: z.literal('not-measured'), reason: NON_EMPTY }).strict(),
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
    if (evidence.fired !== evidence.firingCount > 0) {
      ctx.addIssue({ code: 'custom', message: 'fired must equal firingCount > 0' })
    }
    if (!evidence.fired && evidence.effect.status === 'measured' && evidence.effect.delta !== 0) {
      ctx.addIssue({ code: 'custom', message: 'a surface that did not fire has no effect' })
    }
  })

const TaskSchema = z
  .object({ taskId: NON_EMPTY, unitId: NON_EMPTY, source: SourceRefSchema })
  .strict()

const SplitTasksSchema = z.object({ taskSetDigest: HASH, tasks: z.array(TaskSchema) }).strict()

const SearchOpenedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('search-opened'),
    subject: NON_EMPTY,
    process: z.object({ name: NON_EMPTY, executionRef: SourceRefSchema }).strict(),
    artifactKind: z.enum([...SURFACE_KINDS, 'output']),
    objective: z
      .object({
        metric: NON_EMPTY,
        direction: z.enum(['maximize', 'minimize']),
        judge: z.union([SourceRefSchema, UnknownRefSchema]),
        claim: evaluationClaimSchema,
      })
      .strict(),
    splits: z
      .object({
        train: SplitTasksSchema,
        selection: SplitTasksSchema,
        test: SplitTasksSchema,
        heldOutUnits: z.boolean(),
      })
      .strict(),
    policy: z
      .object({ expansion: NON_EMPTY, allocation: NON_EMPTY, seed: z.number().int().safe() })
      .strict(),
    budget: z
      .object({
        maxUsd: USD.nullable(),
        maxCells: POSITIVE_INT.nullable(),
        maxNodes: POSITIVE_INT.nullable(),
        deadline: ISO_TIMESTAMP.nullable(),
        maxConcurrency: POSITIVE_INT.nullable(),
        reservedClaimUsd: USD,
      })
      .strict(),
    containment: z
      .object({ searchId: NON_EMPTY, cellId: CELL_ID, attempt: POSITIVE_INT })
      .strict()
      .nullable(),
    derivedFrom: z
      .object({ searchId: NON_EMPTY, nodeId: NODE_ID, headHash: HASH })
      .strict()
      .nullable(),
    identity: ExecutionIdentitySchema,
  })
  .strict()

const OperationStartedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('operation-started'),
    operationId: NON_EMPTY,
    operationKind: OperationKindSchema,
    reservation: ReservationSchema.nullable(),
  })
  .strict()

const OperationRecordedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('operation-recorded'),
    operationId: NON_EMPTY,
    operationKind: OperationKindSchema,
    execution: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('model'), model: ModelIdentitySchema, source: SourceRefSchema })
        .strict(),
      z.object({ kind: z.literal('deterministic'), source: SourceRefSchema }).strict(),
    ]),
    outcome: z.discriminatedUnion('status', [
      z.object({ status: z.literal('completed') }).strict(),
      z.object({ status: z.literal('partial'), failure: FailureReasonSchema }).strict(),
      z.object({ status: z.literal('failed'), failure: FailureReasonSchema }).strict(),
    ]),
    accounting: AccountingSchema,
  })
  .strict()

const NodeRegisteredSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('node-registered'),
    nodeId: NODE_ID,
    artifactDigest: HASH,
    artifact: ArtifactRefSchema,
    surfaces: z.array(
      z
        .object({ surfaceId: NON_EMPTY, kind: z.enum(SURFACE_KINDS), artifact: ArtifactRefSchema })
        .strict(),
    ),
  })
  .strict()

const NodeRefSchema = z.object({ searchId: NON_EMPTY, nodeId: NODE_ID }).strict()

const ArtifactOrUnknownSchema = z.union([ArtifactRefSchema, UnknownRefSchema])

const EdgeRecordedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('edge-recorded'),
    edgeId: z.string().regex(/^edge_[a-f0-9]{32}$/),
    childNodeId: NODE_ID,
    parents: z.array(NodeRefSchema),
    operator: z.enum(['seed', 'draft', 'improve', 'debug', 'merge', 'derive']),
    attribution: z.enum(['explicit', 'correlated', 'unknown']),
    proposer: z
      .object({
        kind: z.enum(['trace', 'frontier-author', 'human', 'optimizer', 'compound']),
        name: NON_EMPTY,
        operationId: NON_EMPTY.nullable(),
        source: SourceRefSchema,
      })
      .strict()
      .nullable(),
    selection: z
      .object({ rule: NON_EMPTY, evidence: z.record(NON_EMPTY, FINITE_NUMBER) })
      .strict()
      .nullable(),
    rationale: ArtifactOrUnknownSchema,
    diffs: z.array(ArtifactOrUnknownSchema),
    label: z.string(),
  })
  .strict()

const CellAllocatedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('cell-allocated'),
    cellId: CELL_ID,
    nodeId: NODE_ID,
    taskId: NON_EMPTY,
    unitId: NON_EMPTY,
    split: SPLIT,
    rep: NON_NEGATIVE_INT,
    stage: z.enum(['root', 'train', 'screen', 'rung', 'claim', 'external']),
    lane: NON_EMPTY.nullable(),
    reservation: ReservationSchema.nullable(),
  })
  .strict()

const TraceRefSchema = z.union([
  z
    .object({
      traceId: NON_EMPTY,
      execRunId: NON_EMPTY.nullable(),
      spansWritten: NON_NEGATIVE_INT.nullable(),
      spansDropped: NON_NEGATIVE_INT.nullable(),
    })
    .strict(),
  UnknownRefSchema,
])

const NON_NEGATIVE = z.number().finite().nonnegative()

const CellSettledSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('cell-settled'),
    cellId: CELL_ID,
    attempt: POSITIVE_INT,
    runId: NON_EMPTY,
    outcome: OutcomeSchema,
    accounting: AccountingSchema,
    boxMinutes: NON_NEGATIVE.nullable(),
    wallMs: NON_NEGATIVE.nullable(),
    queueMs: NON_NEGATIVE.nullable(),
    placement: z.object({ lane: NON_EMPTY, boxId: NON_EMPTY.nullable() }).strict().nullable(),
    identity: ExecutionIdentitySchema,
    surfaceEvidence: z.array(SurfaceEvidenceSchema),
    traceRef: TraceRefSchema,
  })
  .strict()

const CellCancelledSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('cell-cancelled'),
    cellId: CELL_ID,
    reason: z.enum(['pruned', 'budget', 'deadline', 'aborted']),
  })
  .strict()

const NodeEstimateSchema = z
  .object({
    against: NODE_ID,
    split: SPLIT,
    units: NON_NEGATIVE_INT,
    pairs: NON_NEGATIVE_INT,
    delta: FINITE_NUMBER.nullable(),
    interval: z.tuple([FINITE_NUMBER, FINITE_NUMBER]).nullable(),
    method: z.enum(['none', 'insufficient', 'descriptive', 'bootstrap']),
    exactSignP: z.number().min(0).max(1).nullable(),
    cellSetDigest: HASH,
    estimator: SourceRefSchema,
  })
  .strict()

const NodeDecidedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('node-decided'),
    nodeId: NODE_ID,
    decision: z.discriminatedUnion('status', [
      z.object({ status: z.literal('advanced'), rung: NON_NEGATIVE_INT }).strict(),
      z.object({ status: z.literal('pruned') }).strict(),
      z.object({ status: z.literal('invalid') }).strict(),
      z.object({ status: z.literal('finalist') }).strict(),
      z.object({ status: z.literal('selected') }).strict(),
      z.object({ status: z.literal('rejected') }).strict(),
    ]),
    basis: NodeEstimateSchema.nullable(),
    rule: NON_EMPTY,
    reason: NON_EMPTY,
  })
  .strict()

const SearchClosedSchema = z
  .object({
    ...EventBaseShape,
    kind: z.literal('search-closed'),
    reason: z.enum(['budget', 'deadline', 'max-nodes', 'patience', 'converged', 'aborted']),
    claim: z
      .object({
        power: z.union([
          z
            .object({
              adequate: z.boolean(),
              minimumEffect: z.number().finite().positive(),
              powerAtMinimumEffect: z.number().min(0).max(1),
              units: NON_NEGATIVE_INT,
            })
            .strict(),
          UnknownRefSchema,
        ]),
        finalists: z.array(
          z
            .object({
              nodeId: NODE_ID,
              estimate: NodeEstimateSchema.nullable(),
              promote: z.boolean(),
            })
            .strict(),
        ),
        selected: NODE_ID.nullable(),
        decision: z.enum(['ship', 'hold', 'test-cannot-resolve']),
      })
      .strict()
      .nullable(),
  })
  .strict()

const EventSchema = z.discriminatedUnion('kind', [
  SearchOpenedSchema,
  OperationStartedSchema,
  OperationRecordedSchema,
  NodeRegisteredSchema,
  EdgeRecordedSchema,
  CellAllocatedSchema,
  CellSettledSchema,
  CellCancelledSchema,
  NodeDecidedSchema,
  SearchClosedSchema,
])

const EntrySchema = z
  .object({
    schema: z.literal(SEARCH_LEDGER_SCHEMA),
    searchId: NON_EMPTY,
    sequence: NON_NEGATIVE_INT,
    previousHash: z.union([HASH, z.null()]),
    event: EventSchema,
    entryHash: HASH,
  })
  .strict()

/** Validate and return a canonical copy. Arrays whose order carries no meaning
 * are sorted, so retries from different processes produce identical bytes. */
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
 *   gone, so deleting the sibling file cannot downgrade the guarantee.
 * - `off`: chain verification only. Truncation to a valid shorter prefix is
 *   undetectable.
 */
export type SearchLedgerTrustedHeadMode = 'pin' | 'require' | 'off'

export interface OpenSearchLedgerOptions {
  path: string
  searchId: string
  trustedHead?: SearchLedgerTrustedHeadMode
}

export interface SearchLedgerAppendResult {
  entry: SearchLedgerEntry
  /** False when the exact event was already durably present. */
  appended: boolean
  state: SearchStateView
}

export interface SearchLedger {
  readonly path: string
  readonly searchId: string
  /** Sibling file holding this ledger's trusted head. */
  readonly trustedHeadPath: string
  append(event: SearchLedgerEvent): Promise<SearchLedgerAppendResult>
  /** The verified state at the file's current head. */
  state(): Promise<SearchStateView>
  /** The pinned head, or null when this ledger has never been pinned. */
  trustedHead(): Promise<LedgerTrustedHead | null>
  /** Pin the current verified head without rewriting a byte. */
  pinTrustedHead(): Promise<LedgerTrustedHead>
  /** Discard this ledger's pin, reporting what was discarded. It gives up the
   * deletion guarantee for every entry the pin covered. */
  clearTrustedHead(): Promise<LedgerTrustedHeadRemoval>
}

/** Open a durable filesystem search ledger. Construction performs no I/O; the
 * first `append` or `state` verifies the whole existing file. */
export function openSearchLedger(options: OpenSearchLedgerOptions): SearchLedger {
  return new FileSearchLedger(options.path, options.searchId, options.trustedHead)
}

/** Verify and project immutable search-ledger JSONL through the same codec as
 * `FileSearchLedger`. */
export function replaySearchLedgerText(
  text: string,
  searchId: string,
  source: string,
): SearchStateView {
  return replayLedgerText(text, source, searchLedgerCodec(searchId))
}

/**
 * Verify one stored ledger line in isolation: the schema tag, the entry and
 * event schemas, canonical bytes, the entry's own hash, and its search. The
 * chain (sequence and previous hash) and the state machine are the caller's,
 * because they need the lines before this one. An ingest server runs this on
 * every received line, so it hashes exactly the bytes the producer hashed.
 */
export function parseSearchLedgerLine(
  line: string,
  searchId: string,
  context: LedgerLineContext,
): SearchLedgerEntry {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (error) {
    throw new SearchLedgerIntegrityError(
      `search ledger ${context.path} has invalid JSON at line ${context.line}`,
      { cause: error },
    )
  }
  const entry = parseSearchLedgerEntry(raw, context)
  if (entry.searchId !== searchId) {
    throw new SearchLedgerIntegrityError(
      `search ledger ${context.path} line ${context.line} belongs to search ${entry.searchId}, expected ${searchId}`,
    )
  }
  if (canonicalString(entry) !== line) {
    throw new SearchLedgerIntegrityError(
      `search ledger ${context.path} has non-canonical bytes at line ${context.line}`,
    )
  }
  const { entryHash, ...material } = entry
  const expected = hashCanonical(material)
  if (entryHash !== expected) {
    throw new SearchLedgerIntegrityError(
      `search ledger ${context.path} line ${context.line} hash mismatch: expected ${expected}, got ${entryHash}`,
    )
  }
  return entry
}

interface SearchLedgerHeader {
  schema: typeof SEARCH_LEDGER_SCHEMA
  searchId: string
}

function searchLedgerCodec(
  searchId: string,
): LedgerJournalCodec<SearchLedgerHeader, SearchLedgerEvent, SearchStateView> {
  return {
    ...SEARCH_LEDGER_FILE_CONTEXT,
    header: { schema: SEARCH_LEDGER_SCHEMA, searchId },
    conflictError: (message) => new SearchLedgerConflictError(message),
    parseEntry: parseSearchLedgerEntry,
    checkEntryHeader: (entry, index) => {
      if (entry.searchId !== searchId) {
        throw new SearchLedgerIntegrityError(
          `entry ${index} belongs to search ${entry.searchId}, expected ${searchId}`,
        )
      }
    },
    createProjector: () => new SearchState(searchId),
  }
}

/** Append-only file-backed search ledger with idempotent writes. */
export class FileSearchLedger implements SearchLedger {
  readonly path: string
  readonly searchId: string
  readonly trustedHeadPath: string
  private readonly trustedHeadMode: SearchLedgerTrustedHeadMode
  private readonly journal: FileLedgerJournal<
    SearchLedgerHeader,
    SearchLedgerEvent,
    SearchStateView
  >

  constructor(path: string, searchId: string, trustedHead: SearchLedgerTrustedHeadMode = 'pin') {
    if (path.trim().length === 0) throw new SearchLedgerError('ledger path is empty')
    if (searchId.length === 0 || searchId.trim() !== searchId) {
      throw new SearchLedgerError('searchId must be non-empty without surrounding whitespace')
    }
    this.searchId = searchId
    this.trustedHeadMode = trustedHead
    this.journal = new FileLedgerJournal(path, searchLedgerCodec(searchId), {
      requireTrustedHead: trustedHead === 'require',
    })
    this.path = this.journal.path
    this.trustedHeadPath = this.journal.trustedHeadPath
  }

  async state(): Promise<SearchStateView> {
    return this.journal.replay()
  }

  async append(input: SearchLedgerEvent): Promise<SearchLedgerAppendResult> {
    // Normalize before the journal hashes the event so retries from different
    // processes produce byte-identical entries.
    const event = validateSearchLedgerEvent(input)
    const { entry, appended, projection } = await this.journal.append(event, {
      pinHead: this.trustedHeadMode !== 'off',
    })
    return { entry, appended, state: projection }
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
  const schema = (raw as { schema?: unknown } | null)?.schema
  if (schema !== SEARCH_LEDGER_SCHEMA) {
    throw new SearchLedgerIntegrityError(
      `search ledger ${context.path} line ${context.line} was written under schema ${JSON.stringify(schema)}; this version reads only ${SEARCH_LEDGER_SCHEMA} and does not translate other formats`,
    )
  }
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
  switch (event.kind) {
    case 'search-opened':
      return {
        ...event,
        artifacts,
        splits: {
          ...event.splits,
          train: { ...event.splits.train, tasks: sortTasks(event.splits.train.tasks) },
          selection: { ...event.splits.selection, tasks: sortTasks(event.splits.selection.tasks) },
          test: { ...event.splits.test, tasks: sortTasks(event.splits.test.tasks) },
        },
      }
    case 'node-registered':
      return {
        ...event,
        artifacts,
        surfaces: [...event.surfaces].sort((a, b) => compareStrings(a.surfaceId, b.surfaceId)),
      }
    case 'cell-settled':
      return {
        ...event,
        artifacts,
        surfaceEvidence: [...event.surfaceEvidence]
          .map((evidence) => ({ ...evidence, evidence: sortArtifacts(evidence.evidence) }))
          .sort((a, b) => compareStrings(a.surfaceId, b.surfaceId)),
      }
    default:
      return { ...event, artifacts }
  }
}

function sortTasks(tasks: SearchTask[]): SearchTask[] {
  return [...tasks].sort((a, b) => compareStrings(a.taskId, b.taskId))
}

function sortArtifacts(artifacts: SearchArtifactRef[]): SearchArtifactRef[] {
  return [...artifacts].sort((a, b) => compareStrings(artifactKey(a), artifactKey(b)))
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ')
}

export type * from './search-ledger-types'
export { SEARCH_LEDGER_SCHEMA }
