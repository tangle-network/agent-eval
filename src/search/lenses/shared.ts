/**
 * Reads the geometry lenses share: the ranked split, the estimate method a
 * number of shared units supports, and the nodes whose screen finished.
 */

import type { SearchEstimateMethod, SearchSplit } from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { minimumPairsForPairedDeltaTest } from '../../paired-delta-test'
import { BOOTSTRAP_GATE_MIN_N } from '../../statistics'

/** 6 at 95 %: below this many shared units an estimate is `insufficient`
 * (search-tree design §6.4, the library's own sign-test minimum). */
export const DESCRIPTIVE_FROM_UNITS = minimumPairsForPairedDeltaTest(0.95)

/** Attempts the kernel gives a retryable errored cell by default. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** The split a search ranks nodes on: selection when it declares one, else
 * train, as the kernel's policy view and `search show` choose it. */
export function rankedSplit(state: SearchStateView): 'selection' | 'train' {
  const header = state.header
  return header && header.splits.selection.tasks.length > 0 ? 'selection' : 'train'
}

/** The method `estimateNode` reports for a paired sample of `pairs` units. */
export function estimateMethodFor(pairs: number): SearchEstimateMethod {
  if (pairs < 2) return 'none'
  if (pairs < DESCRIPTIVE_FROM_UNITS) return 'insufficient'
  if (pairs < BOOTSTRAP_GATE_MIN_N) return 'descriptive'
  return 'bootstrap'
}

/**
 * Nodes whose screen finished, in registration order, root first: the
 * ledger's reading of the kernel's `screened` list. A node counts once it is
 * not decided invalid, has an edge, and every cell it was allocated outside a
 * rung or the claim can no longer run (scored, final, cancelled, or errored
 * with no attempt left). Cells a rung opened later do not un-screen it.
 */
export function screenedNodes(
  state: SearchStateView,
  options: { maxAttempts?: number } = {},
): string[] {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const screened: string[] = []
  for (const node of state.nodes()) {
    if (node.status === 'invalid' || node.edgeIds.length === 0) continue
    let allocated = 0
    let open = false
    for (const cell of state.cells({ nodeId: node.nodeId })) {
      if (cell.stage === 'rung' || cell.stage === 'claim') continue
      allocated += 1
      const done =
        cell.final ||
        cell.cancelled !== null ||
        (cell.outcome === 'errored' && cell.attempts >= maxAttempts)
      if (!done) {
        open = true
        break
      }
    }
    if (allocated > 0 && !open) screened.push(node.nodeId)
  }
  return screened
}

/** The head's sequence, or -1 before the first entry. */
export function headSequence(state: SearchStateView): number {
  return state.head?.sequence ?? -1
}

export function isSplit(value: string): value is SearchSplit {
  return value === 'train' || value === 'selection' || value === 'test'
}

/** Rounded for JSON a person reads; 9 significant decimals keep the bits a
 * renderer needs and drop float noise. */
export function round9(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9
  return rounded === 0 ? 0 : rounded
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
