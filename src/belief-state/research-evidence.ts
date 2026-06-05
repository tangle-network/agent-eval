import {
  type AnalyzeBeliefDecisionCorpusOptions,
  analyzeBeliefDecisionCorpus,
  type BeliefDecisionCorpusEvaluation,
  type BeliefDecisionInventoryBucket,
} from './code-agent-corpus'
import type { BeliefEvaluationStatus, BeliefOpeStatus, BeliefPolicyEvaluationReport } from './types'

export type BeliefResearchEvidenceStatus = 'supported' | 'mixed' | 'insufficient'

export type BeliefResearchClaimId =
  | 'decision-corpus-support'
  | 'selective-policy-evidence'
  | 'calibration-evidence'
  | 'off-policy-support'
  | 'paper-ready-replay'

export interface BeliefResearchEvidenceMetric {
  name: string
  value: number | string | boolean | null
}

export interface BeliefResearchEvidenceClaim {
  id: BeliefResearchClaimId
  status: BeliefResearchEvidenceStatus
  summary: string
  metrics: BeliefResearchEvidenceMetric[]
  caveats: string[]
  blockers: string[]
}

export interface BeliefResearchTableRow {
  claimId: BeliefResearchClaimId
  status: BeliefResearchEvidenceStatus
  metric: string
  value: number | string | boolean | null
  note?: string
}

export interface BeliefDecisionResearchEvidencePacket {
  corpusId: string
  sourceId?: string
  generatedAt: string
  status: BeliefResearchEvidenceStatus
  points: number
  analysis: BeliefDecisionCorpusEvaluation
  claims: BeliefResearchEvidenceClaim[]
  blockers: string[]
  caveats: string[]
  paperTableRows: BeliefResearchTableRow[]
}

export interface BuildBeliefDecisionResearchEvidencePacketOptions
  extends AnalyzeBeliefDecisionCorpusOptions {
  corpusId?: string
  sourceId?: string
  generatedAt?: string
  requireOpeForCounterfactualClaim?: boolean
}

export function buildBeliefDecisionResearchEvidencePacket(
  options: BuildBeliefDecisionResearchEvidencePacketOptions,
): BeliefDecisionResearchEvidencePacket {
  const minN = options.minN ?? 10
  const minOutcomeCoverage = options.minOutcomeCoverage ?? 0.8
  const requireOpeForCounterfactualClaim = options.requireOpeForCounterfactualClaim ?? true
  const analysis = analyzeBeliefDecisionCorpus({
    ...options,
    minN,
    minOutcomeCoverage,
    requireOpe: options.requireOpe ?? requireOpeForCounterfactualClaim,
  })
  const claims = [
    corpusSupportClaim(analysis, { minN, minOutcomeCoverage }),
    selectivePolicyClaim(analysis.evaluation),
    calibrationClaim(analysis.evaluation),
    offPolicyClaim(analysis.evaluation),
  ]
  claims.push(paperReadyClaim(claims, { requireOpeForCounterfactualClaim }))

  const blockers = unique(claims.flatMap((claim) => claim.blockers))
  const caveats = unique(claims.flatMap((claim) => claim.caveats))
  const status = overallResearchStatus(claims)

  return {
    corpusId: options.corpusId ?? 'belief-decision-corpus',
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    status,
    points: options.points.length,
    analysis,
    claims,
    blockers,
    caveats,
    paperTableRows: claims.flatMap(claimToRows),
  }
}

function corpusSupportClaim(
  analysis: BeliefDecisionCorpusEvaluation,
  thresholds: { minN: number; minOutcomeCoverage: number },
): BeliefResearchEvidenceClaim {
  const support = analysis.target?.support
  if (!support) {
    return {
      id: 'decision-corpus-support',
      status: 'insufficient',
      summary: 'No decision target has enough support for research-grade evaluation.',
      metrics: [
        { name: 'n', value: analysis.inventory.n },
        { name: 'minN', value: thresholds.minN },
      ],
      caveats: [],
      blockers: ['collect more decision points with outcomes for at least one target'],
    }
  }

  const outcomeCoverage = ratio(support.withOutcome, support.n)
  const blockers: string[] = []
  if (support.n < thresholds.minN) {
    blockers.push(`target ${support.id} has ${support.n} decisions; need ${thresholds.minN}`)
  }
  if (outcomeCoverage < thresholds.minOutcomeCoverage) {
    blockers.push(
      `target ${support.id} outcome coverage ${formatRatio(outcomeCoverage)} below ${formatRatio(
        thresholds.minOutcomeCoverage,
      )}`,
    )
  }

  return {
    id: 'decision-corpus-support',
    status: blockers.length === 0 ? 'supported' : 'insufficient',
    summary:
      blockers.length === 0
        ? `Target ${support.id} has enough decision/outcome support for analysis.`
        : `Target ${support.id} is not sufficiently supported.`,
    metrics: supportMetrics(support, thresholds),
    caveats:
      support.withBehaviorProb < support.n || support.withTargetProb < support.n
        ? ['corpus support is not the same as OPE support; propensities are incomplete']
        : [],
    blockers,
  }
}

function selectivePolicyClaim(
  evaluation: BeliefPolicyEvaluationReport | undefined,
): BeliefResearchEvidenceClaim {
  if (!evaluation) {
    return unsupportedClaim(
      'selective-policy-evidence',
      'Selective policy evidence is unavailable because no target was evaluated.',
      'evaluate a target with enough decision/outcome support',
    )
  }
  const status = statusFromEvaluation(evaluation.selectiveStatus)
  return {
    id: 'selective-policy-evidence',
    status,
    summary:
      status === 'supported'
        ? `Selective policy ${evaluation.policyId} meets the configured ship gate.`
        : `Selective policy ${evaluation.policyId} does not meet the configured ship gate.`,
    metrics: [
      { name: 'selectiveStatus', value: evaluation.selectiveStatus },
      { name: 'n', value: evaluation.selective.n },
      { name: 'accepted', value: evaluation.selective.accepted },
      { name: 'coverage', value: round(evaluation.selective.coverage) },
      { name: 'acceptedErrorRate', value: round(evaluation.selective.acceptedErrorRate) },
      { name: 'utilityDelta', value: round(evaluation.selective.utilityDelta) },
      { name: 'utilityCi95Lower', value: round(evaluation.selective.utilityCi95.lower) },
      { name: 'utilityCi95Upper', value: round(evaluation.selective.utilityCi95.upper) },
    ],
    caveats: evaluation.selective.reasons,
    blockers:
      status === 'supported'
        ? []
        : evaluation.selective.reasons.length > 0
          ? evaluation.selective.reasons
          : [`selective status is ${evaluation.selectiveStatus}`],
  }
}

function calibrationClaim(
  evaluation: BeliefPolicyEvaluationReport | undefined,
): BeliefResearchEvidenceClaim {
  if (!evaluation) {
    return unsupportedClaim(
      'calibration-evidence',
      'Calibration evidence is unavailable because no target was evaluated.',
      'evaluate a target with enough confidence/outcome pairs',
    )
  }
  const supported = evaluation.calibrationStatus === 'supported'
  return {
    id: 'calibration-evidence',
    status: supported ? 'supported' : 'insufficient',
    summary: supported
      ? 'Belief confidence has enough paired outcomes for calibration analysis.'
      : 'Belief confidence does not have enough paired outcomes for calibration analysis.',
    metrics: [
      { name: 'calibrationStatus', value: evaluation.calibrationStatus },
      { name: 'pairs', value: evaluation.calibration?.n ?? 0 },
      { name: 'ece', value: nullableRound(evaluation.calibration?.ece) },
      { name: 'maxGap', value: nullableRound(evaluation.calibration?.maxGap) },
    ],
    caveats: supported ? [] : evaluation.diagnostics,
    blockers: supported ? [] : ['collect more decisions with both confidence and outcome'],
  }
}

function offPolicyClaim(
  evaluation: BeliefPolicyEvaluationReport | undefined,
): BeliefResearchEvidenceClaim {
  if (!evaluation) {
    return unsupportedClaim(
      'off-policy-support',
      'OPE support is unavailable because no target was evaluated.',
      'evaluate a target with logged behavior and target propensities',
    )
  }
  const status = statusFromOpe(evaluation.opeStatus)
  const support = evaluation.ope?.support
  return {
    id: 'off-policy-support',
    status,
    summary:
      status === 'supported'
        ? `Off-policy evaluation is supported for target policy ${evaluation.opeTargetPolicyId}.`
        : 'Off-policy evaluation is not supported by this corpus.',
    metrics: [
      { name: 'opeStatus', value: evaluation.opeStatus },
      { name: 'opeTargetPolicyId', value: evaluation.opeTargetPolicyId ?? null },
      { name: 'effectiveSampleSize', value: nullableRound(support?.effectiveSampleSize) },
      { name: 'effectiveSampleRatio', value: nullableRound(support?.effectiveSampleRatio) },
      { name: 'maxImportanceWeight', value: nullableRound(support?.maxImportanceWeight) },
      { name: 'dropped', value: support?.dropped ?? null },
    ],
    caveats: evaluation.diagnostics.filter((diagnostic) => diagnostic.includes('OPE')),
    blockers:
      status === 'supported'
        ? []
        : support?.reasons.length
          ? support.reasons
          : ['log behaviorProb and targetProb for candidate counterfactual policies'],
  }
}

function paperReadyClaim(
  priorClaims: BeliefResearchEvidenceClaim[],
  options: { requireOpeForCounterfactualClaim: boolean },
): BeliefResearchEvidenceClaim {
  const required = priorClaims.filter((claim) =>
    options.requireOpeForCounterfactualClaim ? true : claim.id !== 'off-policy-support',
  )
  const blockers = unique(
    required
      .filter((claim) => claim.status !== 'supported')
      .flatMap((claim) =>
        claim.blockers.length > 0 ? claim.blockers : [`${claim.id} is ${claim.status}`],
      ),
  )
  const mixed = required.some((claim) => claim.status === 'mixed')
  const status: BeliefResearchEvidenceStatus =
    blockers.length === 0 ? 'supported' : mixed ? 'mixed' : 'insufficient'
  const caveats = options.requireOpeForCounterfactualClaim
    ? []
    : ['counterfactual policy claims are excluded because OPE is not required for this packet']

  return {
    id: 'paper-ready-replay',
    status,
    summary:
      status === 'supported'
        ? 'This replay packet can support a paper table under the configured claim scope.'
        : 'This replay packet is not yet sufficient for the configured paper claim scope.',
    metrics: [
      { name: 'requireOpeForCounterfactualClaim', value: options.requireOpeForCounterfactualClaim },
      { name: 'requiredClaims', value: required.length },
      {
        name: 'blockedClaims',
        value: required.filter((claim) => claim.status !== 'supported').length,
      },
    ],
    caveats,
    blockers,
  }
}

function supportMetrics(
  support: BeliefDecisionInventoryBucket,
  thresholds: { minN: number; minOutcomeCoverage: number },
): BeliefResearchEvidenceMetric[] {
  return [
    { name: 'target', value: support.id },
    { name: 'n', value: support.n },
    { name: 'minN', value: thresholds.minN },
    { name: 'outcomeCoverage', value: round(ratio(support.withOutcome, support.n)) },
    { name: 'minOutcomeCoverage', value: thresholds.minOutcomeCoverage },
    { name: 'successRate', value: nullableRound(support.successRate) },
    { name: 'meanConfidence', value: nullableRound(support.meanConfidence) },
    { name: 'withBehaviorProb', value: support.withBehaviorProb },
    { name: 'withTargetProb', value: support.withTargetProb },
  ]
}

function unsupportedClaim(
  id: BeliefResearchClaimId,
  summary: string,
  blocker: string,
): BeliefResearchEvidenceClaim {
  return {
    id,
    status: 'insufficient',
    summary,
    metrics: [],
    caveats: [],
    blockers: [blocker],
  }
}

function statusFromEvaluation(status: BeliefEvaluationStatus): BeliefResearchEvidenceStatus {
  if (status === 'ship') return 'supported'
  if (status === 'hold') return 'mixed'
  return 'insufficient'
}

function statusFromOpe(status: BeliefOpeStatus): BeliefResearchEvidenceStatus {
  if (status === 'supported') return 'supported'
  return 'insufficient'
}

function overallResearchStatus(
  claims: BeliefResearchEvidenceClaim[],
): BeliefResearchEvidenceStatus {
  const paperReady = claims.find((claim) => claim.id === 'paper-ready-replay')
  if (paperReady) return paperReady.status
  if (claims.some((claim) => claim.status === 'insufficient')) return 'insufficient'
  if (claims.some((claim) => claim.status === 'mixed')) return 'mixed'
  return 'supported'
}

function claimToRows(claim: BeliefResearchEvidenceClaim): BeliefResearchTableRow[] {
  if (claim.metrics.length === 0) {
    return [
      {
        claimId: claim.id,
        status: claim.status,
        metric: 'summary',
        value: claim.summary,
        note: claim.blockers[0],
      },
    ]
  }
  return claim.metrics.map((metric) => ({
    claimId: claim.id,
    status: claim.status,
    metric: metric.name,
    value: metric.value,
    ...(claim.blockers[0] ? { note: claim.blockers[0] } : {}),
  }))
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

function nullableRound(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? round(value) : null
}

function formatRatio(value: number): string {
  return value.toFixed(2)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
