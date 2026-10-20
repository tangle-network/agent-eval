/**
 * `SearchState`: the one projection of a search ledger.
 *
 * The same code checks every invariant for the producer's journal, the kernel,
 * and the Intelligence verifier, and builds the read model they share. It keeps
 * compact indexes (nodes, edges, cells, per-unit score sums, running audit
 * totals), not the raw event list, and applies each entry in time proportional
 * to that entry, so a search of any length appends at a constant cost.
 *
 * The journal asks for a snapshot after every append. A snapshot is a
 * `SearchStateView` that reads the live indexes, so taking one costs nothing.
 * The view is valid until the state applies its next entry; a read after that
 * throws rather than returning numbers from a later ledger position. Read the
 * ledger's state again to see newer entries. The audit, header, head and claim
 * on a view are plain values and stay readable.
 */

export { SEARCH_CLAIM_MAX_FINALISTS } from './search-ledger-constraints'
export { searchCellId, searchNodeId, searchTaskSetDigest } from './search-state-identity'
export { SearchState } from './search-state-projection'
export type {
  SearchCell,
  SearchCompletion,
  SearchDecisionRecord,
  SearchNode,
  SearchOperation,
  SearchScoredCell,
  SearchSpend,
  SearchUnitScore,
} from './search-state-types'
export { SearchStateView, searchUnitScores } from './search-state-view'
