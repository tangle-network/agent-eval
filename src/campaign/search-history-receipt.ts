import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashCanonical } from '../ledger-core/canonical'
import type { SearchArtifactRef, SearchAudit, SearchLedgerHash } from './search-ledger'
import { replaySearchLedgerText } from './search-ledger'
import type { SearchStateView } from './search-state'
import { type CampaignStorage, fsCampaignStorage } from './storage'

const SEARCH_HISTORY_RECEIPT_SCHEMA_VERSION = '2026-09' as const
const SEARCH_HISTORY_RECEIPT_DIGEST_ALGORITHM = 'rfc8785-sha256' as const

/** Bounded summary of a search's audit. Exact ids stay in the ledger. */
export interface SearchHistoryAuditSummary {
  readonly searchId: string
  readonly headHash: SearchLedgerHash | null
  readonly status: SearchAudit['status']
  readonly closeReason: SearchAudit['closeReason']
  readonly claimDecision: 'ship' | 'hold' | 'test-cannot-resolve' | null
  readonly selectedNodeId: string | null
  readonly eventCount: number
  readonly nodes: number
  readonly edges: number
  readonly cells: number
  readonly openCells: number
  readonly openOperations: number
  readonly nodesWithoutEdge: number
  readonly undecidedNodes: number
}

/**
 * A bounded proof envelope over one search ledger.
 *
 * The content-addressed ledger stays the only rich history. The receipt binds
 * its producer and run, the exact ledger bytes, the digest of the complete
 * audit, and a bounded summary. `complete` means the ledger holds
 * `search-closed`, which the ledger admits only when every allocated cell has
 * an outcome or was cancelled, every started operation was recorded, and every
 * node has an edge and a terminal decision.
 */
export interface SearchHistoryReceipt {
  readonly schemaVersion: typeof SEARCH_HISTORY_RECEIPT_SCHEMA_VERSION
  readonly kind: 'search-history-receipt'
  readonly digestAlgorithm: typeof SEARCH_HISTORY_RECEIPT_DIGEST_ALGORITHM
  readonly receiptDigest: SearchLedgerHash
  /** Stable producer identity, for example an OptimizationMethod name. */
  readonly producerId: string
  /** Concrete optimizer or runtime invocation that produced the ledger. */
  readonly runId: string
  /** The ledger file: `sha256` and `byteLength` of its exact bytes. */
  readonly ledger: SearchArtifactRef
  /** `hashCanonical` of the complete `SearchAudit` from replaying those bytes. */
  readonly auditDigest: SearchLedgerHash
  readonly summary: SearchHistoryAuditSummary
  readonly complete: boolean
  readonly incompleteReasons: readonly string[]
}

export interface CreateSearchHistoryReceiptInput {
  readonly producerId: string
  readonly runId: string
  readonly ledger: { readonly path: string; readonly searchId: string }
  readonly storage?: Pick<CampaignStorage, 'read'>
}

export type SearchHistoryPolicy = 'allow-missing' | 'require-complete'

export interface SearchHistoryAdmissionOptions {
  /** Missing history is reported by default; require-complete refuses final
   * assessment without a closed search ledger. */
  searchHistoryPolicy?: SearchHistoryPolicy
  /** Receipt checks are the default. Ledger checks also resolve and replay the bytes. */
  searchHistoryVerification?: 'receipt' | 'ledger'
}

export function assertSearchHistoryAdmissionOptions(options: SearchHistoryAdmissionOptions): void {
  if (
    options.searchHistoryPolicy !== undefined &&
    !['allow-missing', 'require-complete'].includes(options.searchHistoryPolicy)
  ) {
    throw new Error(`unknown searchHistoryPolicy '${String(options.searchHistoryPolicy)}'`)
  }
  if (
    options.searchHistoryVerification !== undefined &&
    !['receipt', 'ledger'].includes(options.searchHistoryVerification)
  ) {
    throw new Error(
      `unknown searchHistoryVerification '${String(options.searchHistoryVerification)}'`,
    )
  }
}

/** Read the ledger's bytes, replay them through the search codec, and build
 * the receipt from that replay. */
export function createSearchHistoryReceipt(
  input: CreateSearchHistoryReceiptInput,
): SearchHistoryReceipt {
  const producerId = nonEmpty(input.producerId, 'search history producerId')
  const runId = nonEmpty(input.runId, 'search history runId')
  const storage = input.storage ?? fsCampaignStorage()
  const text = storage.read(input.ledger.path) ?? ''
  const state = replaySearchLedgerText(text, input.ledger.searchId, input.ledger.path)
  return receiptFor(producerId, runId, ledgerArtifact(input.ledger.path, text), state)
}

/** Verify the receipt, then resolve its ledger bytes, check them, and replay
 * them with the canonical codec. Never trusts a caller-supplied projection. */
export function verifySearchHistoryArtifact(
  receipt: SearchHistoryReceipt,
  storage: Pick<CampaignStorage, 'read'>,
): void {
  verifySearchHistoryReceipt(receipt)
  const path = receipt.ledger.uri.startsWith('file:')
    ? fileURLToPath(receipt.ledger.uri)
    : receipt.ledger.uri
  const text = storage.read(path)
  if (text === undefined) {
    throw new Error(`search history ledger is missing or unreadable at '${path}'`)
  }
  const artifact = ledgerArtifact(path, text)
  if (artifact.byteLength !== receipt.ledger.byteLength) {
    throw new Error('search history ledger byte length mismatch')
  }
  if (artifact.sha256 !== receipt.ledger.sha256) {
    throw new Error('search history ledger digest mismatch')
  }
  assertSearchHistoryMatchesState(
    receipt,
    replaySearchLedgerText(text, receipt.summary.searchId, path),
  )
}

export interface SearchHistoryCoverageRow {
  readonly producerId: string
  readonly status: 'complete' | 'incomplete' | 'missing'
  readonly reasons: readonly string[]
  readonly stages?: readonly SearchHistoryCoverageRow[]
  readonly receipt?: SearchHistoryReceipt
  /** Present only after the referenced bytes and replay were verified. */
  readonly ledgerVerified?: true
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

/** Verify a receipt's own consistency and digest. */
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
  const summary = normalizeSummary(receipt.summary)
  if (receipt.complete !== (summary.status === 'closed')) {
    throw new Error('search history complete disagrees with its summary')
  }
  if (
    !Array.isArray(receipt.incompleteReasons) ||
    receipt.complete !== (receipt.incompleteReasons.length === 0)
  ) {
    throw new Error('search history incompleteReasons disagree with complete')
  }
  const { receiptDigest, ...material } = receipt
  if (hashCanonical(material) !== receiptDigest) {
    throw new Error('search history receipt digest mismatch')
  }
  return receipt
}

/** Prove that a receipt describes exactly the supplied replayed state. */
export function assertSearchHistoryMatchesState(
  receipt: SearchHistoryReceipt,
  state: SearchStateView,
): void {
  verifySearchHistoryReceipt(receipt)
  const expected = receiptFor(receipt.producerId, receipt.runId, receipt.ledger, state)
  if (expected.receiptDigest !== receipt.receiptDigest) {
    throw new Error('search history receipt does not match the supplied search ledger state')
  }
}

/** Require a receipt owned by this producer over a closed search. */
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

function receiptFor(
  producerId: string,
  runId: string,
  ledger: SearchArtifactRef,
  state: SearchStateView,
): SearchHistoryReceipt {
  const { audit } = state
  const summary = normalizeSummary({
    searchId: audit.searchId,
    headHash: audit.headHash,
    status: audit.status,
    closeReason: audit.closeReason,
    claimDecision: state.closed?.claim?.decision ?? null,
    selectedNodeId: audit.selectedNodeId,
    eventCount: audit.eventCount,
    nodes: audit.nodes,
    edges: audit.edges.explicit + audit.edges.correlated + audit.edges.unknown,
    cells: audit.cells.allocated,
    openCells: audit.cells.open,
    openOperations: audit.operations.open,
    nodesWithoutEdge: audit.nodesWithoutEdge,
    undecidedNodes: audit.undecidedNodes,
  })
  const material = {
    schemaVersion: SEARCH_HISTORY_RECEIPT_SCHEMA_VERSION,
    kind: 'search-history-receipt' as const,
    digestAlgorithm: SEARCH_HISTORY_RECEIPT_DIGEST_ALGORITHM,
    producerId,
    runId,
    ledger: Object.freeze({ ...ledger }),
    auditDigest: hashCanonical(audit),
    summary,
    complete: state.completion.complete,
    incompleteReasons: Object.freeze([...state.completion.reasons]),
  }
  return Object.freeze({ ...material, receiptDigest: hashCanonical(material) })
}

function ledgerArtifact(path: string, text: string): SearchArtifactRef {
  const bytes = Buffer.from(text, 'utf8')
  return {
    role: 'search-ledger',
    uri: pathToFileURL(path).href,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byteLength: bytes.byteLength,
  }
}

function normalizeSummary(value: SearchHistoryAuditSummary): SearchHistoryAuditSummary {
  if (!value || typeof value !== 'object') {
    throw new TypeError('search history summary is required')
  }
  const counts = [
    'eventCount',
    'nodes',
    'edges',
    'cells',
    'openCells',
    'openOperations',
    'nodesWithoutEdge',
    'undecidedNodes',
  ] as const
  for (const key of counts) {
    const count = value[key]
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`search history summary.${key} must be a non-negative safe integer`)
    }
  }
  if (value.status !== 'open' && value.status !== 'closed') {
    throw new TypeError(`search history summary.status is invalid: ${String(value.status)}`)
  }
  if ((value.eventCount === 0) !== (value.headHash === null)) {
    throw new Error('search history eventCount and headHash disagree')
  }
  if ((value.status === 'closed') !== (value.closeReason !== null)) {
    throw new Error('search history status and closeReason disagree')
  }
  if (
    value.status === 'closed' &&
    value.openCells + value.openOperations + value.nodesWithoutEdge + value.undecidedNodes > 0
  ) {
    throw new Error('a closed search history cannot have open work')
  }
  return Object.freeze({
    searchId: nonEmpty(value.searchId, 'search history summary.searchId'),
    headHash: value.headHash,
    status: value.status,
    closeReason: value.closeReason,
    claimDecision: value.claimDecision,
    selectedNodeId: value.selectedNodeId,
    eventCount: value.eventCount,
    nodes: value.nodes,
    edges: value.edges,
    cells: value.cells,
    openCells: value.openCells,
    openOperations: value.openOperations,
    nodesWithoutEdge: value.nodesWithoutEdge,
    undecidedNodes: value.undecidedNodes,
  })
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a trimmed non-empty string`)
  }
  return value
}
