import { hashCanonical } from '../ledger-core/canonical'
import {
  SEARCH_LEDGER_SCHEMA,
  type SearchArtifactRef,
  type SearchLedgerAudit,
  type SearchLedgerEvent,
  type SearchLedgerHash,
  type SearchLedgerReplay,
  validateSearchLedgerEvent,
} from './search-ledger'

export const SEARCH_HISTORY_RECEIPT_SCHEMA_VERSION = '1.0.0' as const
export const SEARCH_HISTORY_RECEIPT_DIGEST_ALGORITHM = 'rfc8785-sha256' as const

/** One addressable event in the canonical ledger. Rich event bytes stay there. */
export interface SearchHistoryEventIndex {
  readonly sequence: number
  readonly eventId: string
  readonly kind: SearchLedgerEvent['kind']
  readonly entryHash: SearchLedgerHash
}

/** Compact identities for the full records retained in the canonical ledger. */
export interface SearchHistoryEntityIndex {
  readonly candidateIds: readonly string[]
  readonly runIds: readonly string[]
  readonly operationIds: readonly string[]
  readonly closedCandidateSlotIds: readonly string[]
  readonly selectedCandidateIds: readonly string[]
  readonly rejectedCandidateIds: readonly string[]
}

/**
 * A tamper-evident table of contents for one verified SearchLedger replay.
 *
 * This is deliberately not another history. `ledger` binds the canonical JSONL
 * bytes, `events` makes every ledger record addressable, and `entities` gives
 * callers a compact inventory. Candidate payloads, attempts, failures, scores,
 * decisions, and artifacts remain in SearchLedger as the sole source of truth.
 */
export interface SearchHistoryReceipt {
  readonly schemaVersion: typeof SEARCH_HISTORY_RECEIPT_SCHEMA_VERSION
  readonly kind: 'search-history-receipt'
  readonly digestAlgorithm: typeof SEARCH_HISTORY_RECEIPT_DIGEST_ALGORITHM
  readonly receiptDigest: SearchLedgerHash
  /** Stable producer identity, for example an OptimizationMethod name. */
  readonly producerId: string
  /** Concrete optimizer/runtime invocation that produced the ledger. */
  readonly runId: string
  readonly ledger: SearchArtifactRef
  readonly campaignId: string
  readonly headHash: SearchLedgerHash | null
  readonly status: SearchLedgerAudit['status']
  readonly selectedCandidateId: string | null
  readonly complete: boolean
  readonly incompleteReasons: readonly string[]
  readonly events: readonly SearchHistoryEventIndex[]
  readonly entities: SearchHistoryEntityIndex
  readonly audit: SearchLedgerAudit
}

export interface CreateSearchHistoryReceiptInput {
  readonly producerId: string
  readonly runId: string
  /** Content-addressed canonical SearchLedger JSONL artifact. */
  readonly ledger: SearchArtifactRef
  /** The result of SearchLedger.replay(), after its hash-chain verification. */
  readonly replay: SearchLedgerReplay
}

export type SearchHistoryPolicy = 'allow-missing' | 'require-complete'

export interface SearchHistoryCoverageRow {
  readonly producerId: string
  readonly status: 'complete' | 'incomplete' | 'missing'
  readonly reasons: readonly string[]
  readonly receipt?: SearchHistoryReceipt
}

export interface SearchHistoryCoverage {
  readonly policy: SearchHistoryPolicy
  readonly allComplete: boolean
  readonly producers: readonly SearchHistoryCoverageRow[]
}

export class SearchHistoryRequiredError extends Error {
  readonly producerId: string
  readonly reasons: readonly string[]

  constructor(producerId: string, reasons: readonly string[]) {
    const normalized = reasons.length > 0 ? reasons : ['search history receipt is missing']
    super(`search producer '${producerId}' lacks complete history: ${normalized.join('; ')}`)
    this.name = 'SearchHistoryRequiredError'
    this.producerId = producerId
    this.reasons = Object.freeze([...normalized])
  }
}

/** Build a compact receipt from an already verified canonical ledger replay. */
export function createSearchHistoryReceipt(
  input: CreateSearchHistoryReceiptInput,
): SearchHistoryReceipt {
  if (!input || typeof input !== 'object') {
    throw new TypeError('search history input is required')
  }
  const producerId = nonEmpty(input.producerId, 'search history producerId')
  const runId = nonEmpty(input.runId, 'search history runId')
  const ledger = normalizeArtifactRef(input.ledger)
  const replay = validateReplay(input.replay)
  const events = Object.freeze(
    replay.entries.map((entry, index) =>
      Object.freeze({
        sequence: index,
        eventId: nonEmpty(entry.event.eventId, `search history event[${index}].eventId`),
        kind: entry.event.kind,
        entryHash: ledgerHash(entry.entryHash, `search history event[${index}].entryHash`),
      }),
    ),
  )
  const entities = Object.freeze({
    candidateIds: freezeUnique(replay.candidates.map((event) => event.candidateId)),
    runIds: freezeUnique(replay.attempts.map((event) => event.runId)),
    operationIds: freezeUnique(replay.operations.map((event) => event.operationId)),
    closedCandidateSlotIds: freezeUnique(replay.closedCandidateSlots.map((event) => event.slotId)),
    selectedCandidateIds: freezeUnique(
      replay.decisions
        .filter((event) => event.decision.status === 'selected')
        .map((event) => event.candidateId),
    ),
    rejectedCandidateIds: freezeUnique(
      replay.decisions
        .filter((event) => event.decision.status === 'rejected')
        .map((event) => event.candidateId),
    ),
  })
  const incompleteReasons = Object.freeze(historyIncompleteReasons(replay))
  const material = Object.freeze({
    schemaVersion: SEARCH_HISTORY_RECEIPT_SCHEMA_VERSION,
    kind: 'search-history-receipt' as const,
    digestAlgorithm: SEARCH_HISTORY_RECEIPT_DIGEST_ALGORITHM,
    producerId,
    runId,
    ledger,
    campaignId: replay.audit.campaignId,
    headHash: replay.audit.headHash,
    status: replay.audit.status,
    selectedCandidateId: replay.audit.selectedCandidateId,
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    events,
    entities,
    audit: immutableClone(replay.audit),
  })
  return Object.freeze({ ...material, receiptDigest: hashCanonical(material) })
}

/** Verify the compact receipt itself. Full ledger bytes are verified by SearchLedger. */
export function verifySearchHistoryReceipt(receipt: SearchHistoryReceipt): SearchHistoryReceipt {
  if (!receipt || typeof receipt !== 'object') {
    throw new TypeError('search history receipt is required')
  }
  if (receipt.schemaVersion !== SEARCH_HISTORY_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`unsupported search history schemaVersion '${receipt.schemaVersion}'`)
  }
  if (receipt.kind !== 'search-history-receipt') {
    throw new Error(`search history kind must be 'search-history-receipt'`)
  }
  if (receipt.digestAlgorithm !== SEARCH_HISTORY_RECEIPT_DIGEST_ALGORITHM) {
    throw new Error(`unsupported search history digestAlgorithm '${receipt.digestAlgorithm}'`)
  }
  nonEmpty(receipt.producerId, 'search history producerId')
  nonEmpty(receipt.runId, 'search history runId')
  normalizeArtifactRef(receipt.ledger)
  validateReceiptIndexes(receipt)
  if (hashCanonical(receiptMaterial(receipt)) !== receipt.receiptDigest) {
    throw new Error('search history receipt digest mismatch')
  }
  return receipt
}

/** Prove that a receipt still describes the exact verified replay supplied. */
export function assertSearchHistoryMatchesReplay(
  receipt: SearchHistoryReceipt,
  replay: SearchLedgerReplay,
): void {
  verifySearchHistoryReceipt(receipt)
  const expected = createSearchHistoryReceipt({
    producerId: receipt.producerId,
    runId: receipt.runId,
    ledger: receipt.ledger,
    replay,
  })
  if (expected.receiptDigest !== receipt.receiptDigest) {
    throw new Error('search history receipt does not match the supplied SearchLedger replay')
  }
}

/** Require a receipt owned by this producer and a terminal, denominator-complete history. */
export function assertCompleteSearchHistory(
  producerId: string,
  receipt: SearchHistoryReceipt | undefined,
): asserts receipt is SearchHistoryReceipt {
  if (receipt === undefined) throw new SearchHistoryRequiredError(producerId, [])
  verifySearchHistoryReceipt(receipt)
  if (receipt.producerId !== producerId) {
    throw new SearchHistoryRequiredError(producerId, [
      `receipt belongs to producer '${receipt.producerId}'`,
    ])
  }
  if (!receipt.complete) {
    throw new SearchHistoryRequiredError(producerId, receipt.incompleteReasons)
  }
}

/** Classify one producer's history without treating a malformed receipt as absence. */
export function searchHistoryCoverageRow(
  producerId: string,
  receipt: SearchHistoryReceipt | undefined,
): SearchHistoryCoverageRow {
  if (receipt === undefined) {
    return Object.freeze({
      producerId,
      status: 'missing',
      reasons: Object.freeze(['search history receipt is missing']),
    })
  }
  verifySearchHistoryReceipt(receipt)
  if (receipt.producerId !== producerId) {
    throw new SearchHistoryRequiredError(producerId, [
      `receipt belongs to producer '${receipt.producerId}'`,
    ])
  }
  return Object.freeze({
    producerId,
    status: receipt.complete ? 'complete' : 'incomplete',
    reasons: Object.freeze([...receipt.incompleteReasons]),
    receipt,
  })
}

function historyIncompleteReasons(replay: SearchLedgerReplay): string[] {
  const reasons: string[] = []
  if (replay.plan === null) reasons.push('search plan is missing')
  if (replay.completion === null) reasons.push('terminal search-completed event is missing')
  if (replay.audit.status === 'in-progress') reasons.push('search status is in-progress')
  if (replay.audit.expected.missingCandidateSlots.length > 0) {
    reasons.push(
      `candidate slots are unresolved: ${replay.audit.expected.missingCandidateSlots.join(', ')}`,
    )
  }
  if (replay.audit.expected.missingTaskOutcomes.length > 0) {
    reasons.push(
      `task outcomes are unresolved: ${replay.audit.expected.missingTaskOutcomes.join(', ')}`,
    )
  }
  if (replay.audit.expected.missingOperations.length > 0) {
    reasons.push(
      `operations are unresolved: ${replay.audit.expected.missingOperations.join(', ')}`,
    )
  }
  if (replay.audit.decisions.pending > 0) {
    reasons.push(`${replay.audit.decisions.pending} candidate decision(s) are pending`)
  }
  return reasons
}

function validateReplay(replay: SearchLedgerReplay): SearchLedgerReplay {
  if (!replay || typeof replay !== 'object') {
    throw new TypeError('search history replay is required')
  }
  if (!replay.audit || typeof replay.audit !== 'object') {
    throw new TypeError('search history replay.audit is required')
  }
  if (replay.audit.eventCount !== replay.entries.length) {
    throw new Error(
      `search history audit eventCount ${replay.audit.eventCount} does not match ${replay.entries.length} entries`,
    )
  }
  let previousHash: SearchLedgerHash | null = null
  replay.entries.forEach((entry, index) => {
    if (entry.schema !== SEARCH_LEDGER_SCHEMA) {
      throw new Error(`search history entry ${index} has unsupported schema '${entry.schema}'`)
    }
    if (entry.campaignId !== replay.audit.campaignId) {
      throw new Error(`search history entry ${index} belongs to another campaign`)
    }
    if (entry.sequence !== index) {
      throw new Error(
        `search history sequence mismatch: expected ${index}, observed ${entry.sequence}`,
      )
    }
    if (entry.previousHash !== previousHash) {
      throw new Error(`search history entry ${index} does not extend the prior ledger head`)
    }
    validateSearchLedgerEvent(entry.event)
    ledgerHash(entry.entryHash, `search history entry[${index}].entryHash`)
    previousHash = entry.entryHash
  })
  if (replay.audit.headHash !== previousHash) {
    throw new Error('search history audit headHash does not match the final ledger entry')
  }
  return replay
}

function validateReceiptIndexes(receipt: SearchHistoryReceipt): void {
  if (receipt.audit.campaignId !== receipt.campaignId) {
    throw new Error('search history campaignId does not match its audit')
  }
  if (receipt.audit.headHash !== receipt.headHash) {
    throw new Error('search history headHash does not match its audit')
  }
  if (receipt.audit.status !== receipt.status) {
    throw new Error('search history status does not match its audit')
  }
  if (receipt.audit.selectedCandidateId !== receipt.selectedCandidateId) {
    throw new Error('search history selectedCandidateId does not match its audit')
  }
  if (receipt.audit.eventCount !== receipt.events.length) {
    throw new Error('search history event count does not match its audit')
  }
  receipt.events.forEach((event, index) => {
    if (event.sequence !== index) {
      throw new Error(
        `search history event sequence mismatch: expected ${index}, observed ${event.sequence}`,
      )
    }
    nonEmpty(event.eventId, `search history events[${index}].eventId`)
    ledgerHash(event.entryHash, `search history events[${index}].entryHash`)
  })
  if (receipt.complete !== (receipt.incompleteReasons.length === 0)) {
    throw new Error('search history complete disagrees with incompleteReasons')
  }
}

function receiptMaterial(receipt: SearchHistoryReceipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    digestAlgorithm: receipt.digestAlgorithm,
    producerId: receipt.producerId,
    runId: receipt.runId,
    ledger: receipt.ledger,
    campaignId: receipt.campaignId,
    headHash: receipt.headHash,
    status: receipt.status,
    selectedCandidateId: receipt.selectedCandidateId,
    complete: receipt.complete,
    incompleteReasons: receipt.incompleteReasons,
    events: receipt.events,
    entities: receipt.entities,
    audit: receipt.audit,
  }
}

function normalizeArtifactRef(value: SearchArtifactRef): SearchArtifactRef {
  if (!value || typeof value !== 'object') {
    throw new TypeError('search history ledger artifact is required')
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
    throw new TypeError('search history ledger byteLength must be a non-negative safe integer')
  }
  return Object.freeze({
    role: nonEmpty(value.role, 'search history ledger role'),
    uri: nonEmpty(value.uri, 'search history ledger uri'),
    sha256: ledgerHash(value.sha256, 'search history ledger sha256'),
    byteLength: value.byteLength,
  })
}

function freezeUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => nonEmpty(value, 'search history entity id')))])
}

function ledgerHash(value: unknown, label: string): SearchLedgerHash {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase sha256 digest`)
  }
  return value as SearchLedgerHash
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}
