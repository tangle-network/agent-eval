/**
 * Join rubric scores to deployment outcomes and measure their association.
 * Higher rubric scores always mean better evaluated behavior.
 * Outcome directions are explicit because success rate and failure rate have opposite meanings.
 * These descriptive associations neither establish causation nor validate a change to rubric weights.
 */

import type { RunRecord } from '../run-record'
import {
  assertUniqueObservationIds,
  type CorrelationInterval,
  correlationSummary,
  hasVariation,
  reduceOutcomeMetric,
  validateObservationOptions,
  validateOutcomeMetricSpecifications,
} from './outcome-observations'
import type { DeploymentOutcome, OutcomeStore } from './outcome-store'

export interface OutcomeMetricSpec {
  /** Exact key in DeploymentOutcome.metrics. */
  id: string
  direction: 'higher-is-better' | 'lower-is-better'
}

export interface RubricPredictiveValidityInput {
  /** One record per independent run; rubric scores come from outcome.raw. */
  runs: RunRecord[]
  outcomes: OutcomeStore
  /** Declare desired directions before inspecting associations. */
  outcomeMetrics: readonly OutcomeMetricSpec[]
  /** Higher is better for each rubric. Omit to discover finite numeric outcome.raw keys. */
  rubrics?: readonly string[]
  /** Minimum joined runs for an estimate; an integer at least 3. Default 8. */
  minSamples?: number
  /** Bootstrap resamples for both correlation intervals. Default 500. */
  bootstrapResamples?: number
  /** Omit to derive a reproducible seed from the paired observations. */
  seed?: number
  /** Reduce finite observations of each named outcome within a run. Default latest. */
  reduction?: 'latest' | 'mean' | 'max'
}

export interface RubricOutcomePair {
  rubric: string
  outcome: string
  outcomeDirection: OutcomeMetricSpec['direction']
  n: number
  /** Raw association with the recorded outcome, before direction alignment. */
  pearson: number
  spearman: number
  pearsonCi95: CorrelationInterval | null
  spearmanCi95: CorrelationInterval | null
  /** Positive values associate higher rubric scores with better outcomes. */
  alignedPearson: number
  alignedSpearman: number
  alignedSpearmanCi95: CorrelationInterval | null
  /** Descriptive buckets at aligned Spearman +/-0.4; no causal or release authority. */
  verdict: 'aligned' | 'inverse' | 'weak'
}

export interface RubricRanking extends Omit<RubricOutcomePair, 'outcome'> {
  /** Outcome with the greatest direction-aligned Spearman for this rubric. */
  bestOutcome: string
}

export interface RubricOutcomeExclusion {
  rubric: string
  outcome: string
  outcomeDirection: OutcomeMetricSpec['direction']
  /** Finite joined observations, including measured zeros. */
  n: number
  reason: 'insufficient_samples' | 'constant_rubric' | 'constant_outcome'
}

export interface RubricPredictiveValidityReport {
  outcomeMetrics: OutcomeMetricSpec[]
  pairs: RubricOutcomePair[]
  /** All declared pairs lacking an estimate, with their usable observation count. */
  excludedPairs: RubricOutcomeExclusion[]
  /** Exploratory ordering by aligned Spearman; never use outcome selection as confirmatory evidence. */
  ranked: RubricRanking[]
  /** Runs contributing at least one finite pair, including pairs below minSamples. */
  joinedSamples: number
  /** Runs contributing no finite pair; joinedSamples + skippedRuns equals the input run count. */
  skippedRuns: number
  /** Declared rubrics with no finite score, distinct from too few outcomes or constant observations. */
  rubricsWithoutData: string[]
}

export async function rubricPredictiveValidity(
  input: RubricPredictiveValidityInput,
): Promise<RubricPredictiveValidityReport> {
  const minSamples = input.minSamples ?? 8
  const reduction = input.reduction ?? 'latest'
  const resamples = input.bootstrapResamples ?? 500
  const seed = input.seed
  if (!Number.isSafeInteger(minSamples) || minSamples < 3) {
    throw new Error('minSamples must be a safe integer at least 3')
  }
  validateObservationOptions(reduction, resamples, seed)
  validateOutcomeMetricSpecifications(input.outcomeMetrics)
  assertUniqueObservationIds(
    input.runs.map((run) => run.runId),
    'runId',
  )

  const outcomeMetrics = input.outcomeMetrics.map((metric) => ({ ...metric }))
  const runs = input.runs.map((run) => ({ runId: run.runId, scores: { ...run.outcome.raw } }))
  const declaredRubrics = input.rubrics === undefined ? undefined : [...input.rubrics]
  if (declaredRubrics !== undefined) assertUniqueObservationIds(declaredRubrics, 'rubric')

  const outcomes = await input.outcomes.list()
  const outcomesByRun = new Map<string, DeploymentOutcome[]>()
  for (const outcome of outcomes) {
    const rows = outcomesByRun.get(outcome.runId) ?? []
    rows.push(outcome)
    outcomesByRun.set(outcome.runId, rows)
  }

  const observedRubrics = new Set<string>()
  for (const run of runs) {
    for (const [rubric, value] of Object.entries(run.scores)) {
      if (typeof value === 'number' && Number.isFinite(value)) observedRubrics.add(rubric)
    }
  }
  const rubrics = declaredRubrics ?? [...observedRubrics]
  const buckets = rubrics.flatMap((rubric) =>
    outcomeMetrics.map((outcome) => ({
      rubric,
      outcome,
      xs: [] as number[],
      ys: [] as number[],
    })),
  )

  let joined = 0
  for (const run of runs) {
    const rows = outcomesByRun.get(run.runId) ?? []
    let joinedThisRun = false
    for (const bucket of buckets) {
      const x = run.scores[bucket.rubric]
      if (typeof x !== 'number' || !Number.isFinite(x)) continue
      const y = reduceOutcomeMetric(rows, bucket.outcome.id, reduction)
      if (y === null) continue
      bucket.xs.push(x)
      bucket.ys.push(y)
      joinedThisRun = true
    }
    if (joinedThisRun) joined++
  }

  const pairs: RubricOutcomePair[] = []
  const excludedPairs: RubricOutcomeExclusion[] = []
  for (const bucket of buckets) {
    const identity = {
      rubric: bucket.rubric,
      outcome: bucket.outcome.id,
      outcomeDirection: bucket.outcome.direction,
      n: bucket.xs.length,
    }
    const reason =
      bucket.xs.length < minSamples
        ? 'insufficient_samples'
        : !hasVariation(bucket.xs)
          ? 'constant_rubric'
          : !hasVariation(bucket.ys)
            ? 'constant_outcome'
            : null
    if (reason !== null) {
      excludedPairs.push({ ...identity, reason })
      continue
    }
    const summary = correlationSummary(bucket.xs, bucket.ys, resamples, seed)
    const sign = bucket.outcome.direction === 'higher-is-better' ? 1 : -1
    const alignedSpearman = summary.spearman * sign
    const alignedSpearmanCi95 =
      summary.spearmanCi95 === null
        ? null
        : sign === 1
          ? summary.spearmanCi95
          : { lower: -summary.spearmanCi95.upper, upper: -summary.spearmanCi95.lower }
    pairs.push({
      ...identity,
      ...summary,
      alignedPearson: summary.pearson * sign,
      alignedSpearman,
      alignedSpearmanCi95,
      verdict: alignedSpearman >= 0.4 ? 'aligned' : alignedSpearman <= -0.4 ? 'inverse' : 'weak',
    })
  }

  const bestByRubric = new Map<string, RubricOutcomePair>()
  for (const pair of pairs) {
    const best = bestByRubric.get(pair.rubric)
    if (!best || pair.alignedSpearman > best.alignedSpearman) bestByRubric.set(pair.rubric, pair)
  }
  const ranked = [...bestByRubric.values()]
    .map(({ outcome, ...pair }) => ({ ...pair, bestOutcome: outcome }))
    .sort((a, b) => b.alignedSpearman - a.alignedSpearman)

  return {
    outcomeMetrics,
    pairs,
    excludedPairs,
    ranked,
    joinedSamples: joined,
    skippedRuns: runs.length - joined,
    rubricsWithoutData: rubrics.filter((rubric) => !observedRubrics.has(rubric)),
  }
}
