import { type BeliefCalibrationOptions, calibrateBeliefDecisions } from './calibration'
import { type BeliefOpeOptions, evaluateBeliefOffPolicy } from './ope'
import {
  type EvaluateBeliefSelectivePolicyOptions,
  evaluateBeliefSelectivePolicy,
} from './selective'
import type {
  BeliefDecisionPoint,
  BeliefPolicyEvaluationReport,
  BeliefSelectivePolicy,
} from './types'

export interface AnalyzeBeliefPolicyOptions {
  points: BeliefDecisionPoint[]
  policy: BeliefSelectivePolicy
  selective?: EvaluateBeliefSelectivePolicyOptions
  calibration?: BeliefCalibrationOptions
  ope?: BeliefOpeOptions
}

export function analyzeBeliefPolicy(
  options: AnalyzeBeliefPolicyOptions,
): BeliefPolicyEvaluationReport {
  const selective = evaluateBeliefSelectivePolicy(options.points, options.policy, options.selective)
  const calibration = calibrateBeliefDecisions(options.points, options.calibration)
  const ope = evaluateBeliefOffPolicy(options.points, options.ope)
  const diagnostics: string[] = []

  if (!calibration) diagnostics.push('calibration unsupported: not enough confidence/outcome pairs')
  if (!ope) diagnostics.push('OPE unsupported: missing behavior/target propensities')
  else if (!ope.support.supported)
    diagnostics.push(...ope.support.reasons.map((reason) => `OPE unsupported: ${reason}`))

  const status =
    selective.recommendation === 'ship' && calibration && (!ope || ope.support.supported)
      ? 'ship'
      : selective.recommendation === 'need_more_data' || !calibration
        ? 'need_more_data'
        : 'hold'

  return {
    policyId: options.policy.id,
    n: options.points.length,
    status,
    selective,
    ...(calibration ? { calibration } : {}),
    ...(ope ? { ope } : {}),
    diagnostics,
  }
}
