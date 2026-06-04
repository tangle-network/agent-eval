import { type BeliefCalibrationOptions, calibrateBeliefDecisions } from './calibration'
import { type BeliefOpeOptions, evaluateBeliefOffPolicy } from './ope'
import {
  type EvaluateBeliefSelectivePolicyOptions,
  evaluateBeliefSelectivePolicy,
} from './selective'
import type {
  BeliefDecisionPoint,
  BeliefEvaluationStatus,
  BeliefOpeStatus,
  BeliefOpeTargetPolicy,
  BeliefPolicyEvaluationReport,
  BeliefSelectivePolicy,
} from './types'

export interface AnalyzeBeliefPolicyOpeOptions extends BeliefOpeOptions {
  targetPolicy?: BeliefOpeTargetPolicy
}

export interface AnalyzeBeliefPolicyOptions {
  points: BeliefDecisionPoint[]
  policy: BeliefSelectivePolicy
  selective?: EvaluateBeliefSelectivePolicyOptions
  calibration?: BeliefCalibrationOptions
  ope?: AnalyzeBeliefPolicyOpeOptions
  requireOpe?: boolean
}

export function analyzeBeliefPolicy(
  options: AnalyzeBeliefPolicyOptions,
): BeliefPolicyEvaluationReport {
  const selective = evaluateBeliefSelectivePolicy(options.points, options.policy, options.selective)
  const calibration = calibrateBeliefDecisions(options.points, options.calibration)
  const opeTargetPolicy = options.ope?.targetPolicy
  const ope = opeTargetPolicy
    ? evaluateBeliefOffPolicy(options.points, opeTargetPolicy, options.ope)
    : null
  const diagnostics: string[] = []
  const selectiveStatus = selective.recommendation
  const calibrationStatus = calibration ? 'supported' : 'unsupported'
  const opeRequested = options.requireOpe === true || options.ope !== undefined
  const opeStatus: BeliefOpeStatus = ope
    ? ope.support.supported
      ? 'supported'
      : 'unsupported'
    : opeRequested
      ? 'unsupported'
      : 'not_requested'

  if (!calibration) diagnostics.push('calibration unsupported: not enough confidence/outcome pairs')
  if (opeRequested && !opeTargetPolicy) diagnostics.push('OPE unsupported: missing target policy')
  else if (ope && !ope.support.supported)
    diagnostics.push(...ope.support.reasons.map((reason) => `OPE unsupported: ${reason}`))

  const status = overallStatus({
    selectiveStatus,
    hasCalibration: calibration !== null,
    opeStatus,
    opeRequested,
  })

  return {
    policyId: options.policy.id,
    n: options.points.length,
    status,
    selectiveStatus,
    calibrationStatus,
    opeStatus,
    ...(ope ? { opeTargetPolicyId: ope.targetPolicyId } : {}),
    selective,
    ...(calibration ? { calibration } : {}),
    ...(ope ? { ope } : {}),
    diagnostics,
  }
}

function overallStatus(options: {
  selectiveStatus: BeliefEvaluationStatus
  hasCalibration: boolean
  opeStatus: BeliefOpeStatus
  opeRequested: boolean
}): BeliefEvaluationStatus {
  if (options.selectiveStatus === 'need_more_data' || !options.hasCalibration) {
    return 'need_more_data'
  }
  if (options.selectiveStatus === 'hold') return 'hold'
  if (options.opeRequested && options.opeStatus !== 'supported') return 'hold'
  return 'ship'
}
