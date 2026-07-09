/**
 * Paired binary comparison for work items nested inside independent clusters.
 *
 * Pairing is delegated to {@link pairArms}; this module adds the cluster-aware
 * estimands and inference that task-level McNemar/bootstrap utilities cannot
 * provide. Callers keep their own row shape through accessors, and every
 * matched or unpaired result returns the original row object unchanged.
 */

import { ValidationError } from './errors'
import { type PairedArmRow, pairArms } from './paired-arms'
import { mulberry32 } from './statistics'

export type ClusterSignFlipAlternative = 'two-sided' | 'greater' | 'less'

export interface ClusteredPairedBinaryOptions<TRow> {
  /** Arm treated as the control side of every pair. */
  baselineArm: string
  /** Arm treated as the treatment side of every pair. */
  treatmentArm: string
  /** Stable work-item identity shared by both arms. */
  pairKey: (row: TRow) => string
  /** Independent-cluster identity, shared by both rows in a matched pair. */
  clusterKey: (row: TRow) => string
  /** Arm identity for this row. Rows from other arms are ignored. */
  arm: (row: TRow) => string
  /** Binary outcome. */
  pass: (row: TRow) => boolean
  /** Replicate identity when a work item has multiple rows in either arm. */
  repKey?: (row: TRow) => string | undefined
  /** Deterministic seed for bootstrap and Monte Carlo sign-flip draws. */
  seed: number
  /** Percentile confidence level. Default 0.95. */
  confidence?: number
  /** Whole-cluster bootstrap draws. Default 10,000. */
  bootstrapResamples?: number
  /** Sign-flip alternative. Default 'two-sided'. */
  alternative?: ClusterSignFlipAlternative
  /**
   * Enumerate every sign assignment at or below this many non-zero clusters;
   * otherwise use Monte Carlo. Default 20; maximum 20.
   */
  exactClusterLimit?: number
  /** Monte Carlo sign-flip draws when exact enumeration is not used. Default 100,000. */
  signFlipResamples?: number
}

export interface ClusteredMatchedPair<TRow> {
  pairKey: string
  repIndex: number
  clusterKey: string
  baseline: TRow
  treatment: TRow
  baselinePass: boolean
  treatmentPass: boolean
}

export interface ClusteredBinaryCluster {
  clusterKey: string
  nPairs: number
  /** Treatment passes and baseline fails. */
  b10: number
  /** Baseline passes and treatment fails. */
  b01: number
  /** Mean (treatment - baseline) binary outcome within this cluster. */
  meanDifference: number
}

export interface ClusterBootstrapInterval {
  /** The interval resamples clusters and recomputes this task-weighted statistic. */
  statistic: 'task-weighted-risk-difference'
  lower: number
  upper: number
  confidence: number
  resamples: number
  seed: number
}

export interface ClusterSignFlipResult {
  /** Task-weighted paired risk difference, matching the reported bootstrap estimand. */
  statistic: number
  /**
   * Randomization p-value under whole-cluster arm-label exchangeability.
   * `method: 'exact'` means every cluster-level sign assignment was enumerated;
   * it does not make the exchangeability assumption unnecessary.
   */
  pValue: number
  alternative: ClusterSignFlipAlternative
  method: 'exact' | 'monte-carlo'
  /** Exact assignments enumerated or Monte Carlo assignments drawn. */
  assignments: number
  nClusters: number
  nNonZeroClusters: number
  /** Null for exact enumeration, which has no random draws. */
  seed: number | null
}

export interface ClusteredPairedBinaryStatistics {
  nPairs: number
  nClusters: number
  /** Treatment passes and baseline fails, across all matched pairs. */
  b10: number
  /** Baseline passes and treatment fails, across all matched pairs. */
  b01: number
  /** Mean paired difference across tasks, so every task has equal weight. */
  taskWeightedRiskDifference: number
  /** Mean of cluster-level paired differences, so every cluster has equal weight. */
  equalClusterMean: number
  clusters: ClusteredBinaryCluster[]
  /** Null below two independent clusters; one cluster cannot estimate cluster uncertainty. */
  bootstrap: ClusterBootstrapInterval | null
  signFlip: ClusterSignFlipResult
}

export interface ClusteredPairedBinaryResult<TRow> {
  matchedPairs: ClusteredMatchedPair<TRow>[]
  unpairedBaseline: TRow[]
  unpairedTreatment: TRow[]
  /** Null when there are no matched rows; absence is never reported as a zero effect. */
  statistics: ClusteredPairedBinaryStatistics | null
}

interface ProjectedRow<TRow> extends PairedArmRow {
  clusterKey: string
  original: TRow
}

const DEFAULT_BOOTSTRAP_RESAMPLES = 10_000
const DEFAULT_SIGN_FLIP_RESAMPLES = 100_000
const DEFAULT_EXACT_CLUSTER_LIMIT = 20
const SIGN_FLIP_SEED_SALT = 0x9e3779b9

/**
 * Compare binary outcomes on matched work items while respecting independent
 * clusters. The confidence interval resamples whole clusters and recomputes the
 * task-weighted risk difference. The sign-flip test flips whole-cluster outcome
 * totals and tests that same task-weighted estimand.
 */
export function clusteredPairedBinary<TRow>(
  rows: readonly TRow[],
  options: ClusteredPairedBinaryOptions<TRow>,
): ClusteredPairedBinaryResult<TRow> {
  const config = validateOptions(options)
  const projected = projectSelectedRows(rows, options)
  const paired = pairArms(projected, {
    baselineArm: options.baselineArm,
    treatmentArm: options.treatmentArm,
  })

  const matchedPairs = paired.pairs.map((pair): ClusteredMatchedPair<TRow> => {
    const baseline = pair.baseline as ProjectedRow<TRow>
    const treatment = pair.treatment as ProjectedRow<TRow>
    if (baseline.clusterKey !== treatment.clusterKey) {
      throw new ValidationError(
        `clusteredPairedBinary: pairKey '${pair.pairKey}' rep ${pair.repIndex} crosses clusters ` +
          `('${baseline.clusterKey}' vs '${treatment.clusterKey}')`,
      )
    }
    return {
      pairKey: pair.pairKey,
      repIndex: pair.repIndex,
      clusterKey: baseline.clusterKey,
      baseline: baseline.original,
      treatment: treatment.original,
      baselinePass: baseline.pass!,
      treatmentPass: treatment.pass!,
    }
  })

  const unpairedBaseline = paired.unpairedBaseline.map(
    (row) => (row as ProjectedRow<TRow>).original,
  )
  const unpairedTreatment = paired.unpairedTreatment.map(
    (row) => (row as ProjectedRow<TRow>).original,
  )

  if (matchedPairs.length === 0) {
    return { matchedPairs, unpairedBaseline, unpairedTreatment, statistics: null }
  }

  const clusters = summarizeClusters(matchedPairs)
  const b10 = clusters.reduce((sum, cluster) => sum + cluster.b10, 0)
  const b01 = clusters.reduce((sum, cluster) => sum + cluster.b01, 0)
  const taskWeightedRiskDifference = (b10 - b01) / matchedPairs.length
  const equalClusterMean = mean(clusters.map((cluster) => cluster.meanDifference))
  const bootstrap = clusters.length < 2 ? null : clusterBootstrap(clusters, config)
  const signFlip = clusterSignFlip(clusters, config)

  return {
    matchedPairs,
    unpairedBaseline,
    unpairedTreatment,
    statistics: {
      nPairs: matchedPairs.length,
      nClusters: clusters.length,
      b10,
      b01,
      taskWeightedRiskDifference,
      equalClusterMean,
      clusters,
      bootstrap,
      signFlip,
    },
  }
}

interface ValidatedConfig {
  seed: number
  confidence: number
  bootstrapResamples: number
  alternative: ClusterSignFlipAlternative
  exactClusterLimit: number
  signFlipResamples: number
}

function validateOptions<TRow>(options: ClusteredPairedBinaryOptions<TRow>): ValidatedConfig {
  assertNonEmptyString('baselineArm', options.baselineArm)
  assertNonEmptyString('treatmentArm', options.treatmentArm)
  if (options.baselineArm === options.treatmentArm) {
    throw new ValidationError(
      `clusteredPairedBinary: baselineArm and treatmentArm are both '${options.baselineArm}'`,
    )
  }
  if (!Number.isInteger(options.seed)) {
    throw new ValidationError(`clusteredPairedBinary: seed must be an integer, got ${options.seed}`)
  }
  const confidence = options.confidence ?? 0.95
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new ValidationError(
      `clusteredPairedBinary: confidence must be in (0,1), got ${confidence}`,
    )
  }
  const bootstrapResamples = options.bootstrapResamples ?? DEFAULT_BOOTSTRAP_RESAMPLES
  assertPositiveInteger('bootstrapResamples', bootstrapResamples)
  const rawMinimumBootstrapResamples = 2 / (1 - confidence)
  const minimumBootstrapResamples = Math.ceil(
    rawMinimumBootstrapResamples - Number.EPSILON * Math.max(1, rawMinimumBootstrapResamples) * 8,
  )
  if (bootstrapResamples < minimumBootstrapResamples) {
    throw new ValidationError(
      `clusteredPairedBinary: bootstrapResamples must be at least ${minimumBootstrapResamples} for confidence ${confidence} so both interval tails are represented, got ${bootstrapResamples}`,
    )
  }
  const signFlipResamples = options.signFlipResamples ?? DEFAULT_SIGN_FLIP_RESAMPLES
  assertPositiveInteger('signFlipResamples', signFlipResamples)
  const exactClusterLimit = options.exactClusterLimit ?? DEFAULT_EXACT_CLUSTER_LIMIT
  if (
    !Number.isInteger(exactClusterLimit) ||
    exactClusterLimit < 0 ||
    exactClusterLimit > DEFAULT_EXACT_CLUSTER_LIMIT
  ) {
    throw new ValidationError(
      `clusteredPairedBinary: exactClusterLimit must be an integer in [0,${DEFAULT_EXACT_CLUSTER_LIMIT}], got ${exactClusterLimit}`,
    )
  }
  const alternative = options.alternative ?? 'two-sided'
  if (alternative !== 'two-sided' && alternative !== 'greater' && alternative !== 'less') {
    throw new ValidationError(
      `clusteredPairedBinary: alternative must be 'two-sided', 'greater', or 'less', got ${String(alternative)}`,
    )
  }
  return {
    seed: options.seed,
    confidence,
    bootstrapResamples,
    alternative,
    exactClusterLimit,
    signFlipResamples,
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(
      `clusteredPairedBinary: ${name} must be a positive integer, got ${value}`,
    )
  }
}

function projectSelectedRows<TRow>(
  rows: readonly TRow[],
  options: ClusteredPairedBinaryOptions<TRow>,
): ProjectedRow<TRow>[] {
  const projected: ProjectedRow<TRow>[] = []
  for (const original of rows) {
    const arm = options.arm(original)
    assertNonEmptyString('arm', arm)
    if (arm !== options.baselineArm && arm !== options.treatmentArm) continue

    const pairKey = options.pairKey(original)
    const clusterKey = options.clusterKey(original)
    const pass = options.pass(original)
    const repKey = options.repKey?.(original)
    assertNonEmptyString('pairKey', pairKey)
    assertNonEmptyString('clusterKey', clusterKey)
    if (typeof pass !== 'boolean') {
      throw new ValidationError(
        `clusteredPairedBinary: pass accessor must return boolean for pairKey '${pairKey}'`,
      )
    }
    if (repKey !== undefined) assertNonEmptyString('repKey', repKey)
    projected.push({ pairKey, clusterKey, arm, pass, repKey, original })
  }
  return projected
}

function assertNonEmptyString(name: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(
      `clusteredPairedBinary: ${name} accessor must return a non-empty string`,
    )
  }
}

function summarizeClusters<TRow>(
  pairs: readonly ClusteredMatchedPair<TRow>[],
): ClusteredBinaryCluster[] {
  const byCluster = new Map<string, { nPairs: number; b10: number; b01: number }>()
  for (const pair of pairs) {
    const summary = byCluster.get(pair.clusterKey) ?? { nPairs: 0, b10: 0, b01: 0 }
    summary.nPairs++
    if (pair.treatmentPass && !pair.baselinePass) summary.b10++
    else if (pair.baselinePass && !pair.treatmentPass) summary.b01++
    byCluster.set(pair.clusterKey, summary)
  }
  return [...byCluster.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([clusterKey, summary]) => ({
      clusterKey,
      ...summary,
      meanDifference: (summary.b10 - summary.b01) / summary.nPairs,
    }))
}

function clusterBootstrap(
  clusters: readonly ClusteredBinaryCluster[],
  config: ValidatedConfig,
): ClusterBootstrapInterval {
  const rng = mulberry32(config.seed)
  const samples = new Array<number>(config.bootstrapResamples)
  for (let draw = 0; draw < config.bootstrapResamples; draw++) {
    let differenceSum = 0
    let pairCount = 0
    for (let index = 0; index < clusters.length; index++) {
      const cluster = clusters[Math.floor(rng() * clusters.length)]!
      differenceSum += cluster.b10 - cluster.b01
      pairCount += cluster.nPairs
    }
    samples[draw] = differenceSum / pairCount
  }
  samples.sort((a, b) => a - b)
  const alpha = 1 - config.confidence
  const lowerIndex = Math.floor((alpha / 2) * config.bootstrapResamples)
  const upperIndex = Math.min(
    config.bootstrapResamples - 1,
    Math.ceil((1 - alpha / 2) * config.bootstrapResamples) - 1,
  )
  return {
    statistic: 'task-weighted-risk-difference',
    lower: samples[lowerIndex]!,
    upper: samples[Math.max(lowerIndex, upperIndex)]!,
    confidence: config.confidence,
    resamples: config.bootstrapResamples,
    seed: config.seed,
  }
}

function clusterSignFlip(
  clusters: readonly ClusteredBinaryCluster[],
  config: ValidatedConfig,
): ClusterSignFlipResult {
  const clusterTotals = clusters.map((cluster) => cluster.b10 - cluster.b01)
  const nonZero = clusterTotals.filter((delta) => delta !== 0)
  const totalPairs = clusters.reduce((sum, cluster) => sum + cluster.nPairs, 0)
  const statistic = clusterTotals.reduce((sum, delta) => sum + delta, 0) / totalPairs
  if (nonZero.length <= config.exactClusterLimit) {
    const assignments = 2 ** nonZero.length
    let extreme = 0
    for (let mask = 0; mask < assignments; mask++) {
      let sum = 0
      for (let index = 0; index < nonZero.length; index++) {
        sum += (mask & (2 ** index) ? 1 : -1) * nonZero[index]!
      }
      const permuted = sum / totalPairs
      if (isExtreme(permuted, statistic, config.alternative)) extreme++
    }
    return {
      statistic,
      pValue: extreme / assignments,
      alternative: config.alternative,
      method: 'exact',
      assignments,
      nClusters: clusters.length,
      nNonZeroClusters: nonZero.length,
      seed: null,
    }
  }

  const signFlipSeed = (config.seed ^ SIGN_FLIP_SEED_SALT) >>> 0
  const rng = mulberry32(signFlipSeed)
  let extreme = 0
  for (let draw = 0; draw < config.signFlipResamples; draw++) {
    let sum = 0
    for (const delta of nonZero) sum += (rng() < 0.5 ? -1 : 1) * delta
    const permuted = sum / totalPairs
    if (isExtreme(permuted, statistic, config.alternative)) extreme++
  }
  return {
    statistic,
    pValue: (extreme + 1) / (config.signFlipResamples + 1),
    alternative: config.alternative,
    method: 'monte-carlo',
    assignments: config.signFlipResamples,
    nClusters: clusters.length,
    nNonZeroClusters: nonZero.length,
    seed: signFlipSeed,
  }
}

function isExtreme(
  candidate: number,
  observed: number,
  alternative: ClusterSignFlipAlternative,
): boolean {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(observed)) * 16
  if (alternative === 'greater') return candidate >= observed - tolerance
  if (alternative === 'less') return candidate <= observed + tolerance
  return Math.abs(candidate) >= Math.abs(observed) - tolerance
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
