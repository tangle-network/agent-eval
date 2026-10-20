/**
 * The search kernel: one event-driven loop that every optimizer runs on.
 *
 * It separates three decisions that a generation loop fuses: where to expand
 * (the `SearchPolicy`), where to spend rollouts (the `SearchAllocator`), and
 * what to claim (the claim step, on the sealed test split). There is no
 * generation barrier: a lane that frees up takes the next allocated cell, and
 * the policy proposes when no cell waits and the budget admits a screen.
 *
 * Every step appends to the search ledger before the kernel acts on it, and the
 * ledger is the only checkpoint. Restarting the kernel on the same ledger
 * replays it and continues: an operation that started without a result is
 * recorded as failed with an unknown cost; a recorded proposal whose children
 * were not all registered is finished from its stored output; an allocated
 * cell without an outcome is first offered to `executor.adopt`, then run.
 *
 * The admission rule is the ledger's: committed spend, open reservations, the
 * unspent claim reserve and a new reservation stay within the cap. The kernel
 * checks it before it asks, prices an expansion (one proposal plus one screen)
 * before the proposer runs, and records spend above a reservation as
 * overspend, never refused.
 *
 * A search with a test split ends in its claim. When expansion stops, the
 * kernel fixes the claim's design (`planSearchClaim`) and stores it on the
 * ledger's `claim` operation before any test cell exists, decides the
 * finalists, runs the root's and the finalists' test cells together, and
 * closes with the claim `decideSearchClaim` makes from them. A node whose
 * train mean rises while its selection interval against its parent lies below
 * zero is decided `invalid` by the divergence rule and never becomes a parent.
 */

import type { RunSearchOptions, SearchRunResult } from './search-kernel-contract'
import { SearchKernel } from './search-kernel-runner'

export type {
  RunSearchOptions,
  SearchArtifactCodec,
  SearchCellResult,
  SearchCellWork,
  SearchExecutor,
  SearchLane,
  SearchProposalBlob,
  SearchProposalRequest,
  SearchProposalResult,
  SearchProposedChild,
  SearchProposerPort,
  SearchRunResult,
} from './search-kernel-contract'
export { SEARCH_KERNEL_SOURCE, searchExpansionIndex } from './search-kernel-contract'
export { searchDivergence, searchPolicyView } from './search-kernel-policy-view'

/** Run a search to its close, or continue one from its ledger. */
export async function runSearch<TArtifact>(
  options: RunSearchOptions<TArtifact>,
): Promise<SearchRunResult> {
  return new SearchKernel(options).run()
}
