import type { AgentProfileDiff } from '@tangle-network/agent-interface'
import type { EvaluationClaim } from '../experiment/claim'
import type { LedgerHash } from '../ledger-core'

/**
 * Schema tag every search-ledger entry carries. A ledger written under another
 * tag, such as the retired `tangle.search-ledger.v1` candidate-slot format, is
 * refused with its tag named; it is never translated.
 */
export const SEARCH_LEDGER_SCHEMA = 'tangle.search-ledger.2026-09' as const

export type SearchLedgerHash = LedgerHash

export type SearchSurfaceKind =
  | 'prompt'
  | 'tool-contract'
  | 'runtime-config'
  | 'memory'
  | 'knowledge'
  | 'agent-profile'
  | 'code'
  | 'deployment'

/** What a search's nodes are: a mutable agent surface, or an output artifact. */
export type SearchArtifactKind = SearchSurfaceKind | 'output'

/** Content-addressed artifact or receipt. Mutable paths are locators only; the
 * digest and byte length bind the exact bytes. */
export interface SearchArtifactRef {
  role: string
  uri: string
  sha256: SearchLedgerHash
  byteLength: number
}

/** Repository, dataset, or package source pinned to an immutable commit or
 * content digest. Branches, tags, and bare package versions are rejected. */
export interface SearchSourceRef {
  uri: string
  revision: string
}

/** A fact the producer does not have, with the reason. Unknown is never 0. */
export interface SearchUnknown {
  unknown: string
}

/** The model an attempt ran: an immutable snapshot, or a moving alias whose
 * served snapshot the producer could not observe. */
export type SearchModelIdentity =
  | { provider: string; snapshot: string }
  | { provider: string; alias: string; unknown: string }

export interface SearchCandidateSurface {
  surfaceId: string
  kind: SearchSurfaceKind
  artifact: SearchArtifactRef
}

export type SearchOperationKind =
  | 'candidate-generation'
  | 'analysis'
  | 'selection'
  | 'judge'
  | 'other'

/** train is the proposer's feedback, selection is private to the policy and
 * allocator, and test is sealed for the claim. */
export type SearchSplit = 'train' | 'selection' | 'test'

export interface SearchTask {
  taskId: string
  /** The claim's independent unit this task samples. Repeats and sibling
   * tasks of one unit average inside it before any statistic. */
  unitId: string
  source: SearchSourceRef
}

export interface SearchSplitTasks {
  /** `hashCanonical` of `tasks` in taskId order. */
  taskSetDigest: SearchLedgerHash
  tasks: SearchTask[]
}

export interface SearchSplits {
  train: SearchSplitTasks
  selection: SearchSplitTasks
  test: SearchSplitTasks
  /**
   * True when no test unit is a train or selection unit. A search that ran
   * with shared units records false, and then its claim cannot ship: a test
   * run of a seen unit measures a fresh run of a seen task, not an
   * improvement on unseen ones.
   */
  heldOutUnits: boolean
}

export interface SearchBudget {
  /** Hard dollar cap on committed spend plus open reservations; null = none declared. */
  maxUsd: number | null
  maxCells: number | null
  maxNodes: number | null
  /** ISO time after which the policy stops expanding. */
  deadline: string | null
  maxConcurrency: number | null
  /** Held back at start for the root's and finalists' test cells. */
  reservedClaimUsd: number
}

/** Where a cell ran relative to the search's decisions. */
export type SearchCellStage = 'root' | 'train' | 'screen' | 'rung' | 'claim' | 'external'

export type SearchEdgeOperator = 'seed' | 'draft' | 'improve' | 'debug' | 'merge' | 'derive'

/**
 * How an edge's parents are known. `explicit`: the proposer that created the
 * child emitted the edge. `correlated`: an importer joined an optimizer's own
 * parent record by content digest. `unknown`: no parent record exists, and the
 * edge has no parents. Nothing is inferred from timing or order.
 */
export type SearchEdgeAttribution = 'explicit' | 'correlated' | 'unknown'

export type SearchProposerKind = NonNullable<AgentProfileDiff['source']>['kind']

export interface SearchProposer {
  kind: SearchProposerKind
  name: string
  /** The candidate-generation operation that produced the child, when one was recorded. */
  operationId: string | null
  source: SearchSourceRef
}

export interface SearchNodeRef {
  searchId: string
  nodeId: string
}

/** Dollars held for a cell or operation before it runs. `hard`: the lane
 * enforces the maximum. `estimate`: the lane cannot, and overshoot is recorded. */
export interface SearchReservation {
  kind: 'hard' | 'estimate'
  usd: number
}

export type SearchTokenAccounting =
  | {
      status: 'known'
      inputTokens: number
      outputTokens: number
      cachedTokens: number
    }
  | {
      status: 'unknown'
      reason: string
    }

export type SearchCostAccounting =
  | {
      status: 'known'
      usd: number
      source: 'provider' | 'pricing-table' | 'free'
    }
  | {
      status: 'unknown'
      /** Proven part of the spend; the total may be higher. */
      knownLowerBoundUsd: number
      reason: string
    }

export interface SearchAttemptAccounting {
  tokens: SearchTokenAccounting
  cost: SearchCostAccounting
}

export interface SearchFailureReason {
  code: string
  message: string
}

/** `failed` is the agent's defect and carries a score; `errored` is the
 * environment's fault, carries none, and may be retried. */
export type SearchTaskOutcome =
  | {
      status: 'passed'
      score: number
      metrics: Record<string, number>
    }
  | {
      status: 'failed'
      score: number
      metrics: Record<string, number>
      failure: SearchFailureReason
    }
  | {
      status: 'errored'
      metrics: Record<string, number>
      error: SearchFailureReason & { retryable: boolean }
    }

export type SearchSurfaceEffect =
  | {
      status: 'measured'
      metric: string
      baselineValue: number
      candidateValue: number
      delta: number
    }
  | {
      status: 'not-measured'
      reason: string
    }

/** Per-attempt proof that a declared node surface did or did not fire. A
 * surface without evidence is unobserved, not fired. */
export interface SearchSurfaceEvidence {
  surfaceId: string
  fired: boolean
  firingCount: number
  effect: SearchSurfaceEffect
  evidence: SearchArtifactRef[]
}

export type SearchTraceRef =
  | {
      traceId: string
      execRunId: string | null
      spansWritten: number | null
      spansDropped: number | null
    }
  | SearchUnknown

export interface SearchExecutionIdentity {
  model: SearchModelIdentity
  agent: SearchSourceRef
  benchmark: SearchSourceRef
}

export type SearchEstimateMethod = 'none' | 'insufficient' | 'descriptive' | 'bootstrap'

/**
 * A paired contrast of one node against another on shared units. `none` below
 * 2 pairs, `insufficient` below 6, `descriptive` below 20, `bootstrap` from 20.
 * `estimateNode` computes it; the ledger records the estimate a decision used.
 */
export interface NodeEstimate {
  against: string
  split: SearchSplit
  /** Units the node scored on the split. */
  units: number
  /** Units both nodes scored: the paired sample. */
  pairs: number
  /** Mean per-unit difference, node minus `against`, in the metric's units.
   * Null for `none`. */
  delta: number | null
  /** Bootstrap interval on `delta`: spread for `descriptive`, decision grade
   * for `bootstrap`. Null for `none`, `insufficient` and an indeterminate sample. */
  interval: [number, number] | null
  method: SearchEstimateMethod
  /** Exact one-sided sign-test p toward improvement; `descriptive` only. */
  exactSignP: number | null
  /** Every paired delta is equal, so an interval would have zero width and
   * carries no evidence either way. */
  indeterminate: boolean
  /** Digest of the cells read, which also seeds the bootstrap. */
  cellSetDigest: SearchLedgerHash
  estimator: SearchSourceRef
}

export type SearchNodeDecision =
  | { status: 'advanced'; rung: number }
  | { status: 'pruned' }
  | { status: 'invalid' }
  | { status: 'finalist' }
  | { status: 'selected' }
  | { status: 'rejected' }

export type SearchNodeStatus = SearchNodeDecision['status']

export type SearchCloseReason =
  | 'budget'
  | 'deadline'
  | 'max-nodes'
  | 'patience'
  | 'converged'
  | 'aborted'

export type SearchCancelReason = 'pruned' | 'budget' | 'deadline' | 'aborted'

/** How the claim's paired decision reads per-unit test means, fixed before any
 * test cell runs. `binary`: every unit mean is 0 or `scale` (a pass rate).
 * `continuous`: any other score. */
export type SearchClaimEstimator = { kind: 'continuous' } | { kind: 'binary'; scale: number }

/**
 * Whether the test split can resolve the claim's minimum effect, checked on
 * selection data before any test cell runs. The power is the claim decision's
 * own promotion rate, simulated at a true improvement of `minimumEffect` with
 * the search's pooled between-unit variance.
 */
export type SearchClaimPower =
  | {
      adequate: boolean
      /** The improvement the test must resolve, in the metric's units. */
      minimumEffect: number
      powerAtMinimumEffect: number
      targetPower: number
      /** Independent test units. */
      units: number
      /** Finalists the family-wise confidence is divided among. */
      finalists: number
      /** Between-unit variance of selection improvements over the root, pooled
       * across every node with 2 or more shared units. */
      pooledVariance: number
      estimator: SearchClaimEstimator
    }
  | SearchUnknown

/** A finalist's paired test against the root at its Bonferroni confidence. */
export interface SearchClaimTest {
  /** Test units the finalist and the root both scored. */
  pairs: number
  /** `1 - (1 - claim.confidence) / finalists`. */
  confidence: number
  method: 'score-interval' | 'bootstrap-ci' | 'exact-sign'
  /** Node minus root in the metric's units, like `NodeEstimate.delta`; a
   * `minimize` improvement is negative. */
  delta: number
  interval: [number, number]
}

export interface SearchClaimFinalist {
  nodeId: string
  /** The node's test estimate against the root, as every view computes it.
   * Null when no test cell ran. */
  estimate: NodeEstimate | null
  /** The deciding test. Null when no test cell ran. */
  test: SearchClaimTest | null
  promote: boolean
}

/**
 * The claim made once, on the sealed test split. `selected` names the node the
 * search keeps: the shipped finalist on `ship`, the root otherwise (null when
 * the root has no scored cell).
 */
export interface SearchClaim {
  /** The claim procedure; its revision digests every rule and parameter. */
  rule: SearchSourceRef
  /** Family-wise confidence across the finalists. */
  confidence: number
  power: SearchClaimPower
  finalists: SearchClaimFinalist[]
  selected: string | null
  decision: 'ship' | 'hold' | 'test-cannot-resolve'
  /** Why the claim reached its decision. */
  reason: string
}

interface SearchLedgerEventBase {
  eventId: string
  occurredAt: string
  artifacts: SearchArtifactRef[]
}

/** First event, once: what is searched, against what, on which tasks, under which budget. */
export interface SearchOpenedEvent extends SearchLedgerEventBase {
  kind: 'search-opened'
  /** What the search improves, for example `vb/coder`. */
  subject: string
  process: { name: string; executionRef: SearchSourceRef }
  artifactKind: SearchArtifactKind
  objective: {
    metric: string
    direction: 'maximize' | 'minimize'
    judge: SearchSourceRef | SearchUnknown
    claim: EvaluationClaim
  }
  splits: SearchSplits
  policy: { expansion: string; allocation: string; seed: number }
  budget: SearchBudget
  /** The cell attempt of another search whose execution runs this one. */
  containment: { searchId: string; cellId: string; attempt: number } | null
  /** The node of another search this one starts from. */
  derivedFrom: { searchId: string; nodeId: string; headHash: SearchLedgerHash } | null
  identity: SearchExecutionIdentity
}

export interface SearchOperationStartedEvent extends SearchLedgerEventBase {
  kind: 'operation-started'
  operationId: string
  operationKind: SearchOperationKind
  reservation: SearchReservation | null
}

export interface SearchOperationRecordedEvent extends SearchLedgerEventBase {
  kind: 'operation-recorded'
  operationId: string
  operationKind: SearchOperationKind
  execution:
    | {
        kind: 'model'
        model: SearchModelIdentity
        source: SearchSourceRef
      }
    | {
        kind: 'deterministic'
        source: SearchSourceRef
      }
  outcome:
    | { status: 'completed' }
    | { status: 'partial'; failure: SearchFailureReason }
    | { status: 'failed'; failure: SearchFailureReason }
  accounting: SearchAttemptAccounting
}

/** A content-addressed artifact enters the search. `nodeId` is
 * `searchNodeId(searchId, artifactDigest)`, so a re-proposal of identical
 * content is a second edge into this node, never a second node. */
export interface SearchNodeRegisteredEvent extends SearchLedgerEventBase {
  kind: 'node-registered'
  nodeId: string
  artifactDigest: SearchLedgerHash
  artifact: SearchArtifactRef
  surfaces: SearchCandidateSurface[]
}

/** The proposal that derived a node from its parents. */
export interface SearchEdgeRecordedEvent extends SearchLedgerEventBase {
  kind: 'edge-recorded'
  edgeId: string
  childNodeId: string
  /** Primary parent first. Empty for `seed` and for `unknown` attribution; a
   * parent in another search appears only on a `derive` edge. On a node's
   * first edge every parent was registered before the child. A later edge is a
   * re-proposal and may name the child itself or a node registered after it
   * (a proposal that changed nothing, or a revert); such a parent is not
   * lineage, so follow an edge for ancestry only through earlier parents. */
  parents: SearchNodeRef[]
  operator: SearchEdgeOperator
  attribution: SearchEdgeAttribution
  /** Null only on a `seed` edge: the search's starting artifact was not proposed. */
  proposer: SearchProposer | null
  /** Why the policy chose these parents. */
  selection: { rule: string; evidence: Record<string, number> } | null
  /** The proposer's redacted rationale. */
  rationale: SearchArtifactRef | SearchUnknown
  /** One diff per parent, parent to child. */
  diffs: Array<SearchArtifactRef | SearchUnknown>
  /** At most 200 characters, redacted. */
  label: string
}

/** One node on one task in one split at one repeat is planned. `cellId` is
 * `searchCellId(searchId, nodeId, taskId, split, rep)`. */
export interface SearchCellAllocatedEvent extends SearchLedgerEventBase {
  kind: 'cell-allocated'
  cellId: string
  nodeId: string
  taskId: string
  unitId: string
  split: SearchSplit
  rep: number
  stage: SearchCellStage
  lane: string | null
  /** Null when no reservation was made: an external optimizer dispatched the cell. */
  reservation: SearchReservation | null
}

/** One attempt at a cell finished. Its RunRecord, when the producer minted one,
 * is an artifact with role `run-record`. */
export interface SearchCellSettledEvent extends SearchLedgerEventBase {
  kind: 'cell-settled'
  cellId: string
  /** Counted from 1 without gaps. */
  attempt: number
  /** `searchCellRunId({ cellId, attempt })`. */
  runId: string
  outcome: SearchTaskOutcome
  accounting: SearchAttemptAccounting
  boxMinutes: number | null
  wallMs: number | null
  queueMs: number | null
  placement: { lane: string; boxId: string | null } | null
  identity: SearchExecutionIdentity
  surfaceEvidence: SearchSurfaceEvidence[]
  traceRef: SearchTraceRef
}

export interface SearchCellCancelledEvent extends SearchLedgerEventBase {
  kind: 'cell-cancelled'
  cellId: string
  reason: SearchCancelReason
}

/** A policy, allocator or claim decision about a node. May repeat; the latest wins. */
export interface SearchNodeDecidedEvent extends SearchLedgerEventBase {
  kind: 'node-decided'
  nodeId: string
  decision: SearchNodeDecision
  basis: NodeEstimate | null
  rule: string
  reason: string
}

/** Last event, once. More work on a closed search is a derived search. */
export interface SearchClosedEvent extends SearchLedgerEventBase {
  kind: 'search-closed'
  reason: SearchCloseReason
  claim: SearchClaim | null
}

export type SearchLedgerEvent =
  | SearchOpenedEvent
  | SearchOperationStartedEvent
  | SearchOperationRecordedEvent
  | SearchNodeRegisteredEvent
  | SearchEdgeRecordedEvent
  | SearchCellAllocatedEvent
  | SearchCellSettledEvent
  | SearchCellCancelledEvent
  | SearchNodeDecidedEvent
  | SearchClosedEvent

export interface SearchLedgerEntry {
  schema: typeof SEARCH_LEDGER_SCHEMA
  searchId: string
  sequence: number
  previousHash: SearchLedgerHash | null
  event: SearchLedgerEvent
  entryHash: SearchLedgerHash
}

/** Counts and sums over the whole search. Every field is a number or a short
 * scalar, so reading the audit costs the same at any search size. */
export interface SearchAudit {
  searchId: string
  eventCount: number
  headHash: SearchLedgerHash | null
  status: 'open' | 'closed'
  closeReason: SearchCloseReason | null
  nodes: number
  /** Nodes with no edge yet: not placed in the tree. */
  nodesWithoutEdge: number
  /** Nodes whose latest decision is missing or `advanced`. */
  undecidedNodes: number
  selectedNodeId: string | null
  edges: { explicit: number; correlated: number; unknown: number; reproposals: number }
  cells: { allocated: number; settled: number; cancelled: number; open: number }
  attempts: number
  outcomes: { passed: number; failed: number; errored: number }
  operations: { started: number; recorded: number; open: number }
  spend: {
    /** Sum of known cell and operation costs. */
    knownUsd: number
    /** Sum of the proven lower bounds of unknown costs. */
    floorUsd: number
    unknownCostCells: number
    unknownCostOperations: number
    /** knownUsd + floorUsd. */
    committedUsd: number
    /** Reservations of unsettled cells and unrecorded operations, net of their spend so far. */
    openReservationUsd: number
    /** Spend above reservations. */
    overspendUsd: number
    /** Settled cells that ran without a reservation. */
    unreservedCells: number
    boxMinutes: number
  }
  tokens: {
    inputTokens: number
    outputTokens: number
    cachedTokens: number
    unknownTokenAttempts: number
  }
}
