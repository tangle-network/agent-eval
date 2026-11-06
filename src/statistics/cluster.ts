import { ValidationError } from '../errors'
import { interpolatedQuantile as quantile } from '../math/quantile'
import { mulberry32 } from './random'

export const DEFAULT_BOOTSTRAP_SEED = 0xc0ffee
export type BootstrapInterval = { low: number; high: number; resamples: number; clusters: number }
export interface ClusterResampleOptions<T> {
  resamples?: number
  seed?: number
  level?: number
  /** Whole clusters are drawn within each stratum, preserving its cluster count. */
  strata?: (item: T, index: number) => string
}

/** Percentile bootstrap; degenerate resamples are omitted, with NaN bounds if none remain. */
export function clusterBootstrap<T>(
  items: readonly T[],
  cluster: (item: T, index: number) => string,
  statistic: (sample: T[]) => number,
  {
    resamples = 2000,
    seed = DEFAULT_BOOTSTRAP_SEED,
    level = 0.95,
    strata,
  }: ClusterResampleOptions<T> = {},
): BootstrapInterval {
  if (!Number.isSafeInteger(resamples) || resamples < 0 || !(level > 0 && level < 1)) {
    throw new ValidationError('clusterBootstrap: requires nonnegative resamples and level in (0,1)')
  }
  const groups = new Map<string, { stratum: string; rows: T[] }>()
  items.forEach((item, index) => {
    const key = cluster(item, index),
      stratum = strata?.(item, index) ?? ''
    if (typeof key !== 'string' || !key || typeof stratum !== 'string') {
      throw new ValidationError('clusterBootstrap: requires string cluster id and stratum')
    }
    const group = groups.get(key) ?? { stratum, rows: [] }
    if (group.stratum !== stratum)
      throw new ValidationError('clusterBootstrap: cluster crosses strata')
    group.rows.push(item)
    groups.set(key, group)
  })
  const cells = new Map<string, T[][]>()
  for (const { stratum, rows } of groups.values()) {
    if (!cells.has(stratum)) cells.set(stratum, [])
    cells.get(stratum)!.push(rows)
  }
  const rng = mulberry32(seed),
    values: number[] = []
  for (let b = 0; b < resamples; b++) {
    const sample = [...cells.values()].flatMap((clusters) =>
      Array.from(
        { length: clusters.length },
        () => clusters[Math.floor(rng() * clusters.length)]!,
      ).flat(),
    )
    const value = statistic(sample)
    if (Number.isFinite(value)) values.push(value)
  }
  values.sort((a, b) => a - b)
  return {
    low: quantile(values, (1 - level) / 2),
    high: quantile(values, (1 + level) / 2),
    resamples,
    clusters: groups.size,
  }
}

export interface PlaceboBandOptions<T> {
  /** Epoch milliseconds; pass one same-cell history per call. */
  timestamp: (row: T) => number
  cluster: (row: T) => string
  /** The exact estimator used on the sealed before/after arms, including failure scoring. */
  statistic: (before: T[], after: T[]) => number
  clustersPerArm: number
  delta: number
  /** Optional preselected epoch-ms boundaries; otherwise use UTC hour boundaries. */
  boundaries?: readonly number[]
  /** Sealed steps on the measured stage, in epoch milliseconds. */
  steps?: readonly number[]
}
export interface PlaceboBandResult {
  status: 'calibrated' | 'uncalibrated'
  n: number
  K: number
  clustersPerArm: number
  boundaries: number[]
  deltas: number[]
  low: number | null
  high: number | null
  q025: number | null
  q975: number | null
}

/** Time-ordered empirical drift band; invert its quantiles around the observed delta. */
export function placeboBand<T>(
  history: readonly T[],
  options: PlaceboBandOptions<T>,
): PlaceboBandResult {
  const { timestamp, cluster, statistic, clustersPerArm, delta, steps = [] } = options
  if (
    !Number.isSafeInteger(clustersPerArm) ||
    clustersPerArm < 1 ||
    !Number.isFinite(delta) ||
    steps.some((t) => !Number.isFinite(t))
  ) {
    throw new ValidationError('placeboBand: invalid cluster count, delta or step')
  }
  const groups = new Map<string, { start: number; end: number; rows: T[] }>()
  for (const row of history) {
    const ts = timestamp(row),
      key = cluster(row)
    if (!Number.isFinite(ts) || typeof key !== 'string' || !key)
      throw new ValidationError('placeboBand: invalid timestamp or cluster')
    const group = groups.get(key) ?? { start: ts, end: ts, rows: [] }
    group.start = Math.min(group.start, ts)
    group.end = Math.max(group.end, ts)
    group.rows.push(row)
    groups.set(key, group)
  }
  const ordered = [...groups.values()].sort((a, b) => a.start - b.start)
  const start = ordered[0]?.start ?? 0,
    end = Math.max(start, ...ordered.map((g) => g.end))
  const hour = 3_600_000
  const candidates = [
    ...(options.boundaries ??
      Array.from(
        { length: Math.max(0, Math.floor(end / hour) - Math.ceil(start / hour) + 1) },
        (_, i) => (Math.ceil(start / hour) + i) * hour,
      )),
  ].sort((a, b) => a - b)
  if (candidates.some((t, i) => !Number.isFinite(t) || (i > 0 && t - candidates[i - 1]! < hour))) {
    throw new ValidationError('placeboBand: boundaries must be at least one hour apart')
  }
  const deltas: number[] = [],
    boundaries: number[] = []
  if (end - start >= 72 * hour)
    for (const boundary of candidates) {
      if (ordered.some((g) => g.start < boundary && g.end >= boundary)) continue
      const before = ordered.filter((g) => g.end < boundary).slice(-clustersPerArm)
      const after = ordered.filter((g) => g.start >= boundary).slice(0, clustersPerArm)
      if (before.length !== clustersPerArm || after.length !== clustersPerArm) continue
      if (steps.some((t) => t >= before[0]!.start && t <= after[after.length - 1]!.end)) continue
      const value = statistic(
        before.flatMap((g) => g.rows),
        after.flatMap((g) => g.rows),
      )
      if (!Number.isFinite(value))
        throw new ValidationError('placeboBand: statistic must be finite')
      boundaries.push(boundary)
      deltas.push(value)
    }
  const calibrated = deltas.length >= 39,
    sorted = [...deltas].sort((a, b) => a - b)
  const q025 = calibrated ? quantile(sorted, 0.025) : null,
    q975 = calibrated ? quantile(sorted, 0.975) : null
  return {
    status: calibrated ? 'calibrated' : 'uncalibrated',
    n: history.length,
    K: deltas.length,
    clustersPerArm,
    boundaries,
    deltas,
    q025,
    q975,
    low: q975 === null ? null : delta - q975,
    high: q025 === null ? null : delta - q025,
  }
}
