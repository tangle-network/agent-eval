import { ValidationError } from '../errors'
import { makeRng } from '../statistics/internal'

/** One observation and the source cluster it belongs to. */
export interface ClusteredObservation {
  cluster: string
  value: number
}

export interface ClusterBootstrapOptions {
  /** Confidence level. Default 0.95. */
  confidence?: number
  /** Bootstrap resample count. Default 2000. */
  resamples?: number
  /** Deterministic seed. If omitted, derived from the values so the interval is reproducible. */
  seed?: number
}

export interface ClusterBootstrapResult {
  n: number
  clusters: number
  /** Mean over observations, each observation weighted equally. */
  mean: number
  low: number
  high: number
  confidence: number
  resamples: number
}

/**
 * Percentile cluster bootstrap of an observation mean. Whole clusters are resampled with
 * replacement and each resample's statistic is Σ values / Σ observations over the drawn
 * clusters, so observations that share a source move together and a large cluster cannot
 * pose as many independent results. For a paired comparison pass the per-observation
 * difference (candidate − baseline) under the observation's cluster.
 *
 * With one cluster the interval collapses to the point estimate: there is no between-cluster
 * spread to measure, which callers must treat as no interval, not as certainty.
 */
export function clusterBootstrapMean(
  observations: readonly ClusteredObservation[],
  options: ClusterBootstrapOptions = {},
): ClusterBootstrapResult {
  const confidence = options.confidence ?? 0.95
  const resamples = options.resamples ?? 2000
  if (!(confidence > 0 && confidence < 1)) {
    throw new ValidationError(
      `clusterBootstrapMean: confidence must be in (0,1), got ${confidence}`,
    )
  }
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new ValidationError(
      `clusterBootstrapMean: resamples must be a positive integer, got ${resamples}`,
    )
  }
  if (!observations.length) {
    throw new ValidationError('clusterBootstrapMean: requires at least one observation')
  }

  const sums = new Map<string, { sum: number; count: number }>()
  const values: number[] = []
  for (const [index, observation] of observations.entries()) {
    if (typeof observation?.cluster !== 'string' || observation.cluster === '') {
      throw new ValidationError(`clusterBootstrapMean: observation ${index} needs a cluster id`)
    }
    if (!Number.isFinite(observation.value)) {
      throw new ValidationError(`clusterBootstrapMean: observation ${index} value must be finite`)
    }
    const cell = sums.get(observation.cluster) ?? { sum: 0, count: 0 }
    cell.sum += observation.value
    cell.count += 1
    sums.set(observation.cluster, cell)
    values.push(observation.value)
  }

  const cells = [...sums.values()]
  const total = cells.reduce((acc, cell) => acc + cell.sum, 0)
  const mean = total / observations.length
  const k = cells.length
  const rng = makeRng(options.seed, values)
  const samples = new Array<number>(resamples)
  for (let b = 0; b < resamples; b++) {
    let sum = 0
    let count = 0
    for (let draw = 0; draw < k; draw++) {
      const cell = cells[Math.floor(rng() * k)]!
      sum += cell.sum
      count += cell.count
    }
    samples[b] = sum / count
  }
  samples.sort((a, b) => a - b)
  const alpha = 1 - confidence
  const lowIdx = Math.floor((alpha / 2) * resamples)
  const highIdx = Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1)
  return {
    n: observations.length,
    clusters: k,
    mean,
    low: samples[lowIdx]!,
    high: samples[Math.max(highIdx, lowIdx)]!,
    confidence,
    resamples,
  }
}
