import {
  type AnalyzeBeliefDecisionCorpusOptions,
  analyzeBeliefDecisionCorpus,
  type BeliefDecisionCorpusEvaluation,
} from './code-agent-corpus'

export type BeliefResearchClaimScope = 'selective' | 'counterfactual'
export type BeliefResearchEvidenceStatus = 'supported' | 'blocked'
export type BeliefResearchGateId = 'corpus' | 'selective' | 'calibration' | 'ope'

export interface BeliefResearchEvidenceGate {
  id: BeliefResearchGateId
  status: BeliefResearchEvidenceStatus
  blockers: string[]
  caveats: string[]
}

export interface BeliefDecisionResearchEvidencePacket {
  claimScope: BeliefResearchClaimScope
  status: BeliefResearchEvidenceStatus
  analysis: BeliefDecisionCorpusEvaluation
  gates: BeliefResearchEvidenceGate[]
  blockers: string[]
  caveats: string[]
}

export interface BuildBeliefDecisionResearchEvidencePacketOptions
  extends AnalyzeBeliefDecisionCorpusOptions {
  claimScope?: BeliefResearchClaimScope
}

export function buildBeliefDecisionResearchEvidencePacket(
  options: BuildBeliefDecisionResearchEvidencePacketOptions,
): BeliefDecisionResearchEvidencePacket {
  const claimScope = options.claimScope ?? 'counterfactual'
  const requireOpe = claimScope === 'counterfactual'
  const analysis = analyzeBeliefDecisionCorpus({
    ...options,
    requireOpe: options.requireOpe ?? requireOpe,
  })
  const gates = [
    corpusGate(analysis),
    selectiveGate(analysis),
    calibrationGate(analysis),
    ...(requireOpe ? [opeGate(analysis)] : []),
  ]
  const caveats = unique([
    ...gates.flatMap((gate) => gate.caveats),
    ...(claimScope === 'selective'
      ? ['counterfactual claims excluded: OPE support was not required']
      : []),
  ])

  return {
    claimScope,
    status: gates.every((gate) => gate.status === 'supported') ? 'supported' : 'blocked',
    analysis,
    gates,
    blockers: unique(gates.flatMap((gate) => gate.blockers)),
    caveats,
  }
}

function corpusGate(analysis: BeliefDecisionCorpusEvaluation): BeliefResearchEvidenceGate {
  const support = analysis.target?.support
  if (!support) {
    return blocked('corpus', 'no decision target has enough outcome support')
  }

  const caveats =
    support.withBehaviorProb < support.n || support.withTargetProb < support.n
      ? ['propensity support incomplete; counterfactual claims will require OPE support']
      : []

  return { id: 'corpus', status: 'supported', blockers: [], caveats }
}

function selectiveGate(analysis: BeliefDecisionCorpusEvaluation): BeliefResearchEvidenceGate {
  const evaluation = analysis.evaluation
  if (!evaluation) return blocked('selective', 'no policy evaluation was produced')
  if (evaluation.selectiveStatus !== 'ship') {
    return blocked(
      'selective',
      ...orDefault(
        evaluation.selective.reasons,
        `selective status is ${evaluation.selectiveStatus}`,
      ),
    )
  }
  return { id: 'selective', status: 'supported', blockers: [], caveats: [] }
}

function calibrationGate(analysis: BeliefDecisionCorpusEvaluation): BeliefResearchEvidenceGate {
  const evaluation = analysis.evaluation
  if (!evaluation) return blocked('calibration', 'no policy evaluation was produced')
  if (evaluation.calibrationStatus !== 'supported') {
    return blocked('calibration', 'not enough confidence/outcome pairs for calibration')
  }
  return { id: 'calibration', status: 'supported', blockers: [], caveats: [] }
}

function opeGate(analysis: BeliefDecisionCorpusEvaluation): BeliefResearchEvidenceGate {
  const evaluation = analysis.evaluation
  if (!evaluation) return blocked('ope', 'no policy evaluation was produced')
  if (evaluation.opeStatus !== 'supported') {
    const reasons =
      evaluation.ope?.support.reasons ??
      evaluation.diagnostics.filter((diagnostic) => diagnostic.includes('OPE'))
    return blocked('ope', ...orDefault(reasons, 'missing OPE support'))
  }
  return { id: 'ope', status: 'supported', blockers: [], caveats: [] }
}

function blocked(id: BeliefResearchGateId, ...blockers: string[]): BeliefResearchEvidenceGate {
  return { id, status: 'blocked', blockers, caveats: [] }
}

function orDefault(values: string[], fallback: string): string[] {
  return values.length > 0 ? values : [fallback]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
