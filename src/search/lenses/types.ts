/**
 * The shape every search lens returns.
 *
 * A lens is a pure function of a `SearchStateView` and its options. It returns
 * JSON that a view (the Intelligence page, `agent-eval search show`) renders,
 * and one named number a `SearchPolicy` can read, so what a person sees is
 * what the climber acts on. A lens never renders and never writes a record.
 */

import type { SearchLedgerHash } from '../../campaign/search-ledger-types'

export interface SearchLensSignal {
  /** Stable name a policy reads the value by. */
  name: string
  /** Null when the search holds too little evidence; never a stand-in zero. */
  value: number | null
  /** How the value was computed, or why it is null. */
  basis: string
}

export interface SearchLensResult<TData> {
  lens: string
  searchId: string
  /** The ledger position the lens read. */
  head: { sequence: number; entryHash: SearchLedgerHash } | null
  data: TData
  signal: SearchLensSignal
}
