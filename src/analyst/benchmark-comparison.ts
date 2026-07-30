import { pairedBootstrap } from '../statistics'
import type { AnalystBenchmarkObservation, AnalystBenchmarkResult } from './benchmark'

export type AnalystComparisonMetric =
  | 'completion'
  | 'issueRecall'
  | 'findingPrecision'
  | 'f1'
  | 'criticalStepAccuracy'
  | 'citationCoverage'
  | 'citationLabelAgreement'
  | 'citationResolution'
  | 'cleanAccuracy'
  | 'latencyMs'
  | 'calls'
  | 'inputTokens'
  | 'outputTokens'
  | 'reasoningTokens'
  | 'cachedTokens'
  | 'cacheWriteTokens'
  | 'costUsd'

export interface AnalystMetricComparison {
  metric: AnalystComparisonMetric
  direction: 'higher' | 'lower'
  pairedCases: number
  pairedObservations: number
  baselineMean: number
  candidateMean: number
  meanDelta: number
  intervalLow: number
  intervalHigh: number
  confidence: number
  resamples: number
  enoughCasesForInference: boolean
}

export interface AnalystRunnerComparison {
  baselineRunnerId: string
  candidateRunnerId: string
  metrics: AnalystMetricComparison[]
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
  const metrics: AnalystMetricComparison[] = []
  for (const metric of METRICS) {
    const before: number[] = []
    const after: number[] = []
    let pairedObservations = 0
    for (const [caseId, baselineObservations] of baseline) {
      const candidateObservations = candidate.get(caseId)
      if (!candidateObservations) continue
      const candidateByRepetition = new Map(
        candidateObservations.map((observation) => [observation.repetition, observation]),
      )
      const caseBefore: number[] = []
      const caseAfter: number[] = []
      for (const baselineObservation of baselineObservations) {
        const candidateObservation = candidateByRepetition.get(baselineObservation.repetition)
        if (!candidateObservation) continue
        const baselineValue = metricValue(baselineObservation, metric)
        const candidateValue = metricValue(candidateObservation, metric)
        if (baselineValue === null || candidateValue === null) continue
        caseBefore.push(baselineValue)
        caseAfter.push(candidateValue)
      }
      if (caseBefore.length === 0) continue
      before.push(mean(caseBefore))
      after.push(mean(caseAfter))
      pairedObservations += caseBefore.length
    }
    if (before.length === 0) continue
    const interval = pairedBootstrap(before, after, {
      confidence,
      resamples,
      statistic: 'mean',
      seed: options.seed,
    })
    const comparison: AnalystMetricComparison = {
      metric,
      direction: LOWER_IS_BETTER.has(metric) ? 'lower' : 'higher',
      pairedCases: interval.n,
      pairedObservations,
      baselineMean: mean(before),
      candidateMean: mean(after),
      meanDelta: interval.mean,
      intervalLow: interval.low,
      intervalHigh: interval.high,
      confidence: interval.confidence,
      resamples: interval.resamples,
      enoughCasesForInference: interval.gateEligible,
    }
    assertValidComparison(comparison)
    metrics.push(comparison)
  }
  return {
    baselineRunnerId: options.baselineRunnerId,
    candidateRunnerId: options.candidateRunnerId,
    metrics,
  }
}

const METRICS: readonly AnalystComparisonMetric[] = [
  'completion',
  'issueRecall',
  'findingPrecision',
  'f1',
  'criticalStepAccuracy',
  'citationCoverage',
  'citationLabelAgreement',
  'citationResolution',
  'cleanAccuracy',
  'latencyMs',
  'calls',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'costUsd',
]

const LOWER_IS_BETTER = new Set<AnalystComparisonMetric>([
  'latencyMs',
  'calls',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'costUsd',
])

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

function metricValue(
  observation: AnalystBenchmarkObservation,
  metric: AnalystComparisonMetric,
): number | null {
  if (metric === 'completion') return observation.error ? 0 : 1
  if (metric === 'latencyMs') return observation.latencyMs
  if (metric === 'cleanAccuracy') {
    if (observation.score.expectedIssueCount !== 0) return null
    if (observation.error) return 0
    return observation.score.cleanFalsePositive ? 0 : 1
  }
  if (
    (metric === 'issueRecall' || metric === 'findingPrecision' || metric === 'f1') &&
    observation.score.expectedIssueCount === 0
  ) {
    return null
  }
  if (
    observation.error &&
    (metric === 'issueRecall' ||
      metric === 'findingPrecision' ||
      metric === 'f1' ||
      metric === 'criticalStepAccuracy')
  ) {
    if (metric === 'criticalStepAccuracy' && observation.score.criticalStepAccuracy === null) {
      return null
    }
    return 0
  }
  if (
    observation.error &&
    (metric === 'citationCoverage' ||
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
    'pairedObservations',
    'baselineMean',
    'candidateMean',
    'meanDelta',
    'intervalLow',
    'intervalHigh',
    'confidence',
    'resamples',
  ] as const
  if (numericFields.some((field) => !Number.isFinite(comparison[field]))) {
    throw new Error(
      `compareAnalystRunners: ${comparison.metric} produced non-finite comparison output`,
    )
  }
  if (comparison.intervalLow > comparison.intervalHigh) {
    throw new Error(
      `compareAnalystRunners: ${comparison.metric} produced an invalid confidence interval`,
    )
  }
}
