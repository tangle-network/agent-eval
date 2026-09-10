import type { LedgerHash } from '../ledger-core'

export const SEARCH_LEDGER_SCHEMA = 'tangle.search-ledger.v1' as const

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

/** Content-addressed artifact or receipt. Mutable paths are locators only; the
 * digest and byte length bind the exact bytes used by the search. */
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

export interface SearchModelIdentity {
  provider: string
  snapshot: string
}

export interface SearchCandidateSurface {
  surfaceId: string
  kind: SearchSurfaceKind
  artifact: SearchArtifactRef
}

export interface SearchCandidateLineage {
  /** Existing `LineageNode.id`; this ledger references rather than embeds it. */
  lineageNodeId: string
  parentCandidateIds: string[]
  generation: number
  proposer: string
  proposerSource: SearchSourceRef
}

export type SearchOperationKind =
  | 'candidate-generation'
  | 'analysis'
  | 'selection'
  | 'judge'
  | 'other'

export interface SearchPlannedTask {
  taskId: string
  source: SearchSourceRef
  benchmark: SearchSourceRef
  /** Maximum transport attempts for this task and candidate. Only an explicit
   * passed/failed outcome satisfies the planned denominator. */
  maxAttempts: number
}

export interface SearchPlannedOperation {
  operationId: string
  kind: SearchOperationKind
}

export interface SearchCandidateSlot {
  slotId: string
  /** Planned candidate-generation call that must either produce this slot or
   * fail before the slot can be closed. Several slots may share one batched call. */
  generationOperationId: string
}

export interface SearchPlan {
  /** Stable slots and their proposer calls are frozen before search begins. */
  candidateSlots: SearchCandidateSlot[]
  /** Every task applies to every successfully registered candidate. */
  tasks: SearchPlannedTask[]
  /** Non-task spend slots: proposal, analysis, selection, extra judges, etc. */
  operations: SearchPlannedOperation[]
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
      /** Known spend may still be a lower bound when one call was unpriced. */
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

/** Per-attempt proof that a declared candidate surface was or was not active,
 * plus measured effect when the experiment supports attribution. */
export interface SearchSurfaceEvidence {
  surfaceId: string
  fired: boolean
  firingCount: number
  effect: SearchSurfaceEffect
  evidence: SearchArtifactRef[]
}

interface SearchLedgerEventBase {
  eventId: string
  occurredAt: string
  artifacts: SearchArtifactRef[]
}

export interface SearchPlannedEvent extends SearchLedgerEventBase {
  kind: 'search-planned'
  plan: SearchPlan
}

/** Additional candidate slots and operations for a search whose length is not
 * known when it starts. The plan stays the first event and the planned task
 * denominator stays frozen: extending tasks would retroactively reopen
 * candidates that already closed theirs. */
export interface SearchPlanExtendedEvent extends SearchLedgerEventBase {
  kind: 'search-plan-extended'
  extension: {
    candidateSlots: SearchCandidateSlot[]
    operations: SearchPlannedOperation[]
  }
}

export interface SearchCandidateRegisteredEvent extends SearchLedgerEventBase {
  kind: 'candidate-registered'
  slotId: string
  generationOperationId: string
  candidateId: string
  lineage: SearchCandidateLineage
  surfaces: SearchCandidateSurface[]
}

export interface SearchCandidateSlotClosedEvent extends SearchLedgerEventBase {
  kind: 'candidate-slot-closed'
  slotId: string
  generationOperationId: string
  reason: SearchFailureReason
}

export interface SearchTaskAttemptedEvent extends SearchLedgerEventBase {
  kind: 'task-attempted'
  candidateId: string
  runId: string
  attemptIndex: number
  task: {
    taskId: string
    source: SearchSourceRef
  }
  identity: {
    model: SearchModelIdentity
    agent: SearchSourceRef
    benchmark: SearchSourceRef
  }
  outcome: SearchTaskOutcome
  accounting: SearchAttemptAccounting
  surfaceEvidence: SearchSurfaceEvidence[]
}

export interface SearchOperationRecordedEvent extends SearchLedgerEventBase {
  kind: 'search-operation-recorded'
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

export interface SearchCandidateDecidedEvent extends SearchLedgerEventBase {
  kind: 'candidate-decided'
  candidateId: string
  decision:
    | { status: 'selected' }
    | {
        status: 'rejected'
        reason: SearchFailureReason
      }
}

export interface SearchCompletedEvent extends SearchLedgerEventBase {
  kind: 'search-completed'
  result:
    | {
        status: 'selected'
        candidateId: string
      }
    | {
        status: 'all-rejected'
        reason: SearchFailureReason
      }
}

export type SearchLedgerEvent =
  | SearchPlannedEvent
  | SearchPlanExtendedEvent
  | SearchCandidateRegisteredEvent
  | SearchCandidateSlotClosedEvent
  | SearchTaskAttemptedEvent
  | SearchOperationRecordedEvent
  | SearchCandidateDecidedEvent
  | SearchCompletedEvent

export interface SearchLedgerEntry {
  schema: typeof SEARCH_LEDGER_SCHEMA
  campaignId: string
  sequence: number
  previousHash: SearchLedgerHash | null
  event: SearchLedgerEvent
  entryHash: SearchLedgerHash
}

export type SearchAccountingAudit =
  | {
      status: 'known'
      inputTokens: number
      outputTokens: number
      cachedTokens: number
      costUsd: number
    }
  | {
      status: 'partial'
      knownInputTokens: number
      knownOutputTokens: number
      knownCachedTokens: number
      knownCostUsd: number
      unknownTokenEventIds: string[]
      unknownCostEventIds: string[]
    }

export interface SearchLedgerAudit {
  campaignId: string
  eventCount: number
  candidateCount: number
  closedCandidateSlotCount: number
  attemptCount: number
  operationCount: number
  outcomes: { passed: number; failed: number; errored: number }
  operationOutcomes: { completed: number; partial: number; failed: number }
  decisions: { selected: number; rejected: number; pending: number }
  expected: {
    candidateSlots: number
    taskOutcomes: number
    operations: number
    missingCandidateSlots: string[]
    missingTaskOutcomes: string[]
    missingOperations: string[]
  }
  status: 'in-progress' | 'selected' | 'all-rejected'
  selectedCandidateId: string | null
  accounting: SearchAccountingAudit
  headHash: SearchLedgerHash | null
}

export interface SearchLedgerReplay {
  entries: SearchLedgerEntry[]
  plan: SearchPlannedEvent | null
  /** Appended plan extensions, in ledger order. The effective plan is the
   *  first plan event merged with these; `audit.expected` counts the merge. */
  planExtensions: SearchPlanExtendedEvent[]
  candidates: SearchCandidateRegisteredEvent[]
  closedCandidateSlots: SearchCandidateSlotClosedEvent[]
  attempts: SearchTaskAttemptedEvent[]
  operations: SearchOperationRecordedEvent[]
  decisions: SearchCandidateDecidedEvent[]
  completion: SearchCompletedEvent | null
  audit: SearchLedgerAudit
}

export interface SearchLedgerAppendResult {
  entry: SearchLedgerEntry
  /** False when the exact event was already durably present. */
  appended: boolean
  replay: SearchLedgerReplay
}
