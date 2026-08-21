import { hashCanonical } from '../ledger-core/canonical'
import type {
  SearchArtifactRef,
  SearchLedgerAudit,
  SearchLedgerHash,
  SearchLedgerReplay,
} from './search-ledger'

const SEARCH_HISTORY_RECEIPT_SCHEMA_VERSION = '1.0.0' as const
const SEARCH_HISTORY_RECEIPT_DIGEST_ALGORITHM = 'rfc8785-sha256' as const

/** Bounded projection of the canonical replay audit. Exact ids stay in SearchLedger. */
export interface SearchHistoryAuditSummary {
  readonly campaignId: string
  readonly headHash: SearchLedgerHash | null
  readonly status: SearchLedgerAudit['status']
  readonly selectedCandidateId: string | null
  readonly eventCount: number
  readonly candidateCount: number
  readonly closedCandidateSlotCount: number
  readonly attemptCount: number
  readonly operationCount: number
  readonly expectedCandidateSlots: number
  readonly expectedTaskOutcomes: number
  readonly expectedOperations: number
  readonly missingCandidateSlots: number
  readonly missingTaskOutcomes: number
  readonly missingOperations: number
  readonly pendingDecisions: number
  readonly hasPlan: boolean
  readonly hasCompletion: boolean
}

/**
 * A bounded proof envelope over one canonical SearchLedger replay.
 *
 * The content-addressed ledger remains the sole rich history. This receipt binds
 * its producer/run identity, exact audit digest, bounded completeness summary,
 * and its own canonical digest. Consumers needing candidate ids, attempts,
 * failures, accounting gaps, or decisions read and replay the canonical ledger.
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
  /** Digest of the complete SearchLedgerAudit produced by canonical replay. */
  readonly auditDigest: SearchLedgerHash
  readonly summary: SearchHistoryAuditSummary
  readonly complete: boolean
  readonly incompleteReasons: readonly string[]
}

export interface CreateSearchHistoryReceiptInput {
  readonly producerId: string
  readonly runId: string
  /** Content-addressed canonical SearchLedger JSONL artifact. */
  readonly ledger: SearchArtifactRef
  /** The result returned by SearchLedger.replay(). */
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

/** Build a bounded receipt from the projection returned by canonical ledger replay. */
export function createSearchHistoryReceipt(
  input: CreateSearchHistoryReceiptInput,
): SearchHistoryReceipt {
  if (!input || typeof input !== 'object') {
    throw new TypeError('search history input is required')
  }
  const producerId = nonEmpty(input.producerId, 'search history producerId')
  const runId = nonEmpty(input.runId, 'search history runId')
  const ledger = normalizeArtifactRef(input.ledger)
  const replay = validateReplayProjection(input.replay)
  const auditDigest = ledgerHash(hashCanonical(replay.audit), 'search history auditDigest')
  const summary = summarizeReplay(replay)
  const incompleteReasons = Object.freeze(historyIncompleteReasons(summary))
  const material = Object.freeze({
    schemaVersion: SEARCH_HISTORY_RECEIPT_SCHEMA_VERSION,
    kind: 'search-history-receipt' as const,
    digestAlgorithm: SEARCH_HISTORY_RECEIPT_DIGEST_ALGORITHM,
    producerId,
    runId,
    ledger,
    auditDigest,
    summary,
    complete: incompleteReasons.length === 0,
    incompleteReasons,
  })
  return Object.freeze({ ...material, receiptDigest: hashCanonical(material) })
}

/** Verify the bounded receipt. Full ledger bytes are verified by SearchLedger. */
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
  const producerId = nonEmpty(receipt.producerId, 'search history producerId')
  const runId = nonEmpty(receipt.runId, 'search history runId')
  const ledger = normalizeArtifactRef(receipt.ledger)
  const auditDigest = ledgerHash(receipt.auditDigest, 'search history auditDigest')
  const summary = normalizeSummary(receipt.summary)
  const incompleteReasons = normalizeReasons(receipt.incompleteReasons)
  const expectedReasons = historyIncompleteReasons(summary)
  if (!sameStrings(incompleteReasons, expectedReasons)) {
    throw new Error('search history incompleteReasons disagree with its summary')
  }
  if (receipt.complete !== (expectedReasons.length === 0)) {
    throw new Error('search history complete disagrees with its summary')
  }
  const material = {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    digestAlgorithm: receipt.digestAlgorithm,
    producerId,
    runId,
    ledger,
    auditDigest,
    summary,
    complete: receipt.complete,
    incompleteReasons,
  }
  if (hashCanonical(material) !== receipt.receiptDigest) {
    throw new Error('search history receipt digest mismatch')
  }
  return receipt
}

/** Prove that a receipt still describes the exact canonical replay supplied. */
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

/** Classify one producer's history without treating malformed evidence as absence. */
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

function validateReplayProjection(replay: SearchLedgerReplay): SearchLedgerReplay {
  if (!replay || typeof replay !== 'object') {
    throw new TypeError('search history replay is required')
  }
  if (!Array.isArray(replay.entries)) {
    throw new TypeError('search history replay.entries must be an array')
  }
  if (!replay.audit || typeof replay.audit !== 'object') {
    throw new TypeError('search history replay.audit is required')
  }
  if (replay.plan !== null && (!replay.plan || typeof replay.plan !== 'object')) {
    throw new TypeError('search history replay.plan must be an event or null')
  }
  if (replay.completion !== null && (!replay.completion || typeof replay.completion !== 'object')) {
    throw new TypeError('search history replay.completion must be an event or null')
  }
  if (replay.audit.eventCount !== replay.entries.length) {
    throw new Error(
      `search history audit eventCount ${replay.audit.eventCount} does not match ${replay.entries.length} entries`,
    )
  }
  const observedHead = replay.entries.at(-1)?.entryHash ?? null
  if (replay.audit.headHash !== observedHead) {
    throw new Error('search history audit headHash does not match the final ledger entry')
  }
  return replay
}

function summarizeReplay(replay: SearchLedgerReplay): SearchHistoryAuditSummary {
  const audit = replay.audit
  return normalizeSummary({
    campaignId: audit.campaignId,
    headHash: audit.headHash,
    status: audit.status,
    selectedCandidateId: audit.selectedCandidateId,
    eventCount: audit.eventCount,
    candidateCount: audit.candidateCount,
    closedCandidateSlotCount: audit.closedCandidateSlotCount,
    attemptCount: audit.attemptCount,
    operationCount: audit.operationCount,
    expectedCandidateSlots: audit.expected.candidateSlots,
    expectedTaskOutcomes: audit.expected.taskOutcomes,
    expectedOperations: audit.expected.operations,
    missingCandidateSlots: audit.expected.missingCandidateSlots.length,
    missingTaskOutcomes: audit.expected.missingTaskOutcomes.length,
    missingOperations: audit.expected.missingOperations.length,
    pendingDecisions: audit.decisions.pending,
    hasPlan: replay.plan !== null,
    hasCompletion: replay.completion !== null,
  })
}

function normalizeSummary(value: SearchHistoryAuditSummary): SearchHistoryAuditSummary {
  if (!value || typeof value !== 'object') {
    throw new TypeError('search history summary is required')
  }
  const campaignId = nonEmpty(value.campaignId, 'search history summary.campaignId')
  const headHash = nullableLedgerHash(value.headHash, 'search history summary.headHash')
  const status = searchStatus(value.status)
  const selectedCandidateId = optionalNullableText(
    value.selectedCandidateId,
    'search history summary.selectedCandidateId',
  )
  const eventCount = nonNegativeSafeInteger(value.eventCount, 'search history summary.eventCount')
  const candidateCount = nonNegativeSafeInteger(
    value.candidateCount,
    'search history summary.candidateCount',
  )
  const closedCandidateSlotCount = nonNegativeSafeInteger(
    value.closedCandidateSlotCount,
    'search history summary.closedCandidateSlotCount',
  )
  const attemptCount = nonNegativeSafeInteger(
    value.attemptCount,
    'search history summary.attemptCount',
  )
  const operationCount = nonNegativeSafeInteger(
    value.operationCount,
    'search history summary.operationCount',
  )
  const expectedCandidateSlots = nonNegativeSafeInteger(
    value.expectedCandidateSlots,
    'search history summary.expectedCandidateSlots',
  )
  const expectedTaskOutcomes = nonNegativeSafeInteger(
    value.expectedTaskOutcomes,
    'search history summary.expectedTaskOutcomes',
  )
  const expectedOperations = nonNegativeSafeInteger(
    value.expectedOperations,
    'search history summary.expectedOperations',
  )
  const missingCandidateSlots = nonNegativeSafeInteger(
    value.missingCandidateSlots,
    'search history summary.missingCandidateSlots',
  )
  const missingTaskOutcomes = nonNegativeSafeInteger(
    value.missingTaskOutcomes,
    'search history summary.missingTaskOutcomes',
  )
  const missingOperations = nonNegativeSafeInteger(
    value.missingOperations,
    'search history summary.missingOperations',
  )
  const pendingDecisions = nonNegativeSafeInteger(
    value.pendingDecisions,
    'search history summary.pendingDecisions',
  )
  const hasPlan = boolean(value.hasPlan, 'search history summary.hasPlan')
  const hasCompletion = boolean(value.hasCompletion, 'search history summary.hasCompletion')

  if (missingCandidateSlots > expectedCandidateSlots) {
    throw new Error('search history missingCandidateSlots exceeds expectedCandidateSlots')
  }
  if (missingTaskOutcomes > expectedTaskOutcomes) {
    throw new Error('search history missingTaskOutcomes exceeds expectedTaskOutcomes')
  }
  if (missingOperations > expectedOperations) {
    throw new Error('search history missingOperations exceeds expectedOperations')
  }
  if (pendingDecisions > candidateCount) {
    throw new Error('search history pendingDecisions exceeds candidateCount')
  }
  if ((eventCount === 0) !== (headHash === null)) {
    throw new Error('search history eventCount and headHash disagree')
  }
  if ((status === 'in-progress') === hasCompletion) {
    throw new Error('search history status and hasCompletion disagree')
  }
  if (status === 'selected' && selectedCandidateId === null) {
    throw new Error('selected search history requires selectedCandidateId')
  }
  if (status !== 'selected' && selectedCandidateId !== null) {
    throw new Error('non-selected search history cannot name selectedCandidateId')
  }

  return Object.freeze({
    campaignId,
    headHash,
    status,
    selectedCandidateId,
    eventCount,
    candidateCount,
    closedCandidateSlotCount,
    attemptCount,
    operationCount,
    expectedCandidateSlots,
    expectedTaskOutcomes,
    expectedOperations,
    missingCandidateSlots,
    missingTaskOutcomes,
    missingOperations,
    pendingDecisions,
    hasPlan,
    hasCompletion,
  })
}

function historyIncompleteReasons(summary: SearchHistoryAuditSummary): string[] {
  const reasons: string[] = []
  if (!summary.hasPlan) reasons.push('search plan is missing')
  if (!summary.hasCompletion) reasons.push('terminal search-completed event is missing')
  if (summary.status === 'in-progress') reasons.push('search status is in-progress')
  if (summary.missingCandidateSlots > 0) {
    reasons.push(countReason(summary.missingCandidateSlots, 'candidate slot', 'candidate slots'))
  }
  if (summary.missingTaskOutcomes > 0) {
    reasons.push(countReason(summary.missingTaskOutcomes, 'task outcome', 'task outcomes'))
  }
  if (summary.missingOperations > 0) {
    reasons.push(countReason(summary.missingOperations, 'operation', 'operations'))
  }
  if (summary.pendingDecisions > 0) {
    reasons.push(
      countReason(summary.pendingDecisions, 'candidate decision', 'candidate decisions', 'pending'),
    )
  }
  return reasons
}

function countReason(
  count: number,
  singular: string,
  plural: string,
  adjective = 'unresolved',
): string {
  return `${count} ${count === 1 ? singular : plural} ${count === 1 ? 'is' : 'are'} ${adjective}`
}

function normalizeArtifactRef(value: SearchArtifactRef): SearchArtifactRef {
  if (!value || typeof value !== 'object') {
    throw new TypeError('search history ledger artifact is required')
  }
  return Object.freeze({
    role: nonEmpty(value.role, 'search history ledger role'),
    uri: nonEmpty(value.uri, 'search history ledger uri'),
    sha256: ledgerHash(value.sha256, 'search history ledger sha256'),
    byteLength: nonNegativeSafeInteger(value.byteLength, 'search history ledger byteLength'),
  })
}

function normalizeReasons(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError('search history incompleteReasons must be an array')
  }
  return Object.freeze(
    value.map((reason, index) => nonEmpty(reason, `search history incompleteReasons[${index}]`)),
  )
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function searchStatus(value: unknown): SearchLedgerAudit['status'] {
  if (value !== 'in-progress' && value !== 'selected' && value !== 'all-rejected') {
    throw new TypeError(`search history summary.status is invalid: ${String(value)}`)
  }
  return value
}

function nullableLedgerHash(value: unknown, label: string): SearchLedgerHash | null {
  return value === null ? null : ledgerHash(value, label)
}

function optionalNullableText(value: unknown, label: string): string | null {
  return value === null ? null : nonEmpty(value, label)
}

function ledgerHash(value: unknown, label: string): SearchLedgerHash {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase sha256 digest`)
  }
  return value as SearchLedgerHash
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a trimmed non-empty string`)
  }
  return value
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}
