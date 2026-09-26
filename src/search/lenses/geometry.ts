/**
 * What the geometry lenses (`landscape`, `skillManifold`) share beyond
 * `./shared`: a signal that states its method and sample, the estimate method
 * a number of shared units supports, and the nodes whose screen finished.
 *
 * A lens is a pure function of a `SearchStateView` (search-tree design §12).
 * It returns JSON for a view (Intelligence renders it; `agent-eval search
 * show` prints it as text) and one named numeric signal that a `SearchPolicy`
 * or an allocator can read, so what a person sees is what the climber uses.
 * A lens never renders, never reads a blob or a clock, and never imputes a
 * score or a cost: a value the ledger cannot support is null, with the reason.
 */

import type { SearchEstimateMethod } from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { BOOTSTRAP_GATE_MIN_N } from '../../statistics'
import { INSUFFICIENT_FROM, type LensResult, type LensSignal } from './shared'

/** The one number a geometry lens exposes to policies: the shared
 * `LensSignal`, with the noise model and sample it rests on. */
export interface GeometrySignal extends LensSignal<number | null> {
  /** What the value is about when it names one thing, for example the unit
   * `nextUnit` recommends; null otherwise. */
  subject: string | null
  /** How the value is computed, including its noise model. */
  method: string
  /** The sample the value rests on, in the unit `method` names. */
  n: number
  /** Why `value` is null; null when it is not. */
  insufficient: string | null
}

export interface GeometryLensResult<TData> extends LensResult<TData, number | null> {
  /** The lens name, for example `landscape`. */
  lens: string
  searchId: string
  /** The ledger position the lens read: the head's sequence, or -1 before any entry. */
  sequence: number
  signal: GeometrySignal
}

/** Attempts the kernel gives a retryable errored cell by default. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** The method `estimateNode` reports for a paired sample of `pairs` units. */
export function estimateMethodFor(pairs: number): SearchEstimateMethod {
  if (pairs < 2) return 'none'
  if (pairs < INSUFFICIENT_FROM) return 'insufficient'
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

/** Rounded for JSON a person reads; 9 decimals keep the bits a renderer
 * needs and drop float noise. */
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

/** At most `cap` items, evenly spaced by position: a deterministic sample
 * that keeps a quadratic step bounded on a large search. */
export function evenSample<T>(items: readonly T[], cap: number): T[] {
  if (items.length <= cap) return [...items]
  return Array.from({ length: cap }, (_, index) => items[Math.floor((index * items.length) / cap)]!)
}

export function positiveInteger(owner: string, name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${owner}: ${name} must be a positive integer, got ${String(value)}`)
  }
  return value
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
