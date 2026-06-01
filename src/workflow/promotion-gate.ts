import { ValidationError } from '../errors'
import { type RunRecord, validateRunRecord } from '../run-record'
import { type PairedBootstrapResult, pairedBootstrap } from '../statistics'

export type WorkflowDriverPromotionDecisionVersion = 'workflow-driver-promotion-v1'

export type WorkflowDriverPromotionRejectionCode =
  | 'missing_baseline_records'
  | 'missing_candidate_records'
  | 'missing_holdout_pairs'
  | 'few_pairs'
  | 'insufficient_lift'
  | 'cost_ceiling'

export interface WorkflowDriverPromotionPair {
  key: string
  scenarioId: string
  seed: number
  baselineRunId: string
  candidateRunId: string
  baselineScore: number
  candidateScore: number
  delta: number
}

export interface WorkflowDriverPromotionEvidence {
  pairedRuns: number
  expectedScenarioIds: string[]
  pairedScenarioIds: string[]
  missingScenarioIds: string[]
  baselineMean: number
  candidateMean: number
  lift: number
  liftCi: { low: number; high: number }
  bootstrap: PairedBootstrapResult
  confidence: number
  resamples: number
  statistic: 'mean' | 'median'
  deltaThreshold: number
  baselineMedianCostUsd: number
  candidateMedianCostUsd: number
  pairs: WorkflowDriverPromotionPair[]
}

export interface WorkflowDriverPromotionDecision {
  schemaVersion: WorkflowDriverPromotionDecisionVersion
  generatedAt: string
  baselineStrategyId: string
  candidateStrategyId: string
  promote: boolean
  rejectionCode: WorkflowDriverPromotionRejectionCode | null
  reason: string
  evidence: WorkflowDriverPromotionEvidence
}

export interface DecideWorkflowDriverPromotionOptions {
  records: readonly RunRecord[] | readonly unknown[]
  baselineStrategyId?: string
  candidateStrategyId?: string
  expectedScenarioIds?: readonly string[]
  minPairedHoldoutRuns?: number
  deltaThreshold?: number
  confidence?: number
  resamples?: number
  seed?: number
  statistic?: 'mean' | 'median'
  costPerRunCeiling?: number
  generatedAt?: string
}

const DECISION_VERSION: WorkflowDriverPromotionDecisionVersion = 'workflow-driver-promotion-v1'
const DEFAULT_BASELINE_STRATEGY = 'reviewer-loop-v1'
const DEFAULT_CANDIDATE_STRATEGY = 'workflow-driver-v1'

export function decideWorkflowDriverPromotion(
  options: DecideWorkflowDriverPromotionOptions,
): WorkflowDriverPromotionDecision {
  const records = options.records.map(validateRunRecord)
  const baselineStrategyId = options.baselineStrategyId ?? DEFAULT_BASELINE_STRATEGY
  const candidateStrategyId = options.candidateStrategyId ?? DEFAULT_CANDIDATE_STRATEGY
  const confidence = options.confidence ?? 0.95
  const resamples = options.resamples ?? 2000
  const statistic = options.statistic ?? 'mean'
  const deltaThreshold = options.deltaThreshold ?? 0
  const minPairedHoldoutRuns = options.minPairedHoldoutRuns ?? 3
  validateOptions({ confidence, resamples, deltaThreshold, minPairedHoldoutRuns }, options)

  const baseline = records.filter((record) => record.candidateId === baselineStrategyId)
  const candidate = records.filter((record) => record.candidateId === candidateStrategyId)
  const baselineHoldout = baseline.filter(isScoredHoldout)
  const candidateHoldout = candidate.filter(isScoredHoldout)
  const expectedScenarioIds = expectedScenarios(options.expectedScenarioIds, [
    ...baselineHoldout,
    ...candidateHoldout,
  ])
  const expectedScenarioIdSet = new Set(expectedScenarioIds)
  const pairs = pairHoldoutRuns(baselineHoldout, candidateHoldout).filter(
    (pair) => expectedScenarioIdSet.size === 0 || expectedScenarioIdSet.has(pair.scenarioId),
  )
  const pairedScenarioIds = [...new Set(pairs.map((pair) => pair.scenarioId))].sort()
  const missingScenarioIds = expectedScenarioIds.filter((id) => !pairedScenarioIds.includes(id))
  const evidence = buildEvidence({
    pairs,
    expectedScenarioIds,
    pairedScenarioIds,
    missingScenarioIds,
    baseline,
    candidate,
    confidence,
    resamples,
    statistic,
    deltaThreshold,
    seed: options.seed,
  })

  if (baselineHoldout.length === 0) {
    return decision({
      options,
      baselineStrategyId,
      candidateStrategyId,
      evidence,
      promote: false,
      rejectionCode: 'missing_baseline_records',
      reason: `missing_baseline_records: no holdout RunRecords for baseline "${baselineStrategyId}"`,
    })
  }
  if (candidateHoldout.length === 0) {
    return decision({
      options,
      baselineStrategyId,
      candidateStrategyId,
      evidence,
      promote: false,
      rejectionCode: 'missing_candidate_records',
      reason: `missing_candidate_records: no holdout RunRecords for candidate "${candidateStrategyId}"`,
    })
  }
  if (missingScenarioIds.length > 0) {
    return decision({
      options,
      baselineStrategyId,
      candidateStrategyId,
      evidence,
      promote: false,
      rejectionCode: 'missing_holdout_pairs',
      reason: `missing_holdout_pairs: no paired baseline/candidate holdout record for scenario(s) [${missingScenarioIds.join(', ')}]`,
    })
  }
  if (pairs.length < minPairedHoldoutRuns) {
    return decision({
      options,
      baselineStrategyId,
      candidateStrategyId,
      evidence,
      promote: false,
      rejectionCode: 'few_pairs',
      reason: `few_pairs: ${pairs.length} paired holdout run(s) < min ${minPairedHoldoutRuns}`,
    })
  }
  if (!(evidence.liftCi.low > deltaThreshold)) {
    return decision({
      options,
      baselineStrategyId,
      candidateStrategyId,
      evidence,
      promote: false,
      rejectionCode: 'insufficient_lift',
      reason:
        `insufficient_lift: heldout ${statistic} lift=${fmt(evidence.lift)} ` +
        `CI=[${fmt(evidence.liftCi.low)}, ${fmt(evidence.liftCi.high)}] does not clear threshold ${fmt(deltaThreshold)}`,
    })
  }
  if (
    options.costPerRunCeiling !== undefined &&
    Number.isFinite(evidence.candidateMedianCostUsd) &&
    evidence.candidateMedianCostUsd > options.costPerRunCeiling
  ) {
    return decision({
      options,
      baselineStrategyId,
      candidateStrategyId,
      evidence,
      promote: false,
      rejectionCode: 'cost_ceiling',
      reason:
        `cost_ceiling: candidate median cost $${fmt(evidence.candidateMedianCostUsd)} ` +
        `exceeds ceiling $${fmt(options.costPerRunCeiling)}`,
    })
  }

  return decision({
    options,
    baselineStrategyId,
    candidateStrategyId,
    evidence,
    promote: true,
    rejectionCode: null,
    reason:
      `promote: ${candidateStrategyId} beats ${baselineStrategyId} on paired heldout workflows ` +
      `lift=${fmt(evidence.lift)} CI=[${fmt(evidence.liftCi.low)}, ${fmt(evidence.liftCi.high)}] ` +
      `over ${pairs.length} pair(s)`,
  })
}

function validateOptions(
  normalized: {
    confidence: number
    resamples: number
    deltaThreshold: number
    minPairedHoldoutRuns: number
  },
  options: DecideWorkflowDriverPromotionOptions,
): void {
  if (options.records.length === 0) {
    throw new ValidationError('workflow promotion gate requires at least one RunRecord')
  }
  if (normalized.confidence <= 0 || normalized.confidence >= 1) {
    throw new ValidationError('workflow promotion gate confidence must be in (0,1)')
  }
  if (!Number.isInteger(normalized.resamples) || normalized.resamples <= 0) {
    throw new ValidationError('workflow promotion gate resamples must be a positive integer')
  }
  if (!Number.isFinite(normalized.deltaThreshold)) {
    throw new ValidationError('workflow promotion gate deltaThreshold must be finite')
  }
  if (!Number.isInteger(normalized.minPairedHoldoutRuns) || normalized.minPairedHoldoutRuns < 1) {
    throw new ValidationError(
      'workflow promotion gate minPairedHoldoutRuns must be a positive integer',
    )
  }
  if (
    options.costPerRunCeiling !== undefined &&
    (!Number.isFinite(options.costPerRunCeiling) || options.costPerRunCeiling <= 0)
  ) {
    throw new ValidationError('workflow promotion gate costPerRunCeiling must be positive')
  }
}

function isScoredHoldout(record: RunRecord): boolean {
  return record.splitTag === 'holdout' && typeof record.outcome.holdoutScore === 'number'
}

function expectedScenarios(
  requested: readonly string[] | undefined,
  records: readonly RunRecord[],
): string[] {
  const values = (requested ?? records.map((record) => record.scenarioId)).filter(isString)
  return [...new Set(values)].sort()
}

function pairHoldoutRuns(
  baseline: readonly RunRecord[],
  candidate: readonly RunRecord[],
): WorkflowDriverPromotionPair[] {
  const baselineByKey = indexByPairKey(baseline, 'baseline')
  const out: WorkflowDriverPromotionPair[] = []
  for (const candidateRun of candidate) {
    const key = holdoutPairKey(candidateRun, 'candidate')
    const baselineRun = baselineByKey.get(key)
    if (!baselineRun) continue
    const baselineScore = baselineRun.outcome.holdoutScore!
    const candidateScore = candidateRun.outcome.holdoutScore!
    out.push({
      key,
      scenarioId: candidateRun.scenarioId!,
      seed: candidateRun.seed,
      baselineRunId: baselineRun.runId,
      candidateRunId: candidateRun.runId,
      baselineScore,
      candidateScore,
      delta: candidateScore - baselineScore,
    })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

function indexByPairKey(
  records: readonly RunRecord[],
  side: 'baseline' | 'candidate',
): Map<string, RunRecord> {
  const out = new Map<string, RunRecord>()
  for (const record of records) {
    const key = holdoutPairKey(record, side)
    if (out.has(key)) {
      throw new ValidationError(
        `workflow promotion gate duplicate ${side} holdout pair key: ${key}`,
      )
    }
    out.set(key, record)
  }
  return out
}

function holdoutPairKey(record: RunRecord, side: 'baseline' | 'candidate'): string {
  if (!record.scenarioId) {
    throw new ValidationError(
      `workflow promotion gate ${side} holdout RunRecord ${record.runId} is missing scenarioId`,
    )
  }
  return `${record.scenarioId}::${record.seed}`
}

function buildEvidence(args: {
  pairs: readonly WorkflowDriverPromotionPair[]
  expectedScenarioIds: string[]
  pairedScenarioIds: string[]
  missingScenarioIds: string[]
  baseline: readonly RunRecord[]
  candidate: readonly RunRecord[]
  confidence: number
  resamples: number
  statistic: 'mean' | 'median'
  deltaThreshold: number
  seed?: number
}): WorkflowDriverPromotionEvidence {
  const before = args.pairs.map((pair) => pair.baselineScore)
  const after = args.pairs.map((pair) => pair.candidateScore)
  const bootstrap = pairedBootstrap(before, after, {
    confidence: args.confidence,
    resamples: args.resamples,
    statistic: args.statistic,
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
  })
  return {
    pairedRuns: args.pairs.length,
    expectedScenarioIds: args.expectedScenarioIds,
    pairedScenarioIds: args.pairedScenarioIds,
    missingScenarioIds: args.missingScenarioIds,
    baselineMean: mean(before),
    candidateMean: mean(after),
    lift: args.statistic === 'mean' ? bootstrap.mean : bootstrap.median,
    liftCi: { low: bootstrap.low, high: bootstrap.high },
    bootstrap,
    confidence: args.confidence,
    resamples: args.resamples,
    statistic: args.statistic,
    deltaThreshold: args.deltaThreshold,
    baselineMedianCostUsd: medianFinite(args.baseline.map((record) => record.costUsd)),
    candidateMedianCostUsd: medianFinite(args.candidate.map((record) => record.costUsd)),
    pairs: [...args.pairs],
  }
}

function decision(args: {
  options: DecideWorkflowDriverPromotionOptions
  baselineStrategyId: string
  candidateStrategyId: string
  evidence: WorkflowDriverPromotionEvidence
  promote: boolean
  rejectionCode: WorkflowDriverPromotionRejectionCode | null
  reason: string
}): WorkflowDriverPromotionDecision {
  return {
    schemaVersion: DECISION_VERSION,
    generatedAt: args.options.generatedAt ?? new Date().toISOString(),
    baselineStrategyId: args.baselineStrategyId,
    candidateStrategyId: args.candidateStrategyId,
    promote: args.promote,
    rejectionCode: args.rejectionCode,
    reason: args.reason,
    evidence: args.evidence,
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function medianFinite(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (finite.length === 0) return Number.NaN
  const mid = Math.floor(finite.length / 2)
  return finite.length % 2 === 0 ? (finite[mid - 1]! + finite[mid]!) / 2 : finite[mid]!
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  return value.toFixed(4)
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
