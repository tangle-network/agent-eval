/**
 * The shape every search lens returns.
 *
 * A lens is a pure function of a `SearchStateView`. It returns JSON for a view
 * (Intelligence renders it; `agent-eval search show` prints it as text) and
 * one named numeric signal that a `SearchPolicy` or allocator can read, so
 * what a person sees is what the climber uses. A lens never renders pixels,
 * never reads a blob or a clock, and never imputes a score or a cost: a value
 * the ledger cannot support is null, with the reason.
 */

/** The one number a lens exposes to policies. */
export interface SearchLensSignal {
  /** Stable name a policy reads, for example `plateau`. */
  name: string
  /** Null when the ledger cannot support a value; `insufficient` says why. */
  value: number | null
  /** How the value is computed, including its noise model. */
  method: string
  /** The sample the value rests on, in the unit `method` names. */
  n: number
  /** Why `value` is null; null when it is not. */
  insufficient: string | null
}

export interface SearchLensResult<TData> {
  /** The lens name, for example `landscape`. */
  lens: string
  searchId: string
  /** The ledger position the lens read: the head's sequence, or -1 before any entry. */
  sequence: number
  data: TData
  signal: SearchLensSignal
}
