/**
 * `SearchRecorder`: writes a search into its ledger as it happens.
 *
 * Every loop that scores artifacts against an objective and keeps the better
 * ones records through this one writer: the kernel, `runOptimization`, and the
 * GEPA importer. Each call appends one event the moment the fact exists, so an
 * interrupted search leaves an exact, replayable account of what ran.
 *
 * Content (surfaces, rationales, diffs, RunRecords) goes to content-addressed
 * blobs beside the ledger; the ledger holds their digests. Free text a proposer
 * wrote (rationales, labels) is redacted with the `share` profile before it is
 * hashed, so the chain never covers a secret. Surfaces are stored as they ran:
 * a redacted surface is not what ran.
 *
 * Every write is idempotent against the ledger's state. Ids are deterministic,
 * and a fact already in the ledger is not appended again, so a resumed search
 * continues its ledger instead of conflicting with its own history.
 */

import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EvaluationClaim } from '../experiment/claim'
import { canonicalString } from '../ledger-core/canonical'
import { type RunRecord, searchCellRunId } from '../run-record'
import { REDACTION_VERSION, redactText } from '../trace/redact'
import { createSearchHistoryReceipt, type SearchHistoryReceipt } from './search-history-receipt'
import { type SearchLedger, validateSearchLedgerEvent } from './search-ledger'
import type {
  NodeEstimate,
  SearchArtifactRef,
  SearchAttemptAccounting,
  SearchCandidateSurface,
  SearchCellStage,
  SearchClaim,
  SearchCloseReason,
  SearchEdgeAttribution,
  SearchEdgeOperator,
  SearchExecutionIdentity,
  SearchLedgerEvent,
  SearchModelIdentity,
  SearchNodeDecision,
  SearchNodeRef,
  SearchOpenedEvent,
  SearchOperationKind,
  SearchOperationRecordedEvent,
  SearchProposer,
  SearchReservation,
  SearchSourceRef,
  SearchSplit,
  SearchSurfaceEvidence,
  SearchTask,
  SearchTaskOutcome,
  SearchTraceRef,
  SearchUnknown,
} from './search-ledger-types'
import {
  type SearchStateView,
  searchCellId,
  searchNodeId,
  searchTaskSetDigest,
} from './search-state'
import { type CampaignStorage, fsCampaignStorage } from './storage'
import { renderSurfaceDiff, surfaceContentHash } from './surface-identity'
import type { MutableSurface } from './types'

const MAX_LABEL_CHARS = 200

/** Identities the ledger needs and a loop cannot infer. */
export interface SearchRunIdentity {
  /** The agent implementation under optimization. */
  agent: SearchSourceRef
  /** The candidate generator: a model call or deterministic code. */
  proposer: SearchOperationRecordedEvent['execution']
  /** The code that runs the search and decides its nodes. */
  search: SearchSourceRef
  /** Model the agent runs; used for a cell that reported none. */
  model: SearchModelIdentity
  /** What the search improves, for example `vb/coder`. Default: the producer's name. */
  subject?: string
  /** The judge's pinned source. Default: unknown, because judges arrive as functions. */
  judge?: SearchSourceRef
  /** The claim the search's numbers may support. Default: a development claim
   *  over the supplied tasks, one unit per task. */
  claim?: EvaluationClaim
}

/** A ledger and the identities a loop records into it. */
export interface SearchLedgerBinding {
  ledger: SearchLedger
  identity: SearchRunIdentity
}

/** The default claim: development numbers over exactly the supplied tasks. */
export function developmentClaim(populationId: string): EvaluationClaim {
  return {
    use: 'development',
    population: { id: populationId, description: 'the tasks this search was given' },
    samplingFrame: 'the caller-supplied task list',
    independentUnit: 'taskId',
    generalization: 'fixed-roster',
  }
}

/** The header of a search, with plain task lists; the recorder digests them. */
export type SearchOpening = Omit<
  SearchOpenedEvent,
  'kind' | 'eventId' | 'occurredAt' | 'artifacts' | 'splits'
> & {
  splits: {
    train: SearchTask[]
    selection: SearchTask[]
    test: SearchTask[]
    heldOutUnits: boolean
  }
}

export interface SearchRecorderOptions {
  ledger: SearchLedger
  /** Where content-addressed blobs are written. Default: `blobs/` beside the ledger. */
  blobDir?: string
  storage?: CampaignStorage
  /** Milliseconds since the epoch. Default: `Date.now`. */
  now?: () => number
}

export interface RegisterSearchNodeInput {
  artifactDigest: `sha256:${string}`
  artifact: SearchArtifactRef
  surfaces: SearchCandidateSurface[]
}

export interface RecordSearchEdgeInput {
  childNodeId: string
  /** Parents in this search, primary first, as node ids; or refs for a derive edge. */
  parents: Array<string | SearchNodeRef>
  operator: SearchEdgeOperator
  attribution: SearchEdgeAttribution
  proposer: SearchProposer | null
  /** Stable id of this proposal within the search, so a resumed search
   * recognizes the edge; for example `gen-3:candidate-1`. */
  proposalKey: string
  selection?: { rule: string; evidence: Record<string, number> } | null
  /** The proposer's free-text rationale; redacted before it is stored. */
  rationale: string | SearchUnknown
  /** One per parent: a diff blob from `recorder.blob('diff', …)`, or why there is none. */
  diffs: Array<SearchArtifactRef | SearchUnknown>
  label?: string
}

export interface AllocateSearchCellInput {
  nodeId: string
  taskId: string
  split: SearchSplit
  rep: number
  stage: SearchCellStage
  lane?: string | null
  reservation?: SearchReservation | null
}

export interface SettleSearchCellInput {
  cellId: string
  /** Default: the next attempt. An attempt already in the ledger is not appended again. */
  attempt?: number
  outcome: SearchTaskOutcome
  accounting: SearchAttemptAccounting
  identity: SearchExecutionIdentity
  boxMinutes?: number | null
  wallMs?: number | null
  queueMs?: number | null
  placement?: { lane: string; boxId: string | null } | null
  surfaceEvidence?: SearchSurfaceEvidence[]
  traceRef?: SearchTraceRef
  /** The attempt's RunRecord; its search coordinates and runId must match. */
  runRecord?: RunRecord
  artifacts?: SearchArtifactRef[]
}

/** Deterministic edge id: one proposal of one child within one search. */
export function searchEdgeId(searchId: string, childNodeId: string, proposalKey: string): string {
  return `edge_${createHash('sha256')
    .update(canonicalString([searchId, childNodeId, proposalKey]))
    .digest('hex')
    .slice(0, 32)}`
}

/** Writes one search's events into its ledger as they happen. */
export class SearchRecorder {
  readonly ledger: SearchLedger
  private readonly storage: CampaignStorage
  private readonly blobDir: string
  private readonly now: () => number
  private readonly tasks: ReadonlyMap<string, { split: SearchSplit; unitId: string }>
  private lastStampMs: number

  private constructor(
    options: SearchRecorderOptions,
    header: SearchOpenedEvent,
    lastOccurredAt: string | null,
  ) {
    this.ledger = options.ledger
    this.storage = options.storage ?? fsCampaignStorage()
    this.blobDir = options.blobDir ?? join(dirname(options.ledger.path), 'blobs')
    this.now = options.now ?? Date.now
    this.lastStampMs = lastOccurredAt === null ? 0 : Date.parse(lastOccurredAt)
    const tasks = new Map<string, { split: SearchSplit; unitId: string }>()
    for (const split of ['train', 'selection', 'test'] as const) {
      for (const task of header.splits[split].tasks) {
        tasks.set(task.taskId, { split, unitId: task.unitId })
      }
    }
    this.tasks = tasks
  }

  /**
   * Open the search: append `search-opened`, or, when the ledger already holds
   * one, check that it is this search and continue it.
   */
  static async open(
    options: SearchRecorderOptions,
    opening: SearchOpening,
    artifacts: SearchArtifactRef[] = [],
  ): Promise<SearchRecorder> {
    const state = await options.ledger.state()
    const event: SearchOpenedEvent = {
      ...opening,
      kind: 'search-opened',
      eventId: 'search-opened',
      occurredAt: '',
      artifacts,
      splits: {
        train: {
          taskSetDigest: searchTaskSetDigest(opening.splits.train),
          tasks: opening.splits.train,
        },
        selection: {
          taskSetDigest: searchTaskSetDigest(opening.splits.selection),
          tasks: opening.splits.selection,
        },
        test: {
          taskSetDigest: searchTaskSetDigest(opening.splits.test),
          tasks: opening.splits.test,
        },
        heldOutUnits: opening.splits.heldOutUnits,
      },
    }
    if (state.header) {
      const stored = headerMaterial(state.header)
      const requested = headerMaterial(canonicalHeader(event))
      if (stored !== requested) {
        throw new Error(
          `search ledger ${options.ledger.path} already holds a different search-opened header for ${state.searchId}; a changed search is a derived search`,
        )
      }
      return new SearchRecorder(options, state.header, state.lastOccurredAt)
    }
    const recorder = new SearchRecorder(options, event, state.lastOccurredAt)
    await recorder.append({ ...event, occurredAt: recorder.stamp() })
    return recorder
  }

  get searchId(): string {
    return this.ledger.searchId
  }

  /** The ledger's verified state now. */
  state(): Promise<SearchStateView> {
    return this.ledger.state()
  }

  /** Store `body` as a canonical JSON blob and return its content address. */
  blob(role: string, body: unknown): SearchArtifactRef {
    const text = canonicalString(body)
    const bytes = Buffer.from(text, 'utf8')
    const hex = createHash('sha256').update(bytes).digest('hex')
    const path = join(this.blobDir, `${hex}.json`)
    if (!this.storage.exists(path)) {
      this.storage.ensureDir(this.blobDir)
      this.storage.write(path, text)
    }
    return {
      role,
      uri: pathToFileURL(path).href,
      sha256: `sha256:${hex}`,
      byteLength: bytes.byteLength,
    }
  }

  /** Register a node, or return the existing node with the same artifact digest. */
  async registerNode(
    input: RegisterSearchNodeInput,
  ): Promise<{ nodeId: string; existed: boolean }> {
    const state = await this.ledger.state()
    const existing = state.nodeIdForDigest(input.artifactDigest)
    if (existing !== undefined) return { nodeId: existing, existed: true }
    const nodeId = searchNodeId(this.searchId, input.artifactDigest)
    await this.append({
      kind: 'node-registered',
      eventId: `node:${nodeId}`,
      occurredAt: this.stamp(),
      artifacts: [],
      nodeId,
      artifactDigest: input.artifactDigest,
      artifact: input.artifact,
      surfaces: input.surfaces,
    })
    return { nodeId, existed: false }
  }

  /** Record the proposal that derived a node. Returns the edge id. */
  async recordEdge(input: RecordSearchEdgeInput): Promise<string> {
    const edgeId = searchEdgeId(this.searchId, input.childNodeId, input.proposalKey)
    const state = await this.ledger.state()
    if (state.edge(edgeId)) return edgeId
    const rationale =
      typeof input.rationale === 'string'
        ? input.rationale.trim().length === 0
          ? { unknown: 'the proposer returned no rationale' }
          : this.blob('rationale', {
              kind: 'rationale',
              text: redactText(input.rationale, { profile: 'share' }),
              redaction: { profile: 'share', version: REDACTION_VERSION },
            })
        : input.rationale
    await this.append({
      kind: 'edge-recorded',
      eventId: `edge:${edgeId}`,
      occurredAt: this.stamp(),
      artifacts: [],
      edgeId,
      childNodeId: input.childNodeId,
      parents: input.parents.map((parent) =>
        typeof parent === 'string' ? { searchId: this.searchId, nodeId: parent } : parent,
      ),
      operator: input.operator,
      attribution: input.attribution,
      proposer: input.proposer,
      selection: input.selection ?? null,
      rationale,
      diffs: input.diffs,
      label: boundedLabel(input.label ?? ''),
    })
    return edgeId
  }

  async startOperation(input: {
    operationId: string
    operationKind: SearchOperationKind
    reservation?: SearchReservation | null
  }): Promise<void> {
    const state = await this.ledger.state()
    if (state.operation(input.operationId)) return
    await this.append({
      kind: 'operation-started',
      eventId: `operation-started:${input.operationId}`,
      occurredAt: this.stamp(),
      artifacts: [],
      operationId: input.operationId,
      operationKind: input.operationKind,
      reservation: input.reservation ?? null,
    })
  }

  async recordOperation(
    input: Omit<SearchOperationRecordedEvent, 'kind' | 'eventId' | 'occurredAt' | 'artifacts'> & {
      artifacts?: SearchArtifactRef[]
    },
  ): Promise<void> {
    const state = await this.ledger.state()
    if (state.operation(input.operationId)?.recorded) return
    await this.append({
      ...input,
      kind: 'operation-recorded',
      eventId: `operation-recorded:${input.operationId}`,
      occurredAt: this.stamp(),
      artifacts: input.artifacts ?? [],
    })
  }

  /** Plan one cell. Returns the cell id; an allocated cell is not allocated again. */
  async allocateCell(input: AllocateSearchCellInput): Promise<string> {
    const task = this.tasks.get(input.taskId)
    if (!task) throw new Error(`search ${this.searchId} declares no task ${input.taskId}`)
    const cellId = searchCellId(this.searchId, input.nodeId, input.taskId, input.split, input.rep)
    const state = await this.ledger.state()
    if (state.cell(cellId)) return cellId
    await this.append({
      kind: 'cell-allocated',
      eventId: `cell:${cellId}`,
      occurredAt: this.stamp(),
      artifacts: [],
      cellId,
      nodeId: input.nodeId,
      taskId: input.taskId,
      unitId: task.unitId,
      split: input.split,
      rep: input.rep,
      stage: input.stage,
      lane: input.lane ?? null,
      reservation: input.reservation ?? null,
    })
    return cellId
  }

  /** Record one finished attempt at a cell. */
  async settleCell(input: SettleSearchCellInput): Promise<void> {
    const state = await this.ledger.state()
    const cell = state.cell(input.cellId)
    if (!cell) throw new Error(`cell ${input.cellId} was never allocated in ${this.searchId}`)
    const attempt = input.attempt ?? cell.attempts + 1
    if (attempt <= cell.attempts) return
    const runId = searchCellRunId({ cellId: input.cellId, attempt })
    const artifacts = [...(input.artifacts ?? [])]
    if (input.runRecord) {
      const { search } = input.runRecord
      if (
        input.runRecord.runId !== runId ||
        search?.searchId !== this.searchId ||
        search.nodeId !== cell.nodeId ||
        search.cellId !== input.cellId ||
        search.attempt !== attempt
      ) {
        throw new Error(
          `RunRecord ${input.runRecord.runId} does not carry the coordinates of ${runId}`,
        )
      }
      artifacts.push(this.blob('run-record', input.runRecord))
    }
    await this.append({
      kind: 'cell-settled',
      eventId: `settled:${input.cellId}:${attempt}`,
      occurredAt: this.stamp(),
      artifacts,
      cellId: input.cellId,
      attempt,
      runId,
      outcome: input.outcome,
      accounting: input.accounting,
      boxMinutes: input.boxMinutes ?? null,
      wallMs: input.wallMs ?? null,
      queueMs: input.queueMs ?? null,
      placement: input.placement ?? null,
      identity: input.identity,
      surfaceEvidence: input.surfaceEvidence ?? [],
      traceRef: input.traceRef ?? { unknown: 'the producer recorded no trace for this attempt' },
    })
  }

  async cancelCell(input: {
    cellId: string
    reason: 'pruned' | 'budget' | 'deadline' | 'aborted'
  }): Promise<void> {
    const state = await this.ledger.state()
    const cell = state.cell(input.cellId)
    if (!cell) throw new Error(`cell ${input.cellId} was never allocated in ${this.searchId}`)
    if (cell.cancelled || cell.final) return
    await this.append({
      kind: 'cell-cancelled',
      eventId: `cancelled:${input.cellId}`,
      occurredAt: this.stamp(),
      artifacts: [],
      cellId: input.cellId,
      reason: input.reason,
    })
  }

  /** Record a decision about a node. Repeating the node's latest decision appends nothing. */
  async decideNode(input: {
    nodeId: string
    decision: SearchNodeDecision
    basis?: NodeEstimate | null
    rule: string
    reason: string
  }): Promise<void> {
    const state = await this.ledger.state()
    const node = state.node(input.nodeId)
    if (!node) throw new Error(`node ${input.nodeId} is not in ${this.searchId}`)
    const latest = node.decisions.at(-1)
    if (latest && canonicalString(latest.decision) === canonicalString(input.decision)) return
    await this.append({
      kind: 'node-decided',
      eventId: `decided:${input.nodeId}:${node.decisions.length}`,
      occurredAt: this.stamp(),
      artifacts: [],
      nodeId: input.nodeId,
      decision: input.decision,
      basis: input.basis ?? null,
      rule: input.rule,
      reason: input.reason,
    })
  }

  /** Close the search. The ledger refuses a close while any cell, operation or
   * node decision is outstanding. */
  async close(input: { reason: SearchCloseReason; claim: SearchClaim | null }): Promise<void> {
    const state = await this.ledger.state()
    if (state.closed) return
    await this.append({
      kind: 'search-closed',
      eventId: 'search-closed',
      occurredAt: this.stamp(),
      artifacts: [],
      reason: input.reason,
      claim: input.claim,
    })
  }

  /** A bounded receipt over the exact ledger bytes. */
  receipt(input: { producerId: string; runId: string }): SearchHistoryReceipt {
    return createSearchHistoryReceipt({ ...input, ledger: this.ledger, storage: this.storage })
  }

  private async append(event: SearchLedgerEvent): Promise<void> {
    await this.ledger.append(event)
  }

  /** Non-decreasing ISO stamps; the ledger refuses an event that moves back. */
  private stamp(): string {
    const now = this.now()
    this.lastStampMs = now > this.lastStampMs ? now : this.lastStampMs + 1
    return new Date(this.lastStampMs).toISOString()
  }
}

/** A mutable surface as a node: its content digest, stored bytes and declared surfaces. */
export function surfaceNode(
  recorder: SearchRecorder,
  surface: MutableSurface,
): RegisterSearchNodeInput {
  const artifact = recorder.blob('surface', { kind: 'mutable-surface', surface })
  return {
    artifactDigest: surfaceContentHash(surface),
    artifact,
    surfaces: declaredSurfaces(surface, artifact),
  }
}

/** A parent-to-child diff of two mutable surfaces, stored as a blob. */
export function surfaceDiff(
  recorder: SearchRecorder,
  parent: MutableSurface,
  child: MutableSurface,
): SearchArtifactRef {
  return recorder.blob('diff', {
    kind: 'surface-diff',
    from: surfaceContentHash(parent),
    to: surfaceContentHash(child),
    text: renderSurfaceDiff(child, parent),
  })
}

/** Declared surfaces of one node. A component surface declares one surface per
 * named component, so per-component evidence stays addressable. */
function declaredSurfaces(
  surface: MutableSurface,
  artifact: SearchArtifactRef,
): SearchCandidateSurface[] {
  if (typeof surface === 'string') return [{ surfaceId: 'prompt', kind: 'prompt', artifact }]
  if (surface.kind === 'code') return [{ surfaceId: 'code', kind: 'code', artifact }]
  return Object.keys(surface.components)
    .sort()
    .map((name) => ({ surfaceId: `component:${name}`, kind: 'prompt' as const, artifact }))
}

function boundedLabel(label: string): string {
  const redacted = redactText(label.trim(), { profile: 'share' })
  return redacted.length <= MAX_LABEL_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_LABEL_CHARS - 1)}…`
}

/** The header without its stamp, for comparing a resumed opening to the stored one. */
function headerMaterial(header: SearchOpenedEvent): string {
  const { occurredAt: _occurredAt, ...material } = header
  return canonicalString(material)
}

/** The header as the ledger would store it, so the comparison ignores ordering. */
function canonicalHeader(header: SearchOpenedEvent): SearchOpenedEvent {
  return validateSearchLedgerEvent({
    ...header,
    occurredAt: '2000-01-01T00:00:00.000Z',
  }) as SearchOpenedEvent
}
