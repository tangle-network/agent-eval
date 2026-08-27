import type { CalibrationReport } from '../meta-eval/calibration'
import type { OffPolicyEstimate } from '../rl/off-policy'

export const BELIEF_DECISION_KINDS = [
  'continue',
  'verify',
  'ask',
  'retry',
  'stop',
  'memory-write',
  'memory-read',
  'tool-select',
  'skill-select',
  'workflow-select',
  'surface-promote',
] as const

export type BeliefDecisionKind = (typeof BELIEF_DECISION_KINDS)[number]

export const BELIEF_EVIDENCE_SOURCES = [
  'run',
  'span',
  'event',
  'finding',
  'memory',
  'knowledge',
  'policy',
] as const

export type BeliefEvidenceSource = (typeof BELIEF_EVIDENCE_SOURCES)[number]

export const BELIEF_EVIDENCE_QUALITIES = [
  'direct',
  'derived',
  'self-reported',
  'unverified',
  'stale',
  'contradicted',
] as const

export type BeliefEvidenceQuality = (typeof BELIEF_EVIDENCE_QUALITIES)[number]

export const BELIEF_EVALUATION_CRITERIA = [
  {
    id: 'capture-integrity',
    label: 'Capture integrity',
    reasonCodes: ['trace-missing', 'run-record-missing', 'backend-integrity-missing'],
  },
  {
    id: 'decision-completeness',
    label: 'Decision completeness',
    reasonCodes: [
      'candidate-actions-missing',
      'chosen-action-missing',
      'decision-evidence-missing',
    ],
  },
  {
    id: 'evidence-quality',
    label: 'Evidence quality',
    reasonCodes: [
      'evidence-stale',
      'evidence-contradictory',
      'evidence-unverified',
      'evidence-self-reported',
    ],
  },
  {
    id: 'outcome-quality',
    label: 'Outcome quality',
    reasonCodes: ['outcome-missing', 'outcome-delayed', 'cost-missing'],
  },
  {
    id: 'calibration',
    label: 'Calibration',
    reasonCodes: ['confidence-missing', 'calibration-unsupported', 'calibration-gap-high'],
  },
  {
    id: 'accepted-region-risk',
    label: 'Accepted-region risk',
    reasonCodes: ['accepted-error-high', 'coverage-too-low'],
  },
  {
    id: 'policy-value',
    label: 'Policy value',
    reasonCodes: ['utility-lift-missing', 'baseline-dominates', 'cost-too-high'],
  },
  {
    id: 'ope-support',
    label: 'OPE support',
    reasonCodes: [
      'behavior-propensity-missing',
      'behavior-propensity-invalid',
      'target-propensity-missing',
      'target-propensity-invalid',
      'effective-sample-size-low',
      'importance-weight-high',
    ],
  },
  {
    id: 'memory-health',
    label: 'Memory health',
    reasonCodes: [
      'memory-stale',
      'memory-poisoning-risk',
      'context-bloat',
      'memory-write-unverified',
    ],
  },
  {
    id: 'surface-attribution',
    label: 'Surface attribution',
    reasonCodes: ['surface-claim-unsupported', 'causal-attribution-missing'],
  },
  {
    id: 'generalization',
    label: 'Generalization',
    reasonCodes: [
      'split-missing',
      'holdout-regression',
      'task-family-coverage-low',
      'leakage-risk',
    ],
  },
  {
    id: 'promotion',
    label: 'Promotion',
    reasonCodes: ['negative-control-failed', 'promotion-gate-failed', 'human-review-required'],
  },
] as const

export type BeliefEvaluationCriterionId = (typeof BELIEF_EVALUATION_CRITERIA)[number]['id']
export type BeliefDecisionReasonCode =
  (typeof BELIEF_EVALUATION_CRITERIA)[number]['reasonCodes'][number]

export interface BeliefDecisionReason {
  code: BeliefDecisionReasonCode
  criterion?: BeliefEvaluationCriterionId
  detail?: string
  evidenceIds?: string[]
  metadata?: Record<string, unknown>
}

export function isBeliefDecisionKind(value: unknown): value is BeliefDecisionKind {
  return typeof value === 'string' && BELIEF_DECISION_KINDS.includes(value as BeliefDecisionKind)
}

export function isBeliefEvidenceSource(value: unknown): value is BeliefEvidenceSource {
  return (
    typeof value === 'string' && BELIEF_EVIDENCE_SOURCES.includes(value as BeliefEvidenceSource)
  )
}

export interface BeliefEvidenceRef {
  source: BeliefEvidenceSource
  id: string
  runId?: string
  spanId?: string
  eventId?: string
  detail?: string
  quality?: BeliefEvidenceQuality
  observedAt?: string
  metadata?: Record<string, unknown>
}

export interface BeliefDecisionOutcome {
  success?: boolean
  score?: number
  reward?: number
  costUsd?: number
  observedAt?: string
  metadata?: Record<string, unknown>
}

export interface BeliefDecisionPoint {
  id: string
  runId: string
  scenarioId?: string
  stepIndex: number
  kind: BeliefDecisionKind
  chosenAction: string
  candidateActions?: string[]
  confidence?: number
  behaviorProb?: number
  targetProb?: number
  qHatChosen?: number | null
  vHatTarget?: number | null
  /** @deprecated Use `qHatChosen` and `vHatTarget` together. */
  qHat?: number | null
  costUsd?: number
  evidence: BeliefEvidenceRef[]
  outcome?: BeliefDecisionOutcome
  reasons?: BeliefDecisionReason[]
  metadata?: Record<string, unknown>
}

export interface BeliefDecisionExtractionDiagnostic {
  runId: string
  eventId?: string
  severity: 'info' | 'warning' | 'error'
  reason: string
}

export interface BeliefDecisionExtractionReport {
  decisions: BeliefDecisionPoint[]
  diagnostics: BeliefDecisionExtractionDiagnostic[]
}

export type BeliefPolicyAction = 'accept' | 'defer' | 'verify' | 'ask' | 'retry' | 'stop'

export interface BeliefPolicyDecision {
  action: BeliefPolicyAction
  confidence?: number
  targetProb?: number
  qHatChosen?: number | null
  vHatTarget?: number | null
  /** @deprecated Use `qHatChosen` and `vHatTarget` together. */
  qHat?: number | null
  reason?: string
  reasons?: BeliefDecisionReason[]
}

export interface BeliefSelectivePolicy {
  id: string
  decide(point: BeliefDecisionPoint): BeliefPolicyDecision
}

export interface BeliefOpeTargetPolicy {
  id: string
  targetProbOf(point: BeliefDecisionPoint): number | null | undefined
  qHatChosenOf?(point: BeliefDecisionPoint): number | null | undefined
  vHatTargetOf?(point: BeliefDecisionPoint): number | null | undefined
  /** @deprecated Use `qHatChosenOf` and `vHatTargetOf` together. */
  qHatOf?(point: BeliefDecisionPoint): number | null | undefined
}

export interface BeliefUtilityOptions {
  successUtility?: number
  failureUtility?: number
  deferUtility?: number
  verifyCost?: number
  askCost?: number
  retryCost?: number
  stopUtility?: number
  costWeight?: number
}

export interface BeliefSelectivePolicyMetrics {
  policyId: string
  n: number
  accepted: number
  rejected: number
  coverage: number
  acceptedErrorRate: number
  baselineUtility: number
  policyUtility: number
  utilityDelta: number
  utilityCi95: { mean: number; lower: number; upper: number }
  rejectedMeanReward: number | null
  recommendation: 'ship' | 'hold' | 'need_more_data'
  reasons: string[]
}

export interface BeliefOpeSupportDiagnostics {
  supported: boolean
  n: number
  dropped: number
  effectiveSampleSize: number
  effectiveSampleRatio: number
  maxImportanceWeight: number
  reasons: string[]
}

export interface BeliefOpeReport {
  targetPolicyId: string
  ips: OffPolicyEstimate
  snips: OffPolicyEstimate
  dr: OffPolicyEstimate
  support: BeliefOpeSupportDiagnostics
}

export type BeliefEvaluationStatus = 'ship' | 'hold' | 'need_more_data'
export type BeliefCalibrationStatus = 'supported' | 'unsupported'
export type BeliefOpeStatus = 'supported' | 'unsupported' | 'not_requested'

export interface BeliefPolicyEvaluationReport {
  policyId: string
  n: number
  status: BeliefEvaluationStatus
  selectiveStatus: BeliefEvaluationStatus
  calibrationStatus: BeliefCalibrationStatus
  opeStatus: BeliefOpeStatus
  opeTargetPolicyId?: string
  selective: BeliefSelectivePolicyMetrics
  calibration?: CalibrationReport
  ope?: BeliefOpeReport
  diagnostics: string[]
}
