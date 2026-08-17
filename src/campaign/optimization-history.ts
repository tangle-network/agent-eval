import { hashCanonical } from '../ledger-core/canonical'
import type {
  SearchArtifactRef,
  SearchLedgerAudit,
  SearchLedgerHash,
  SearchLedgerReplay,
} from './search-ledger'

export const OPTIMIZATION_HISTORY_RECEIPT_SCHEMA_VERSION = '1.0.0' as const
export const OPTIMIZATION_HISTORY_RECEIPT_DIGEST_ALGORITHM = 'rfc8785-sha256' as const

export interface OptimizationHistoryEventIndex {
  readonly sequence: number
  readonly eventId: string
  readonly kind: string
  readonly entryHash: SearchLedgerHash
}

/** Compact identities for the full records retained in the canonical ledger. */
export interface OptimizationHistoryEntityIndex {
  readonly candidateIds: readonly string[]
  readonly runIds: readonly string[]
  readonly operationIds: readonly string[]
  readonly closedCandidateSlotIds: readonly string[]
  readonly selectedCandidateIds: readonly string[]
  readonly rejectedCandidateIds: readonly string[]
}

/**
 * Content-addressed index over Eval's canonical search ledger.
 *
 * The receipt never copies the rich candidate, attempt, operation, or decision
 * records. `ledger` binds those bytes; `events` makes every record addressable;
 * `entities` gives callers a compact inventory; and `audit` states whether the
 * planned denominator is complete. This prevents winner-only APIs without
 * creating a second history format.
 */
export interface OptimizationHistoryReceipt {
  readonly schemaVersion: typeof OPTIMIZATION_HISTORY_RECEIPT_SCHEMA_VERSION
  readonly kind: 'optimization-history'
  readonly digestAlgorithm: typeof OPTIMIZATION_HISTORY_RECEIPT_DIGEST_ALGORITHM
  readonly receiptDigest: SearchLedgerHash
  readonly methodName: string
  readonly runId: string
  readonly ledger: SearchArtifactRef
  readonly campaignId: string
  readonly headHash: SearchLedgerHash | null
  readonly status: SearchLedgerAudit['status']
  readonly selectedCandidateId: string | null
  readonly historyComplete: boolean
  readonly incompleteReasons: readonly string[]
  readonly events: readonly OptimizationHistoryEventIndex[]
  readonly entities: OptimizationHistoryEntityIndex
  readonly audit: SearchLedgerAudit
}

export interface CreateOptimizationHistoryReceiptInput {
  readonly methodName: string
  readonly runId: string
  /** Content-addressed canonical search-ledger JSONL artifact. */
  readonly ledger: SearchArtifactRef
  /** Result of `SearchLedger.replay()`, which already verifies the ledger. */
  readonly replay: SearchLedgerReplay
}

export class OptimizationHistoryRequiredError extends Error {
  readonly methodName: string
  readonly reasons: readonly string[]

  constructor(methodName: string, reasons: readonly string[]) {
    const normalized = reasons.length > 0 ? reasons : ['history receipt is missing']
    super(`optimization method '${methodName}' lacks complete history: ${normalized.join('; ')}`)
    this.name = 'OptimizationHistoryRequiredError'
    this.methodName = methodName
    this.reasons = Object.freeze([...normalized])
  }
}

export function createOptimizationHistoryReceipt(
  input: CreateOptimizationHistoryReceiptInput,
): OptimizationHistoryReceipt {
  if (!input || typeof input !== 'object') {
    throw new TypeError('optimization history input is required')
  }
  const methodName = nonEmpty(input.methodName, 'optimization history methodName')
  const runId = nonEmpty(input.runId, 'optimization history runId')
  const ledger = normalizeArtifactRef(input.ledger)
  const replay = validateReplay(input.replay)
  const events = Object.freeze(
    replay.entries.map((entry, index) => {
      if (entry.sequence !== index) {
        throw new Error(
          `optimization history sequence mismatch: expected ${index}, observed ${entry.sequence}`,
        )
      }
      return Object.freeze({
        sequence: entry.sequence,
        eventId: nonEmpty(entry.event.eventId, `optimization history event[${index}].eventId`),
        kind: entry.event.kind,
        entryHash: ledgerHash(entry.entryHash, `optimization history event[${index}].entryHash`),
      })
    }),
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
    schemaVersion: OPTIMIZATION_HISTORY_RECEIPT_SCHEMA_VERSION,
    kind: 'optimization-history' as const,
    digestAlgorithm: OPTIMIZATION_HISTORY_RECEIPT_DIGEST_ALGORITHM,
    methodName,
    runId,
    ledger,
    campaignId: replay.audit.campaignId,
    headHash: replay.audit.headHash,
    status: replay.audit.status,
    selectedCandidateId: replay.audit.selectedCandidateId,
    historyComplete: incompleteReasons.length === 0,
    incompleteReasons,
    events,
    entities,
    audit: immutableClone(replay.audit),
  })
  return Object.freeze({ ...material, receiptDigest: hashCanonical(material) })
}

export function verifyOptimizationHistoryReceipt(
  receipt: OptimizationHistoryReceipt,
): OptimizationHistoryReceipt {
  if (!receipt || typeof receipt !== 'object') {
    throw new TypeError('optimization history receipt is required')
  }
  if (receipt.schemaVersion !== OPTIMIZATION_HISTORY_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`unsupported optimization history schemaVersion '${receipt.schemaVersion}'`)
  }
  if (receipt.kind !== 'optimization-history') {
    throw new Error(`optimization history kind must be 'optimization-history'`)
  }
  if (receipt.digestAlgorithm !== OPTIMIZATION_HISTORY_RECEIPT_DIGEST_ALGORITHM) {
    throw new Error(`unsupported optimization history digestAlgorithm '${receipt.digestAlgorithm}'`)
  }
  normalizeArtifactRef(receipt.ledger)
  validateReceiptIndexes(receipt)
  const { receiptDigest: _digest, ...material } = receipt
  if (hashCanonical(material) !== receipt.receiptDigest) {
    throw new Error('optimization history receipt digest mismatch')
  }
  return receipt
}

export function assertOptimizationHistoryMatchesReplay(
  receipt: OptimizationHistoryReceipt,
  replay: SearchLedgerReplay,
): void {
  verifyOptimizationHistoryReceipt(receipt)
  const expected = createOptimizationHistoryReceipt({
    methodName: receipt.methodName,
    runId: receipt.runId,
    ledger: receipt.ledger,
    replay,
  })
  if (expected.receiptDigest !== receipt.receiptDigest) {
    throw new Error('optimization history receipt does not match the supplied search-ledger replay')
  }
}

export function assertCompleteOptimizationHistory(
  methodName: string,
  receipt: OptimizationHistoryReceipt | undefined,
): asserts receipt is OptimizationHistoryReceipt {
  if (receipt === undefined) throw new OptimizationHistoryRequiredError(methodName, [])
  verifyOptimizationHistoryReceipt(receipt)
  if (receipt.methodName !== methodName) {
    throw new OptimizationHistoryRequiredError(methodName, [
      `receipt belongs to method '${receipt.methodName}'`,
    ])
  }
  if (!receipt.historyComplete) {
    throw new OptimizationHistoryRequiredError(methodName, receipt.incompleteReasons)
  }
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
    reasons.push(`operations are unresolved: ${replay.audit.expected.missingOperations.join(', ')}`)
  }
  if (replay.audit.decisions.pending > 0) {
    reasons.push(`${replay.audit.decisions.pending} candidate decision(s) are pending`)
  }
  return reasons
}

function validateReplay(replay: SearchLedgerReplay): SearchLedgerReplay {
  if (!replay || typeof replay !== 'object') {
    throw new TypeError('optimization history replay is required')
  }
  if (replay.audit.eventCount !== replay.entries.length) {
    throw new Error(
      `optimization history audit eventCount ${replay.audit.eventCount} does not match ${replay.entries.length} entries`,
    )
  }
  if (replay.audit.headHash !== (replay.entries.at(-1)?.entryHash ?? null)) {
    throw new Error('optimization history audit headHash does not match the final ledger entry')
  }
  return replay
}

function validateReceiptIndexes(receipt: OptimizationHistoryReceipt): void {
  if (receipt.audit.campaignId !== receipt.campaignId) {
    throw new Error('optimization history campaignId does not match its audit')
  }
  if (receipt.audit.headHash !== receipt.headHash) {
    throw new Error('optimization history headHash does not match its audit')
  }
  if (receipt.audit.eventCount !== receipt.events.length) {
    throw new Error('optimization history event count does not match its audit')
  }
  receipt.events.forEach((event, index) => {
    if (event.sequence !== index) {
      throw new Error(
        `optimization history event sequence mismatch: expected ${index}, observed ${event.sequence}`,
      )
    }
    ledgerHash(event.entryHash, `optimization history events[${index}].entryHash`)
  })
  if (receipt.historyComplete !== (receipt.incompleteReasons.length === 0)) {
    throw new Error('optimization history historyComplete disagrees with incompleteReasons')
  }
}

function normalizeArtifactRef(value: SearchArtifactRef): SearchArtifactRef {
  if (!value || typeof value !== 'object') {
    throw new TypeError('optimization history ledger artifact is required')
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
    throw new TypeError('optimization history ledger byteLength must be non-negative')
  }
  return Object.freeze({
    role: nonEmpty(value.role, 'optimization history ledger role'),
    uri: nonEmpty(value.uri, 'optimization history ledger uri'),
    sha256: ledgerHash(value.sha256, 'optimization history ledger sha256'),
    byteLength: value.byteLength,
  })
}

function freezeUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => nonEmpty(value, 'history entity id')))])
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
