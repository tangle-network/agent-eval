import type { SupervisorRunTree } from './types'

export const SUPERVISOR_RUN_INTEGRITY_SCHEMA = 'tangle.supervisor-run-integrity@1'

export type SupervisorRunIntegritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type SupervisorRunSourceOnlyCheckCode =
  | 'journal-event-cardinality'
  | 'worker-control-join'
  | 'steer-ack-correlation'

export type SupervisorRunIntegrityIssueCode =
  | 'source-checks-unavailable'
  | 'node-schema-invalid'
  | 'node-checks-unavailable'
  | 'root-unavailable'
  | 'duplicate-rollout-id'
  | 'declared-root-missing'
  | 'root-has-parent'
  | 'root-role-invalid'
  | 'detached-node'
  | 'parent-missing'
  | 'cross-run-parent'
  | 'child-before-parent'
  | 'child-after-parent-close'
  | 'close-before-start'
  | 'parent-cycle'
  | 'child-terminal-unavailable'
  | 'transcript-unavailable'
  | 'profile-id-unavailable'
  | 'source-row-malformed'
  | 'source-event-identity-unavailable'
  | 'duplicate-spawn'
  | 'orphan-terminal'
  | 'duplicate-terminal'
  | 'worker-controls-unavailable'
  | 'worker-control-join-unavailable'
  | 'steer-request-id-unavailable'
  | 'steer-ack-id-unavailable'
  | 'steer-ack-status-unavailable'
  | 'duplicate-steer-request-id'
  | 'missing-steer-ack'
  | 'duplicate-steer-ack'
  | 'unknown-steer-ack'
  | 'steer-not-delivered'

export interface SupervisorRunIntegrityEvidence {
  readonly path: string
  readonly value: unknown
}

export interface SupervisorRunIntegrityIssue {
  readonly code: SupervisorRunIntegrityIssueCode
  readonly area: 'control-integrity' | 'capture-integrity'
  readonly severity: SupervisorRunIntegritySeverity
  readonly subject: string
  readonly claim: string
  readonly detail: string
  readonly evidence: readonly SupervisorRunIntegrityEvidence[]
  readonly recommendedAction: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SupervisorRunIntegrityReport {
  readonly schema: typeof SUPERVISOR_RUN_INTEGRITY_SCHEMA
  readonly runRef: string
  readonly input: 'sources' | 'tree'
  readonly tree: SupervisorRunTree
  readonly issues: readonly SupervisorRunIntegrityIssue[]
}

export interface SupervisorRunIntegrityOptions {
  /** Pins rollout provenance when source input must be projected into a tree. */
  readonly capturedAt?: string
}
