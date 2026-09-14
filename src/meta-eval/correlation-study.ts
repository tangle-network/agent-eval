/**
 * Correlation study — "does our eval score predict real-world outcomes?"
 *
 * Joins traces and outcomes by runId and reports descriptive correlations.
 * Independent runs are the bootstrap observation unit.
 * Association alone does not establish causation or held-out predictive performance.
 */

import { runMetricExtractor } from '../trace/query'
import type { Run } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import {
  assertUniqueObservationIds,
  correlationSummary,
  hasVariation,
  reduceOutcomeMetric,
  validateObservationOptions,
} from './outcome-observations'
import type { DeploymentOutcome, OutcomeFilter, OutcomeStore } from './outcome-store'

export interface EvalMetricSpec {
  id: string
  /** Extract a scalar from a run. Omit it and `id` must name one of
   *  `RUN_METRICS`; any other `id` is refused. */
  extract?: (run: Run, store: TraceStore) => Promise<number | null>
}

export interface OutcomePair {
  evalMetric: string
  outcomeMetric: string
}

export interface CorrelationResult {
  evalMetric: string
  outcomeMetric: string
  n: number
  pearson: number
  spearman: number
  /** 95% bootstrap CI for Pearson. */
  pearsonCi95: { lower: number; upper: number } | null
  /** 95% bootstrap CI for Spearman; null when no resample is estimable. */
  spearmanCi95: { lower: number; upper: number } | null
  /** Rough verdict: 'strong' ≥ 0.7, 'moderate' ≥ 0.4, else 'weak'. */
  verdict: 'strong' | 'moderate' | 'weak'
}

export interface CorrelationStudyResult {
  pairs: CorrelationResult[]
  /** Declared pairs without an estimable correlation, including their usable sample count. */
  excludedPairs: Array<
    OutcomePair & {
      n: number
      reason: 'insufficient_samples' | 'constant_eval_metric' | 'constant_outcome'
    }
  >
  joinedSamples: number
  skippedRuns: number
}

export interface CorrelationStudyOptions {
  /** Only join outcomes captured within this window after run.startedAt. */
  maxCaptureLagMs?: number
  /** Restrict to a subset of outcomes (cohort, region, source). */
  outcomeFilter?: OutcomeFilter
  /** Which outcome per run to use when multiple exist. Default 'latest'. */
  reduction?: 'latest' | 'mean' | 'max'
  /** Bootstrap iterations for the CI. Default 500. */
  bootstrapIterations?: number
  /** Seed for the bootstrap resampler. Absent, the seed is derived from the
   *  paired observations, so the same study reproduces the same interval. */
  seed?: number
}

export async function correlationStudy(
  traceStore: TraceStore,
  outcomeStore: OutcomeStore,
  evalMetrics: EvalMetricSpec[],
  outcomeMetricNames: string[],
  options: CorrelationStudyOptions = {},
): Promise<CorrelationStudyResult> {
  const reduction = options.reduction ?? 'latest'
  const iterations = options.bootstrapIterations ?? 500
  const seed = options.seed
  validateObservationOptions(reduction, iterations, seed)
  assertUniqueObservationIds(
    evalMetrics.map((metric) => metric.id),
    'eval metric',
  )
  assertUniqueObservationIds(outcomeMetricNames, 'outcome metric')
  const maxLag = options.maxCaptureLagMs ?? Infinity
  if (maxLag < 0 || Number.isNaN(maxLag)) {
    throw new Error('maxCaptureLagMs must be nonnegative')
  }
  const extractors = evalMetrics.map((metric) => ({
    ...metric,
    extract: metric.extract ?? runMetricExtractor(metric.id),
  }))
  const metricNames = [...outcomeMetricNames]
  const runs = await traceStore.listRuns()
  assertUniqueObservationIds(
    runs.map((run) => run.runId),
    'runId',
  )
  const outcomes = await outcomeStore.list(options.outcomeFilter)
  const outcomesByRun = new Map<string, DeploymentOutcome[]>()
  for (const o of outcomes) {
    const arr = outcomesByRun.get(o.runId) ?? []
    arr.push(o)
    outcomesByRun.set(o.runId, arr)
  }

  const pairs: Array<{ evalMetric: string; outcomeMetric: string; xs: number[]; ys: number[] }> = []
  for (const em of extractors) {
    for (const om of metricNames) {
      pairs.push({ evalMetric: em.id, outcomeMetric: om, xs: [], ys: [] })
    }
  }

  let joined = 0
  let skipped = 0
  for (const run of runs) {
    const os = outcomesByRun.get(run.runId)
    if (!os || os.length === 0) {
      skipped++
      continue
    }
    const eligible = os.filter((o) => {
      const lag = o.capturedAt - run.startedAt
      return lag >= 0 && lag <= maxLag
    })
    if (eligible.length === 0) {
      skipped++
      continue
    }

    let joinedThisRun = false
    for (const em of extractors) {
      const x = await em.extract(run, traceStore)
      if (x === null || !Number.isFinite(x)) continue

      for (const om of metricNames) {
        const y = reduceOutcomeMetric(eligible, om, reduction)
        if (y === null) continue
        const pair = pairs.find((p) => p.evalMetric === em.id && p.outcomeMetric === om)!
        pair.xs.push(x)
        pair.ys.push(y)
        joinedThisRun = true
      }
    }
    if (joinedThisRun) joined++
    else skipped++
  }

  const excludedPairs: CorrelationStudyResult['excludedPairs'] = []
  const results: CorrelationResult[] = []
  for (const p of pairs) {
    const reason =
      p.xs.length < 3
        ? 'insufficient_samples'
        : !hasVariation(p.xs)
          ? 'constant_eval_metric'
          : !hasVariation(p.ys)
            ? 'constant_outcome'
            : null
    if (reason !== null) {
      excludedPairs.push({
        evalMetric: p.evalMetric,
        outcomeMetric: p.outcomeMetric,
        n: p.xs.length,
        reason,
      })
      continue
    }
    const summary = correlationSummary(p.xs, p.ys, iterations, seed)
    const verdict: CorrelationResult['verdict'] =
      Math.abs(summary.pearson) >= 0.7
        ? 'strong'
        : Math.abs(summary.pearson) >= 0.4
          ? 'moderate'
          : 'weak'
    results.push({
      evalMetric: p.evalMetric,
      outcomeMetric: p.outcomeMetric,
      n: p.xs.length,
      ...summary,
      verdict,
    })
  }
  return { pairs: results, excludedPairs, joinedSamples: joined, skippedRuns: skipped }
}
