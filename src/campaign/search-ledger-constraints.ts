/** Shared ledger limits and structural event constraints for writers and replay. */

import { SearchLedgerIntegrityError } from './search-ledger-errors'
import type { SearchCellStage, SearchSplit } from './search-ledger-types'

export const MAX_LABEL_CHARS = 200
export const USD_TOLERANCE = 1e-9
/** A claim tests at most this many finalists against the root. */
export const SEARCH_CLAIM_MAX_FINALISTS = 3

export function assertStageSplit(
  cellId: string,
  stage: SearchCellStage,
  split: SearchSplit,
  isRoot: boolean,
): void {
  const allowed: Record<SearchCellStage, readonly SearchSplit[]> = {
    root: ['train', 'selection'],
    train: ['train'],
    screen: ['selection'],
    rung: ['selection'],
    claim: ['test'],
    external: ['train', 'selection'],
  }
  if (!allowed[stage].includes(split)) {
    throw integrity(`cell ${cellId}: a ${stage} cell cannot run on the ${split} split`)
  }
  if (stage === 'root' && !isRoot) {
    throw integrity(`cell ${cellId}: only the root node runs root cells`)
  }
}

export function assertUnique(values: readonly string[], label: string, eventId: string): void {
  if (new Set(values).size !== values.length) {
    throw integrity(`event ${eventId} contains duplicate ${label} values`)
  }
}
export function integrity(message: string): SearchLedgerIntegrityError {
  return new SearchLedgerIntegrityError(message)
}
