/**
 * Design-time power for task-clustered paired designs, with a refusal verdict.
 *
 * The failure this prevents (measured): a pre-registered kill test fixed a
 * task-clustered bootstrap over 14 rows in 4 task clusters. Simulated at the
 * registered seed, the design's power topped out at 0.69 — at a per-row
 * effect of 1.0. "Four clusters cannot certify any effect size, including
 * 1.0" was learned by running the experiment; this module computes it before
 * a dollar is spent.
 *
 * Two floors, one simulation:
 *  - Closed form, zero spend: with C independent clusters the exact
 *    whole-cluster sign-flip test can never produce a two-sided p below
 *    2^(1-C). C=4 gives 0.125; C=3 gives 0.25 — both above a 0.05 alpha, so
 *    those designs are refused at ANY effect size, before simulation.
 *  - Seeded simulation: per-row paired contrasts drawn under a registered
 *    effect model, a whole-cluster percentile bootstrap on each trial, power =
 *    the fraction of trials whose interval excludes zero.
 *
 * The refusal is a verdict INSIDE the returned artifact (the powerPreflight
 * shape, made cluster-aware); `assertDesignAdequate` turns it into a throw for
 * callers that want configuration-time failure.
 */

import { ValidationError } from '../errors'
import { mulberry32 } from '../statistics'

/** A design refused at configuration time, before any spend. */
export class DesignRefusalError extends ValidationError {}

export interface ClusteredPowerOptions {
  /** Rows per independent cluster, e.g. [6, 3, 3, 2]. */
  clusterSizes: number[]
  /** Per-row effect grid: each effect is P(win) - P(loss) added to the base rates. */
  effects: number[]
  /** Deterministic seed for outcome draws and bootstrap resampling. */
  seed: number
  /** Simulated experiments per effect. Default 2000. */
  trials?: number
  /** Whole-cluster bootstrap draws per trial. Default 4000. */
  resamples?: number
  /** Percentile interval level. Default 0.95. */
  confidence?: number
  /** Sign-flip alpha the closed-form floor is checked against. Default 0.05. */
  alpha?: number
  /** Power the design must reach at some grid effect. Default 0.8. */
  targetPower?: number
  /** Base P(row favors treatment) with no effect. Default 0.10 (tie-heavy rows). */
  baseWinRate?: number
  /** Base P(row favors control). Default 0.10. */
  baseLossRate?: number
  /**
   * Clusters whose rows carry outcome noise instead of signal: each row wins
   * with `flipRate` and loses with `flipRate`, independent of the effect.
   * Index into `clusterSizes`.
   */
  noisyClusters?: { index: number; flipRate: number }[]
}

export interface ClusteredPowerPoint {
  effect: number
  power: number
  medianCiWidth: number
}

export interface SignFlipFloor {
  /** Smallest achievable two-sided p: 2^(1-C) for C clusters. */
  twoSidedP: number
  /** Smallest achievable one-sided p: 2^-C. */
  oneSidedP: number
  alpha: number
  /** False when the cluster count can never certify at `alpha`, at any effect. */
  certifiableAtAlpha: boolean
  /** Smallest cluster count whose two-sided floor is at or under `alpha`. */
  minClustersForAlpha: number
}

export interface ClusteredPowerRefusal {
  verdict: 'underpowered'
  reasons: string[]
  recommendation: string
}

export interface ClusteredPowerResult {
  clusterCount: number
  totalRows: number
  trials: number
  resamples: number
  seed: number
  confidence: number
  targetPower: number
  curve: ClusteredPowerPoint[]
  /** Maximum simulated power across the effect grid. */
  maxPower: number
  signFlipFloor: SignFlipFloor
  /** True only when the sign-flip floor certifies AND simulation reaches target. */
  adequate: boolean
  /** Populated exactly when `adequate` is false. The refusal lives in the artifact. */
  refusal: ClusteredPowerRefusal | null
}

/**
 * Simulate the power of a whole-cluster percentile-bootstrap design and refuse
 * a structure that cannot reach the target at any registered effect.
 */
export function clusteredPower(options: ClusteredPowerOptions): ClusteredPowerResult {
  const clusterSizes = options.clusterSizes
  if (clusterSizes.length === 0 || clusterSizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new ValidationError(
      `clusteredPower: clusterSizes must be positive integers, got [${clusterSizes.join(', ')}]`,
    )
  }
  if (options.effects.length === 0) {
    throw new ValidationError('clusteredPower: effects grid is empty')
  }
  if (!Number.isInteger(options.seed)) {
    throw new ValidationError(`clusteredPower: seed must be an integer, got ${options.seed}`)
  }
  const trials = options.trials ?? 2000
  const resamples = options.resamples ?? 4000
  if (!Number.isInteger(trials) || trials <= 0 || !Number.isInteger(resamples) || resamples <= 0) {
    throw new ValidationError(
      `clusteredPower: trials and resamples must be positive integers, got ${trials}/${resamples}`,
    )
  }
  const confidence = options.confidence ?? 0.95
  if (confidence <= 0 || confidence >= 1) {
    throw new ValidationError(`clusteredPower: confidence must be in (0,1), got ${confidence}`)
  }
  const alpha = options.alpha ?? 0.05
  const targetPower = options.targetPower ?? 0.8
  const baseWinRate = options.baseWinRate ?? 0.1
  const baseLossRate = options.baseLossRate ?? 0.1
  const noisy = new Map<number, number>()
  for (const cluster of options.noisyClusters ?? []) {
    if (cluster.index < 0 || cluster.index >= clusterSizes.length) {
      throw new ValidationError(
        `clusteredPower: noisy cluster index ${cluster.index} outside [0,${clusterSizes.length - 1}]`,
      )
    }
    noisy.set(cluster.index, cluster.flipRate)
  }

  const clusterCount = clusterSizes.length
  const totalRows = clusterSizes.reduce((a, b) => a + b, 0)
  const signFlipFloor = computeSignFlipFloor(clusterCount, alpha)

  const curve: ClusteredPowerPoint[] = []
  for (const effect of options.effects) {
    curve.push(
      simulateEffect(effect, {
        clusterSizes,
        seed: options.seed,
        trials,
        resamples,
        confidence,
        baseWinRate,
        baseLossRate,
        noisy,
      }),
    )
  }
  const maxPower = Math.max(...curve.map((point) => point.power))

  const reasons: string[] = []
  if (!signFlipFloor.certifiableAtAlpha) {
    reasons.push(
      `${clusterCount} clusters cannot certify any effect size, including 1.0: the exact ` +
        `whole-cluster sign-flip test's smallest two-sided p is 2^(1-${clusterCount}) = ` +
        `${signFlipFloor.twoSidedP} > alpha ${alpha}; at least ` +
        `${signFlipFloor.minClustersForAlpha} clusters are needed`,
    )
  }
  if (maxPower < targetPower) {
    const best = curve.reduce((a, b) => (b.power > a.power ? b : a))
    reasons.push(
      `simulated power tops out at ${maxPower.toFixed(3)} (effect ${best.effect}) across the ` +
        `registered grid — below the ${targetPower} target at every effect`,
    )
  }
  const adequate = reasons.length === 0
  return {
    clusterCount,
    totalRows,
    trials,
    resamples,
    seed: options.seed,
    confidence,
    targetPower,
    curve,
    maxPower,
    signFlipFloor,
    adequate,
    refusal: adequate
      ? null
      : {
          verdict: 'underpowered',
          reasons,
          recommendation:
            `Do not spend on this structure. Add independent clusters (>= ` +
            `${Math.max(signFlipFloor.minClustersForAlpha, clusterCount)}) or register a design ` +
            `whose simulated power reaches ${targetPower}, then re-run clusteredPower.`,
        },
  }
}

/** Throw the refusal for callers that want configuration-time failure. */
export function assertDesignAdequate(result: ClusteredPowerResult): void {
  if (result.refusal) {
    throw new DesignRefusalError(
      `design refused (underpowered): ${result.refusal.reasons.join('; ')}`,
    )
  }
}

function computeSignFlipFloor(clusterCount: number, alpha: number): SignFlipFloor {
  const twoSidedP = 2 ** (1 - clusterCount)
  const oneSidedP = 2 ** -clusterCount
  let minClusters = 1
  while (2 ** (1 - minClusters) > alpha) minClusters += 1
  return {
    twoSidedP,
    oneSidedP,
    alpha,
    certifiableAtAlpha: twoSidedP <= alpha,
    minClustersForAlpha: minClusters,
  }
}

interface SimulationConfig {
  clusterSizes: number[]
  seed: number
  trials: number
  resamples: number
  confidence: number
  baseWinRate: number
  baseLossRate: number
  noisy: Map<number, number>
}

/**
 * One effect point. Per row the paired contrast is +1 with probability
 * min(baseWin + effect, 1), -1 with the base loss rate (capped by what
 * remains), else 0. Noisy clusters draw win and loss independently at their
 * flip rate. Each trial computes a whole-cluster percentile bootstrap of the
 * pooled row mean; the trial counts toward power when the interval excludes
 * zero.
 */
function simulateEffect(effect: number, config: SimulationConfig): ClusteredPowerPoint {
  const rng = mulberry32(mixSeed(config.seed, effect))
  const clusterCount = config.clusterSizes.length
  let excludes = 0
  const widths = new Array<number>(config.trials)
  const sums = new Array<number>(clusterCount)
  const means = new Array<number>(config.resamples)
  for (let trial = 0; trial < config.trials; trial++) {
    for (let cluster = 0; cluster < clusterCount; cluster++) {
      const size = config.clusterSizes[cluster]!
      const flipRate = config.noisy.get(cluster)
      let sum = 0
      for (let row = 0; row < size; row++) {
        if (flipRate !== undefined) {
          const win = rng() < flipRate ? 1 : 0
          const loss = rng() < flipRate ? 1 : 0
          sum += win - loss
        } else {
          const winRate = Math.min(1, config.baseWinRate + effect)
          const lossRate = Math.min(1 - winRate, config.baseLossRate)
          const u = rng()
          sum += u < winRate ? 1 : u < winRate + lossRate ? -1 : 0
        }
      }
      sums[cluster] = sum
    }
    for (let draw = 0; draw < config.resamples; draw++) {
      let pooledSum = 0
      let pooledRows = 0
      for (let pick = 0; pick < clusterCount; pick++) {
        const index = Math.floor(rng() * clusterCount)
        pooledSum += sums[index]!
        pooledRows += config.clusterSizes[index]!
      }
      means[draw] = pooledSum / pooledRows
    }
    means.sort((a, b) => a - b)
    const tail = 1 - config.confidence
    const lower = means[Math.floor((tail / 2) * config.resamples)]!
    const upper =
      means[
        Math.max(
          Math.floor((tail / 2) * config.resamples),
          Math.min(config.resamples - 1, Math.ceil((1 - tail / 2) * config.resamples) - 1),
        )
      ]!
    widths[trial] = upper - lower
    if (lower > 0 || upper < 0) excludes += 1
  }
  widths.sort((a, b) => a - b)
  return {
    effect,
    power: excludes / config.trials,
    medianCiWidth: widths[Math.floor(config.trials / 2)]!,
  }
}

/** Fold the effect into the seed so every grid point draws an independent stream. */
function mixSeed(seed: number, effect: number): number {
  const scaled = Math.round(effect * 1_000_003)
  return ((seed ^ (scaled * 0x9e3779b9)) >>> 0) | 0
}
