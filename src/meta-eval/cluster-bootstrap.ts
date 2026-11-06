import { ValidationError } from '../errors'
import { clusterBootstrap } from '../statistics/cluster'
import { seedFromData } from '../statistics/internal'

/** One observation and the source cluster it belongs to. */
export interface ClusteredObservation {
  cluster: string
  value: number
  stratum?: string
}

export interface ClusterBootstrapOptions {
  /** Confidence level. Default 0.95. */
  confidence?: number
  /** Bootstrap resample count. Default 2000. */
  resamples?: number
  /** Deterministic seed. If omitted, derived from the values for reproducible intervals. */
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

/** Observation-weighted mean through the shared stratified cluster bootstrap. */
export function clusterBootstrapMean(
  observations: readonly ClusteredObservation[],
  options: ClusterBootstrapOptions = {},
): ClusterBootstrapResult {
  if (
    !observations.length ||
    (options.resamples !== undefined &&
      (!Number.isSafeInteger(options.resamples) || options.resamples < 1))
  ) {
    throw new ValidationError('clusterBootstrapMean: requires observations and positive resamples')
  }
  if (observations.some((row) => !Number.isFinite(row.value))) {
    throw new ValidationError('clusterBootstrapMean: value must be finite')
  }
  const confidence = options.confidence ?? 0.95
  const mean = (rows: readonly ClusteredObservation[]) =>
    rows.reduce((sum, row) => sum + row.value, 0) / rows.length
  return {
    ...clusterBootstrap(observations, (row) => row.cluster, mean, {
      level: confidence,
      seed: options.seed ?? seedFromData([observations.map((row) => row.value)]),
      ...(options.resamples === undefined ? {} : { resamples: options.resamples }),
      strata: (row) => row.stratum ?? '',
    }),
    n: observations.length,
    mean: mean(observations),
    confidence,
  }
}
