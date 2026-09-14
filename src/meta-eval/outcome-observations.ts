import { pearsonR, spearmanR } from '../statistics'
import { makeRng } from '../statistics/internal'
import type { DeploymentOutcome } from './outcome-store'

export type OutcomeReduction = 'latest' | 'mean' | 'max'

export interface CorrelationInterval {
  lower: number
  upper: number
}

/** Reduce observations of one named metric; unrelated keys cannot supply a value. */
export function reduceOutcomeMetric(
  outcomes: readonly DeploymentOutcome[],
  metric: string,
  reduction: OutcomeReduction,
): number | null {
  const observations = outcomes.flatMap((outcome) => {
    const value = outcome.metrics[metric]
    return Number.isFinite(outcome.capturedAt) &&
      typeof value === 'number' &&
      Number.isFinite(value)
      ? [{ capturedAt: outcome.capturedAt, value }]
      : []
  })
  if (observations.length === 0) return null
  if (reduction === 'mean') {
    return observations.reduce(
      (sum, observation) => sum + observation.value / observations.length,
      0,
    )
  }
  if (reduction === 'max') return Math.max(...observations.map((observation) => observation.value))
  return observations.reduce((a, b) => (b.capturedAt > a.capturedAt ? b : a)).value
}

export function hasVariation(values: readonly number[]): boolean {
  return values.some((value) => value !== values[0])
}

export function correlationSummary(
  xs: number[],
  ys: number[],
  iterations: number,
  seed: number | undefined,
): {
  pearson: number
  spearman: number
  pearsonCi95: CorrelationInterval | null
  spearmanCi95: CorrelationInterval | null
} {
  const rng = makeRng(seed, xs, ys)
  const pearsons: number[] = []
  const spearmans: number[] = []
  for (let b = 0; b < iterations; b++) {
    const rx: number[] = []
    const ry: number[] = []
    for (let i = 0; i < xs.length; i++) {
      const index = Math.floor(rng() * xs.length)
      rx.push(xs[index]!)
      ry.push(ys[index]!)
    }
    // A constant resample has no estimable correlation, even when both sides agree.
    if (!hasVariation(rx) || !hasVariation(ry)) continue
    const pearson = pearsonR(rx, ry)
    const spearman = spearmanR(rx, ry)
    if (Number.isFinite(pearson)) pearsons.push(pearson)
    if (Number.isFinite(spearman)) spearmans.push(spearman)
  }
  return {
    pearson: pearsonR(xs, ys),
    spearman: spearmanR(xs, ys),
    pearsonCi95: interval(pearsons),
    spearmanCi95: interval(spearmans),
  }
}

export function validateObservationOptions(
  reduction: OutcomeReduction,
  iterations: number,
  seed: number | undefined,
): void {
  if (!['latest', 'mean', 'max'].includes(reduction)) {
    throw new Error('outcome reduction must be latest, mean, or max')
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error('bootstrap iterations must be a positive safe integer')
  }
  if (seed !== undefined && !Number.isFinite(seed)) {
    throw new Error('bootstrap seed must be finite')
  }
}

export function assertUniqueObservationIds(ids: readonly string[], name: string): void {
  if (ids.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    throw new Error(`${name} must be a nonempty string`)
  }
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate ${name} in outcome study`)
}

export function validateOutcomeMetricSpecifications(
  metrics: readonly { id: string; direction: string }[],
): void {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new Error('outcomeMetrics must declare at least one outcome metric and direction')
  }
  for (const metric of metrics) {
    if (!metric || typeof metric.id !== 'string' || metric.id.trim().length === 0) {
      throw new Error('each outcome metric must have a nonempty id and explicit direction')
    }
    if (metric.direction !== 'higher-is-better' && metric.direction !== 'lower-is-better') {
      throw new Error(
        `outcome metric ${metric.id} must declare higher-is-better or lower-is-better`,
      )
    }
  }
  assertUniqueObservationIds(
    metrics.map((metric) => metric.id),
    'outcome metric',
  )
}

function interval(values: number[]): CorrelationInterval | null {
  if (values.length === 0) return null
  values.sort((a, b) => a - b)
  return {
    lower: Math.max(-1, values[Math.floor(0.025 * values.length)]!),
    upper: Math.min(1, values[Math.min(values.length - 1, Math.floor(0.975 * values.length))]!),
  }
}
