/** Canonical identities for search nodes, cells, and split task sets. */

import { createHash } from 'node:crypto'
import { canonicalString, compareCodeUnits, hashCanonical } from '../ledger-core/canonical'
import type { SearchLedgerHash, SearchSplit, SearchTask } from './search-ledger-types'

/** Deterministic node id: identical content in one search is one node. */
export function searchNodeId(searchId: string, artifactDigest: string): string {
  return `node_${shortDigest([searchId, artifactDigest])}`
}

/** Deterministic cell id: one node on one task in one split at one repeat. */
export function searchCellId(
  searchId: string,
  nodeId: string,
  taskId: string,
  split: SearchSplit,
  rep: number,
): string {
  return `cell_${shortDigest([searchId, nodeId, taskId, split, rep])}`
}

/** Digest a split's task list in taskId order. */
export function searchTaskSetDigest(tasks: readonly SearchTask[]): SearchLedgerHash {
  return hashCanonical(
    [...tasks].sort((left, right) => compareCodeUnits(left.taskId, right.taskId)),
  )
}

/** 128 bits of SHA-256 over the canonical encoding: collision-safe and short
 * enough for directory names. */
function shortDigest(value: unknown): string {
  return createHash('sha256').update(canonicalString(value)).digest('hex').slice(0, 32)
}
