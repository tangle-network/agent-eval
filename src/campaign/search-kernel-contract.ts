/** Search execution ports, persisted proposal shape, and versioned kernel rules. */
import { hashCanonical } from '../ledger-core/canonical'
import type { SearchAllocator, SearchCellPlan } from './allocation'
import type { SearchClaimVerification } from './search-claim'
import type {
  RegisterSearchNodeInput,
  SearchRecorder,
  SettleSearchCellInput,
} from './search-ledger-recording'
import type {
  SearchArtifactRef,
  SearchAttemptAccounting,
  SearchCellStage,
  SearchClaim,
  SearchCloseReason,
  SearchEdgeOperator,
  SearchOperationRecordedEvent,
  SearchProposerKind,
  SearchSourceRef,
  SearchSplit,
  SearchUnknown,
} from './search-ledger-types'
import type { SearchPolicy } from './search-policy'
import type { SearchNode, SearchStateView } from './search-state'

/**
 * Every rule the kernel's decisions depend on. Its digest is the kernel's
 * revision in a ledger's `process.executionRef`; change a value here whenever
 * a rule changes, so the revision moves with it.
 */
const KERNEL_DEFINITION = {
  name: 'tangle.search-kernel.2026-09',
  dispatch:
    'claim, then rung and root, then screen, then train; first allocated first within a stage',
  expansion:
    'when no cell waits, fewer than twice the lanes capacity run, the cap admits one proposal and its expected screens, and overspend has not taken the search past its cap',
  parents: 'a policy names at least one parent, and every parent finished its screen',
  reservation: {
    hard: 'the lane per-cell maximum',
    estimate: '1.5 times the p99 of the lane settled cells once 20 settled, else the lane prior',
  },
  retries: 'a retryable errored attempt runs again, up to maxAttempts',
  rungs:
    'when a node finishes its cells, the allocator names the nodes it advances, deepest rung first; each is recorded advanced and its rung allocated when the cap admits the rung',
  resume:
    'an unrecorded operation is recorded failed at an unknown cost with floor 0; a recorded proposal is finished from its stored output; an unsettled cell is offered to adopt before it runs',
  writers: 'one kernel per ledger file on a host, by a pid lock beside the ledger',
  divergence:
    'a node whose train mean over shared units rises above its parent while its descriptive or bootstrap selection interval against the parent lies wholly on the worse side is decided invalid when its cells finish',
  claim:
    'with a test split: after expansion stops, the claim plan is stored on the claim operation, the finalists are decided, the root and finalist test cells run together, and the claim decides; the kernel refuses to start a claim without a selection split, a minimumEffect, a pinned judge, or (under a cap) a claim reserve for the root and 3 finalists plus a cap for one screening round',
  close:
    'the allocator prunes the nodes left waiting on a rung, except the policy leader; then, with a test split, the claim decides; without one, the policy leader is selected when it has a scored cell; every other undecided node is rejected',
  complete:
    'a node leads only when it has a scored cell on the ranked split and no cell there ended unscored: a final unscored outcome, or an error with no attempt left',
} as const

/** The kernel every `runSearch` ledger names as its search implementation. */
export const SEARCH_KERNEL_SOURCE: SearchSourceRef = {
  uri: 'npm:@tangle-network/agent-eval#runSearch',
  revision: hashCanonical(KERNEL_DEFINITION),
}

export { USD_TOLERANCE } from './search-ledger-constraints'
/** The operation that holds the claim's plan. */
export const CLAIM_OPERATION = 'claim'
/** Settled cells a lane needs before its own cost distribution sets its estimate. */
export const ESTIMATE_FROM_CELLS = 20
export const ESTIMATE_MARGIN = 1.5
export const DEFAULT_MAX_ATTEMPTS = 3
/** Dispatch order: claim cells first, then rungs and the root, then screens, then train. */
export const STAGE_PRIORITY: Record<SearchCellStage, number> = {
  claim: 0,
  rung: 1,
  root: 1,
  screen: 2,
  train: 3,
  external: 3,
}

/** An execution lane: a pool of slots whose cells share a cost rule. */
export interface SearchLane {
  name: string
  /** Cells the lane runs at once. */
  capacity: number
  /** `hard`: the lane enforces `cellUsd` as each cell's maximum. `estimate`:
   * it cannot, and the kernel holds an estimate, recording any overshoot. */
  costCap: 'hard' | 'estimate'
  /** The enforced per-cell maximum of a hard lane; the prior estimate of an
   * estimate lane until it has settled enough cells to estimate its own. */
  cellUsd: number
}

/** One attempt at one cell, as the kernel hands it to an executor. */
export interface SearchCellWork<TArtifact> {
  searchId: string
  cellId: string
  nodeId: string
  taskId: string
  unitId: string
  split: SearchSplit
  rep: number
  stage: SearchCellStage
  lane: string
  attempt: number
  /** `cellId:attempt`: the id an executor keys the attempt's run by. */
  runId: string
  artifact: TArtifact
  signal: AbortSignal
}

/** What an attempt produced: everything `cell-settled` records except the
 * coordinates the kernel owns. An environment fault is an `errored` outcome,
 * not a rejection; a rejection stops the search. */
export type SearchCellResult = Omit<SettleSearchCellInput, 'cellId' | 'attempt'>

/** The executor port: lanes, placement, running a cell, and adopting an
 * attempt an earlier kernel process started. */
export interface SearchExecutor<TArtifact> {
  lanes(): readonly SearchLane[]
  /** The lane a planned cell runs on. */
  place(cell: SearchCellPlan & { nodeId: string }): string
  run(work: SearchCellWork<TArtifact>): Promise<SearchCellResult>
  /** The result of `work.runId` if the executor already has it, else null.
   * Called before the first dispatch of a cell the ledger shows unsettled when
   * the kernel starts, so a restart does not run an attempt twice. */
  adopt(work: SearchCellWork<TArtifact>): Promise<SearchCellResult | null>
}

/** How a search stores, compares and restores its artifacts. */
export interface SearchArtifactCodec<TArtifact> {
  /** The artifact as a content-addressed node; stores its bytes. */
  node(recorder: SearchRecorder, artifact: TArtifact): RegisterSearchNodeInput
  /** The parent-to-child diff, stored as a blob, or why there is none. */
  diff(
    recorder: SearchRecorder,
    parent: TArtifact,
    child: TArtifact,
  ): SearchArtifactRef | SearchUnknown
  /** The artifact a node holds, read back from its stored bytes. */
  load(recorder: SearchRecorder, node: SearchNode): TArtifact
}

export interface SearchProposalRequest<TArtifact> {
  expansion: number
  operationId: string
  operator: Exclude<SearchEdgeOperator, 'seed' | 'derive'>
  /** The parents the policy chose, primary first. */
  parents: ReadonlyArray<{ nodeId: string; artifact: TArtifact }>
  /** The node the search keeps now. */
  leader: string
  signal: AbortSignal
}

/** One child a proposal returned. */
export interface SearchProposedChild<TArtifact> {
  artifact: TArtifact
  label: string
  /** The proposer's reason; redacted with the share profile before it is stored. */
  rationale: string
  /** Typed JSON the proposer attaches to the child, stored with the proposal
   * and never interpreted by the kernel. */
  attribution?: Readonly<Record<string, unknown>>
}

export interface SearchProposalResult<TArtifact> {
  children: ReadonlyArray<SearchProposedChild<TArtifact>>
  /** Set when the proposer judges the search converged; expansion stops. */
  stop?: string
  /** What generated the children; default the port's `execution`. */
  execution?: SearchOperationRecordedEvent['execution']
  accounting: SearchAttemptAccounting
}

/** The proposer port: derives children from the parents the policy chose. */
export interface SearchProposerPort<TArtifact> {
  readonly name: string
  readonly kind: SearchProposerKind
  readonly source: SearchSourceRef
  readonly execution: SearchOperationRecordedEvent['execution']
  /** Prior hold for one proposal until 20 proposals have settled. Default 0. */
  readonly reservationUsd?: number
  /** Children one proposal usually returns, to price an expansion's screens
   * before it runs. Default 1. */
  readonly childrenPerProposal?: number
  propose(request: SearchProposalRequest<TArtifact>): Promise<SearchProposalResult<TArtifact>>
}

export interface RunSearchOptions<TArtifact> {
  /** An opened recorder; its header names this policy and allocator. */
  recorder: SearchRecorder
  /** The starting artifact: the seeded root. */
  root: TArtifact
  codec: SearchArtifactCodec<TArtifact>
  policy: SearchPolicy
  allocation: SearchAllocator
  proposer: SearchProposerPort<TArtifact>
  executor: SearchExecutor<TArtifact>
  /** Refuse a child before it runs: the reason, or null to admit it. A
   * refused child is recorded, decided `invalid`, and never becomes a parent. */
  admit?: (artifact: TArtifact) => string | null
  /** Stop expanding after this many proposals. */
  maxExpansions?: number
  /** Attempts per cell for retryable environment errors. Default 3. */
  maxAttempts?: number
  /** Aborting pauses the search: in-flight cells are aborted, what settled is
   * recorded, the ledger stays open, and the call rejects. Run the kernel on
   * the same ledger again to continue. */
  signal?: AbortSignal
  /** Milliseconds since the epoch, for the deadline. Default `Date.now`. */
  now?: () => number
}

export interface SearchRunResult {
  /** The closed search. */
  state: SearchStateView
  /** The node the search keeps: the claim's selection, or without a claim the
   * policy leader; the root when nothing was selected. */
  leader: string
  reason: SearchCloseReason
  /** The claim on the sealed test split; null for a search without one. */
  claim: SearchClaim | null
  /** The claim made again from the ledger alone (`verifySearchClaim`): never
   * `mismatch`, which `runSearch` throws; `unknown` for a claim another rule
   * revision made; null without a claim. */
  claimVerification: SearchClaimVerification | null
}

/** The stored output of one proposal: enough to register its children again. */
export interface SearchProposalBlob {
  kind: 'search-proposal'
  operator: SearchProposalRequest<unknown>['operator']
  parents: string[]
  selection: { rule: string; evidence: Record<string, number> }
  children: Array<{
    node: RegisterSearchNodeInput
    diffs: Array<SearchArtifactRef | SearchUnknown>
    label: string
    rationale: string
    attribution: Readonly<Record<string, unknown>> | null
    invalid: string | null
  }>
}

/** The expansion index a kernel operation id encodes, or null. */
export function searchExpansionIndex(operationId: string): number | null {
  const match = /^expand-(\d+)$/.exec(operationId)
  return match ? Number(match[1]) : null
}
