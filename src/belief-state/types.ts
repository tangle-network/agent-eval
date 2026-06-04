import type { CalibrationReport } from '../meta-eval/calibration'
import type { OffPolicyEstimate } from '../rl/off-policy'

export type BeliefDecisionKind =
  | 'continue'
  | 'verify'
  | 'ask'
  | 'retry'
  | 'stop'
  | 'memory-write'
  | 'memory-read'
  | 'tool-select'
  | 'skill-select'
  | 'workflow-select'
  | 'surface-promote'

export type BeliefEvidenceSource =
  | 'run'
  | 'span'
  | 'event'
  | 'finding'
  | 'memory'
  | 'knowledge'
  | 'policy'

export interface BeliefEvidenceRef {
  source: BeliefEvidenceSource
  id: string
  runId?: string
  spanId?: string
  eventId?: string
  detail?: string
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
  qHat?: number | null
  costUsd?: number
  evidence: BeliefEvidenceRef[]
  outcome?: BeliefDecisionOutcome
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
  qHat?: number | null
  reason?: string
}

export interface BeliefSelectivePolicy {
  id: string
  decide(point: BeliefDecisionPoint): BeliefPolicyDecision
}

export interface BeliefOpeTargetPolicy {
  id: string
  targetProbOf(point: BeliefDecisionPoint): number | null | undefined
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
