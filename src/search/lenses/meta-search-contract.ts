import type {
  NodeEstimate,
  SearchClaim,
  SearchCloseReason,
  SearchEstimateMethod,
  SearchLedgerHash,
  SearchModelIdentity,
  SearchProposerKind,
  SearchSourceRef,
} from '../../campaign/search-ledger-types'

/** The configuration that ran a search, as its ledger records it. */
export interface SearchPolicyGenome {
  /** `policy.expansion`: the policy's name with its parameters. A parameter
   * equal to the search's own seed (`seed=<n>`) reads `seed=<search>`: the
   * seed varies per search and is not a configuration choice. */
  expansion: string
  /** `policy.allocation`: the allocator's name with its rung sizes. */
  allocation: string
  budget: {
    maxUsd: number | null
    maxCells: number | null
    maxNodes: number | null
    maxConcurrency: number | null
    reservedClaimUsd: number
  }
  /** Every proposer a non-seed edge names, in canonical order. Unknown when
   * the search recorded no proposal, so its proposer cannot be read. */
  proposers:
    | Array<{ kind: SearchProposerKind; name: string; source: SearchSourceRef }>
    | {
        unknown: string
      }
  /** What ran the candidate-generation operations (a proposer's model, or
   * deterministic code), in canonical order; unknown with no such operation. */
  proposerExecution:
    | Array<
        | { kind: 'model'; model: SearchModelIdentity }
        | { kind: 'deterministic'; source: SearchSourceRef }
      >
    | { unknown: string }
}

/** Why a search has no lift to score. */
export type MetaSearchUnscoredReason =
  | 'open'
  | 'no-claim'
  | 'claim-mismatch'
  | 'test-cannot-resolve'
  | 'no-valid-finalist'
  | 'insufficient'

export interface MetaSearchSpend {
  knownUsd: number
  /** Proven lower bounds of unknown costs. */
  floorUsd: number
  /** Cells and operations whose cost is unknown. */
  unknownCost: number
}

/** A search's lift per dollar: a value, a bound when some cost is only a
 * floor, or unknown. */
export type MetaSearchLiftPerUsd =
  | {
      status: 'known'
      value: number
      /** The lift's interval divided by the known spend, which is exact. */
      interval: [number, number] | null
    }
  | {
      status: 'bound'
      /** The lift divided by the committed spend, a lower bound on the true
       * spend: the true value lies at or below it for a gain and at or above
       * it for a loss. */
      value: number
      bound: 'at-most' | 'at-least'
      reason: string
    }
  | { status: 'unknown'; reason: string }

export type MetaSearchScore =
  | {
      status: 'scored'
      decision: 'ship' | 'hold'
      /** The node whose held-out lift this is. */
      nodeId: string
      /** The node against the root on the test split. */
      estimate: NodeEstimate
      /** `estimate.delta` oriented so a gain is positive, in the metric's units. */
      lift: number
      /** `estimate.interval`, oriented the same way; null below 6 units. */
      liftInterval: [number, number] | null
      spend: MetaSearchSpend
      liftPerUsd: MetaSearchLiftPerUsd
    }
  | {
      status: 'unscored'
      decision: SearchClaim['decision'] | null
      reason: MetaSearchUnscoredReason
      detail: string
      spend: MetaSearchSpend
    }

/** How a search relates to its parent in the forest. */
export type MetaSearchParent =
  | {
      relation: 'derived'
      searchId: string
      /** The parent's node this search started from. */
      nodeId: string
      /** The parent is among the searches the lens read. */
      present: boolean
    }
  | {
      relation: 'contained'
      searchId: string
      cellId: string
      attempt: number
      /** The outer node whose cell ran this search; null when the outer
       * search was not read. */
      nodeId: string | null
      present: boolean
    }

export interface MetaSearchEntry {
  searchId: string
  subject: string
  objective: { metric: string; direction: 'maximize' | 'minimize' }
  /** `subject · metric (direction)`: searches are compared only within one. */
  objectiveKey: string
  status: 'open' | 'closed'
  closeReason: SearchCloseReason | null
  genome: SearchPolicyGenome
  genomeDigest: SearchLedgerHash
  seed: number
  rootArtifactDigest: string | null
  nodes: number
  cells: { settled: number; test: number }
  claim: {
    decision: SearchClaim['decision']
    selected: string | null
    verification: 'verified' | 'mismatch' | 'unknown'
    reason: string
  } | null
  score: MetaSearchScore
  parent: MetaSearchParent | null
  children: string[]
  /** Edges from the forest's root; 0 for a root. */
  depth: number
  /** The search's own tree, for a glyph: `[nodeId, primaryParentId, status]`
   * in registration order, the first `glyphNodes`. */
  glyph: { nodes: Array<[string, string | null, string | null]>; omitted: number }
}

/** A configuration's lift per known dollar across its scored searches. */
export interface MetaSearchConfigurationEstimate {
  /** `searches`: the scored searches are the units. `test-units`: one scored
   * search, so its own test units are. */
  basis: 'searches' | 'test-units'
  n: number
  value: number | null
  method: SearchEstimateMethod
  interval: [number, number] | null
  /** How the interval was computed; null without one. */
  intervalMethod: 'percentile-bootstrap-of-mean' | 'paired-delta-test-over-usd' | null
}

export interface MetaSearchConfiguration {
  genomeDigest: SearchLedgerHash
  objectiveKey: string
  genome: SearchPolicyGenome
  searches: string[]
  decisions: { ship: number; hold: number; 'test-cannot-resolve': number; none: number }
  /** Searches with a known lift per dollar. */
  scored: number
  /** Searches whose lift per dollar is a bound. */
  bounded: number
  unscored: Partial<Record<MetaSearchUnscoredReason, number>>
  estimate: MetaSearchConfigurationEstimate
  /** Outer-search nodes whose cells ran this configuration's searches, with
   * the outer node's parent configuration and its paired estimate against it
   * on the outer search's ranking split. */
  outerNodes: Array<{
    searchId: string
    nodeId: string
    parentNodeId: string | null
    parentGenomeDigest: SearchLedgerHash | null
    againstParent: NodeEstimate | null
  }>
}

export interface MetaSearchData {
  searches: MetaSearchEntry[]
  roots: string[]
  /** Best first: by estimate, then configurations without one. */
  configurations: MetaSearchConfiguration[]
  objectives: string[]
  /** The objective the signal ranks within; null when none could be chosen. */
  signalObjective: string | null
}

/** The signal: the configuration with the largest estimated lift per known
 * dollar within one objective, with its interval, its method and its n. */
export interface BestPolicyConfiguration {
  /** Lift per known dollar of the best configuration; null when none has one. */
  liftPerUsd: number | null
  objectiveKey: string | null
  genomeDigest: SearchLedgerHash | null
  genome: SearchPolicyGenome | null
  interval: [number, number] | null
  method: SearchEstimateMethod | null
  intervalMethod: MetaSearchConfigurationEstimate['intervalMethod']
  basis: MetaSearchConfigurationEstimate['basis'] | null
  n: number
  /** The configuration's searches, and how many of them have a known lift
   * per dollar: the rest are unscored or bounded, never counted as 0. */
  searches: number
  scored: number
  /** An outer-search node whose artifact runs this configuration, when an
   * outer search ran it: the runnable configuration a caller derives the next
   * search from. Null for a configuration only free-standing searches ran. */
  outerNode: { searchId: string; nodeId: string } | null
  /** Why the value is what it is, including why it is null. */
  reason: string
}

export interface MetaSearchOptions {
  /** Nodes of each search's own tree carried for its glyph. Default 64. */
  glyphNodes?: number
  /** The objective key the signal ranks within. Default: the one objective
   * whose searches have a known lift per dollar; with several, the signal is
   * null until one is named. */
  objective?: string
}
