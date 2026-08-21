import { pairedBootstrap } from '../statistics'
import type { AnalystBenchmarkObservation, AnalystBenchmarkResult } from './benchmark'

/**
 * Every metric a benchmark comparison reports, mapped to the direction that
 * is an improvement. This table is the only declaration of the vocabulary:
 * the type, the reporting order, the artifact schema's accepted values, and
 * each metric's direction all derive from it, so a metric cannot exist in one
 * of those four places and be missing from another.
 */
const ANALYST_COMPARISON_METRIC_DIRECTION = {
  completion: 'higher',
  issueRecall: 'higher',
  findingPrecision: 'higher',
  f1: 'higher',
  criticalStepAccuracy: 'higher',
  citationCoverage: 'higher',
  citationExcerptCoverage: 'higher',
  citationLabelAgreement: 'higher',
  citationResolution: 'higher',
  trustedNegativeAccuracy: 'higher',
  latencyMs: 'lower',
  calls: 'lower',
  inputTokens: 'lower',
  outputTokens: 'lower',
  reasoningTokens: 'lower',
  cachedTokens: 'lower',
  cacheWriteTokens: 'lower',
  costUsd: 'lower',
} as const satisfies Record<string, 'higher' | 'lower'>

export type AnalystComparisonMetric = keyof typeof ANALYST_COMPARISON_METRIC_DIRECTION

/** The vocabulary as a non-empty tuple, which is what `z.enum` accepts. Key
 *  order is the declaration order above, and it is the reporting order. */
export const ANALYST_COMPARISON_METRICS = Object.keys(ANALYST_COMPARISON_METRIC_DIRECTION) as [
  AnalystComparisonMetric,
  ...AnalystComparisonMetric[],
]

/** `'lower'` when a smaller value is the improvement. */
export function analystComparisonMetricDirection(
  metric: AnalystComparisonMetric,
): 'higher' | 'lower' {
  return ANALYST_COMPARISON_METRIC_DIRECTION[metric]
}

export interface AnalystMetricComparison {
  metric: AnalystComparisonMetric
  direction: 'higher' | 'lower'
  /** Trajectories with at least one complete pair for this metric. */
  pairedCases: number
  /** Independent task or incident groups resampled by the interval. */
  pairedClusters: number
  /** Same-run pairs where this metric applies before missing values are removed. */
  eligibleObservations: number
  pairedObservations: number
  baselineMissingObservations: number
  candidateMissingObservations: number
  asymmetricMissingObservations: number
  survivorOnly: boolean
  baselineMean: number | null
  candidateMean: number | null
  meanDelta: number | null
  intervalLow: number | null
  intervalHigh: number | null
  confidence: number
  resamples: number
  minimumSampleMet: boolean
  populationInferenceEligible: boolean
  inferenceLimitations: string[]
}

export interface AnalystRunnerComparison {
  baselineRunnerId: string
  candidateRunnerId: string
  metrics: AnalystMetricComparison[]
}

interface PairedCaseMetric {
  clusterId: string
  baseline: number
  candidate: number
}

export function compareAnalystRunners(
  result: AnalystBenchmarkResult,
  options: {
    baselineRunnerId: string
    candidateRunnerId: string
    confidence?: number
    resamples?: number
    seed?: number
  },
): AnalystRunnerComparison {
  const confidence = options.confidence ?? 0.95
  const resamples = options.resamples ?? 2000
  assertComparisonControls(confidence, resamples)

  const runnerIds = new Set(result.summaries.map((summary) => summary.runnerId))
  if (!runnerIds.has(options.baselineRunnerId)) {
    throw new TypeError(`unknown baseline analyst runner '${options.baselineRunnerId}'`)
  }
  if (!runnerIds.has(options.candidateRunnerId)) {
    throw new TypeError(`unknown candidate analyst runner '${options.candidateRunnerId}'`)
  }
  if (options.baselineRunnerId === options.candidateRunnerId) {
    throw new TypeError('baseline and candidate analyst runners must be different')
  }

  const baseline = observationsByCase(result.observations, options.baselineRunnerId)
  const candidate = observationsByCase(result.observations, options.candidateRunnerId)
  const populationRepresentativenessProven =
    result.provenance.metadata?.populationRepresentativenessProven === true
  const metrics = ANALYST_COMPARISON_METRICS.map((metric) =>
    compareMetric({
      metric,
      baseline,
      candidate,
      confidence,
      resamples,
      seed: options.seed,
      populationRepresentativenessProven,
    }),
  )

  return {
    baselineRunnerId: options.baselineRunnerId,
    candidateRunnerId: options.candidateRunnerId,
    metrics,
  }
}

function compareMetric(options: {
  metric: AnalystComparisonMetric
  baseline: Map<string, AnalystBenchmarkObservation[]>
  candidate: Map<string, AnalystBenchmarkObservation[]>
  confidence: number
  resamples: number
  seed?: number
  populationRepresentativenessProven: boolean
}): AnalystMetricComparison {
  const pairedCases: PairedCaseMetric[] = []
  let eligibleObservations = 0
  let pairedObservations = 0
  let baselineMissingObservations = 0
  let candidateMissingObservations = 0
  let asymmetricMissingObservations = 0

  const caseIds = new Set([...options.baseline.keys(), ...options.candidate.keys()])
  for (const caseId of caseIds) {
    const baselineByRepetition = new Map(
      (options.baseline.get(caseId) ?? []).map((observation) => [
        observation.repetition,
        observation,
      ]),
    )
    const candidateByRepetition = new Map(
      (options.candidate.get(caseId) ?? []).map((observation) => [
        observation.repetition,
        observation,
      ]),
    )
    const caseBefore: number[] = []
    const caseAfter: number[] = []
    let clusterId: string | undefined
    const repetitions = new Set([...baselineByRepetition.keys(), ...candidateByRepetition.keys()])
    for (const repetition of repetitions) {
      const baselineObservation = baselineByRepetition.get(repetition)
      const candidateObservation = candidateByRepetition.get(repetition)
      const identity = baselineObservation ?? candidateObservation
      if (!identity || !metricApplies(identity, options.metric)) continue
      if (baselineObservation && candidateObservation) {
        assertSameCaseIdentity(baselineObservation, candidateObservation)
      }
      eligibleObservations += 1
      clusterId = identity.clusterId
      const baselineValue = baselineObservation
        ? metricValue(baselineObservation, options.metric)
        : null
      const candidateValue = candidateObservation
        ? metricValue(candidateObservation, options.metric)
        : null
      const baselineMissing = baselineValue === null
      const candidateMissing = candidateValue === null
      if (baselineMissing) baselineMissingObservations += 1
      if (candidateMissing) candidateMissingObservations += 1
      if (baselineMissing !== candidateMissing) asymmetricMissingObservations += 1
      if (baselineMissing || candidateMissing) continue
      caseBefore.push(baselineValue)
      caseAfter.push(candidateValue)
      pairedObservations += 1
    }
    if (caseBefore.length === 0 || !clusterId) continue
    pairedCases.push({
      clusterId,
      baseline: mean(caseBefore),
      candidate: mean(caseAfter),
    })
  }

  const byCluster = new Map<string, PairedCaseMetric[]>()
  for (const pairedCase of pairedCases) {
    const rows = byCluster.get(pairedCase.clusterId) ?? []
    rows.push(pairedCase)
    byCluster.set(pairedCase.clusterId, rows)
  }
  const before = [...byCluster.values()].map((rows) => mean(rows.map((row) => row.baseline)))
  const after = [...byCluster.values()].map((rows) => mean(rows.map((row) => row.candidate)))
  const interval =
    before.length === 0
      ? null
      : pairedBootstrap(before, after, {
          confidence: options.confidence,
          resamples: options.resamples,
          statistic: 'mean',
          seed: options.seed,
        })
  const survivorOnly = pairedObservations < eligibleObservations
  const limitations: string[] = []
  if (!interval?.gateEligible) limitations.push('fewer-than-20-independent-clusters')
  if (!options.populationRepresentativenessProven) {
    limitations.push('population-representativeness-not-proven')
  }
  if (survivorOnly) limitations.push('missing-observations')

  const comparison: AnalystMetricComparison = {
    metric: options.metric,
    direction: analystComparisonMetricDirection(options.metric),
    pairedCases: pairedCases.length,
    pairedClusters: before.length,
    eligibleObservations,
    pairedObservations,
    baselineMissingObservations,
    candidateMissingObservations,
    asymmetricMissingObservations,
    survivorOnly,
    baselineMean: before.length === 0 ? null : mean(before),
    candidateMean: after.length === 0 ? null : mean(after),
    meanDelta: interval?.mean ?? null,
    intervalLow: interval?.low ?? null,
    intervalHigh: interval?.high ?? null,
    confidence: options.confidence,
    resamples: options.resamples,
    minimumSampleMet: interval?.gateEligible ?? false,
    populationInferenceEligible: limitations.length === 0,
    inferenceLimitations: limitations,
  }
  assertValidComparison(comparison)
  return comparison
}

function observationsByCase(
  observations: readonly AnalystBenchmarkObservation[],
  runnerId: string,
): Map<string, AnalystBenchmarkObservation[]> {
  const byCase = new Map<string, AnalystBenchmarkObservation[]>()
  for (const observation of observations) {
    if (observation.runnerId !== runnerId) continue
    const rows = byCase.get(observation.caseId) ?? []
    rows.push(observation)
    byCase.set(observation.caseId, rows)
  }
  return byCase
}

function assertSameCaseIdentity(
  baseline: AnalystBenchmarkObservation,
  candidate: AnalystBenchmarkObservation,
): void {
  if (baseline.clusterId !== candidate.clusterId || baseline.labelState !== candidate.labelState) {
    throw new Error(
      `analyst comparison case identity differs for '${baseline.caseId}' repetition ${baseline.repetition}`,
    )
  }
}

function metricApplies(
  observation: AnalystBenchmarkObservation,
  metric: AnalystComparisonMetric,
): boolean {
  if (metric === 'trustedNegativeAccuracy') {
    return observation.labelState === 'trusted-negative'
  }
  if (metric === 'issueRecall' || metric === 'findingPrecision' || metric === 'f1') {
    return observation.labelState === 'positive'
  }
  if (metric === 'criticalStepAccuracy') {
    return observation.labelState === 'positive' && observation.score.criticalStepAccuracy !== null
  }
  return true
}

function metricValue(
  observation: AnalystBenchmarkObservation,
  metric: AnalystComparisonMetric,
): number | null {
  if (metric === 'completion') return observation.error ? 0 : 1
  if (metric === 'latencyMs') return observation.latencyMs
  if (metric === 'trustedNegativeAccuracy') {
    if (observation.error) return 0
    return observation.score.predictionOnLabelEmptyCase ? 0 : 1
  }
  if (
    observation.error &&
    (metric === 'issueRecall' ||
      metric === 'findingPrecision' ||
      metric === 'f1' ||
      metric === 'criticalStepAccuracy')
  ) {
    return 0
  }
  if (
    observation.error &&
    (metric === 'citationCoverage' ||
      metric === 'citationExcerptCoverage' ||
      metric === 'citationLabelAgreement' ||
      metric === 'citationResolution')
  ) {
    return null
  }
  if (metric === 'issueRecall') return observation.score.issueRecall
  if (metric === 'findingPrecision') return observation.score.findingPrecision
  if (metric === 'f1') return observation.score.f1
  if (metric === 'criticalStepAccuracy') return observation.score.criticalStepAccuracy
  if (metric === 'citationCoverage') return observation.score.citationCoverage
  if (metric === 'citationExcerptCoverage') return observation.score.citationExcerptCoverage
  if (metric === 'citationLabelAgreement') return observation.score.citationLabelAgreement
  if (metric === 'citationResolution') return observation.evidenceResolution?.validity ?? null
  if (metric === 'calls') return observation.usage?.calls ?? null
  if (metric === 'inputTokens') return observation.usage?.tokens?.input ?? null
  if (metric === 'outputTokens') return observation.usage?.tokens?.output ?? null
  if (metric === 'reasoningTokens') return observation.usage?.tokens?.reasoning ?? null
  if (metric === 'cachedTokens') return observation.usage?.tokens?.cached ?? null
  if (metric === 'cacheWriteTokens') return observation.usage?.tokens?.cacheWrite ?? null
  if (observation.usage?.cost.kind === 'uncaptured') return null
  return observation.usage?.cost.usd ?? null
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function assertComparisonControls(confidence: number, resamples: number): void {
  if (!Number.isSafeInteger(resamples) || resamples <= 0 || resamples > 1_000_000) {
    throw new Error(
      `compareAnalystRunners: resamples must be a positive safe integer no greater than 1000000, got ${String(resamples)}`,
    )
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error(
      `compareAnalystRunners: confidence must be a finite number in (0,1), got ${String(confidence)}`,
    )
  }
}

function assertValidComparison(comparison: AnalystMetricComparison): void {
  const numericFields = [
    'pairedCases',
    'pairedClusters',
    'eligibleObservations',
    'pairedObservations',
    'baselineMissingObservations',
    'candidateMissingObservations',
    'asymmetricMissingObservations',
    'confidence',
    'resamples',
  ] as const
  const nullableFields = [
    'baselineMean',
    'candidateMean',
    'meanDelta',
    'intervalLow',
    'intervalHigh',
  ] as const
  if (
    numericFields.some((field) => !Number.isFinite(comparison[field])) ||
    nullableFields.some(
      (field) => comparison[field] !== null && !Number.isFinite(comparison[field]),
    )
  ) {
    throw new Error(
      `compareAnalystRunners: ${comparison.metric} produced non-finite comparison output`,
    )
  }
  if (
    comparison.intervalLow !== null &&
    comparison.intervalHigh !== null &&
    comparison.intervalLow > comparison.intervalHigh
  ) {
    throw new Error(
      `compareAnalystRunners: ${comparison.metric} produced an invalid confidence interval`,
    )
  }
}
