/**
 * Design-time power for the randomized served canary, computed with the canary's own estimator.
 *
 * `clusteredPower` simulates a paired design: each row is a within-unit contrast. A served canary
 * is unpaired: each assignment runs in one arm, outcomes are binary, and the decision is a
 * cluster-robust risk difference with refusals for too few or dominant clusters. This simulation
 * draws assignments from a declared cluster structure, randomizes each one to an arm, draws its
 * outcome, and runs the same analysis `decideRandomizedCanary` runs, so the power it reports
 * includes every refusal the decision would make.
 *
 * Outcome model: each cluster has its own success propensity, drawn from a Beta distribution
 * with mean `controlRate` and intracluster correlation `intraclusterCorrelation`. A candidate
 * assignment succeeds with that propensity plus the lift, clipped to [0, 1].
 */

import { ValidationError } from '../errors'
import { mulberry32 } from '../statistics'
import {
  analyzeVerifiedCanaryRows,
  type CanaryCohortReceipt,
  type CanaryObservation,
  type CanaryRefusal,
  sealRandomizedCanaryRule,
} from './randomized-canary'

export interface RandomizedCanaryPowerOptions {
  /** Assignments each cluster contributes by the cutoff, e.g. tasks per repository. */
  clusterSizes: readonly number[]
  /** Control success probability. */
  controlRate: number
  /** Correlation of two assignments' outcomes within one cluster; 0 makes them independent. */
  intraclusterCorrelation: number
  /** Candidate minus control success probabilities to evaluate. */
  lifts: readonly number[]
  /** Probability an assignment is randomized to the candidate. Default 0.5. */
  candidateShare?: number
  /** The registered margin the family-adjusted interval must clear. Default 0. */
  minimumLift?: number
  /** The registered cluster floor. Default 40, the decision's minimum. */
  minimumClusters?: number
  /** Registered confirmatory family size. Default 1. */
  confirmatoryFamilySize?: number
  /** Power required at the design lift. Default 0.8. */
  targetPower?: number
  /** Simulated experiments per lift. Default 2000. */
  trials?: number
  seed: number
}

export interface RandomizedCanaryPowerPoint {
  lift: number
  /** Share of trials whose decision met the success criterion. */
  power: number
  /** Share of trials the decision refused, by reason. */
  refusals: Record<Exclude<CanaryRefusal, null>, number>
  /** Median width of the nominal 95% interval over trials that produced one. */
  medianIntervalWidth: number | null
}

export interface RandomizedCanaryPowerResult {
  clusters: number
  assignments: number
  controlRate: number
  intraclusterCorrelation: number
  candidateShare: number
  minimumLift: number
  targetPower: number
  trials: number
  seed: number
  curve: RandomizedCanaryPowerPoint[]
  /** Smallest evaluated lift whose power reaches `targetPower`, or null when none does. */
  detectableLift: number | null
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new ValidationError(`randomized canary power: ${message}`)
}

/** Standard normal draw (Box-Muller). */
function normal(rng: () => number): number {
  const u = Math.max(rng(), Number.MIN_VALUE)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

/** Gamma(shape, 1) draw (Marsaglia-Tsang; boosted below shape 1). */
function gamma(shape: number, rng: () => number): number {
  if (shape < 1) return gamma(shape + 1, rng) * rng() ** (1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    const x = normal(rng)
    const v = (1 + c * x) ** 3
    if (v <= 0) continue
    const u = rng()
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v
  }
}

function propensity(mean: number, icc: number, rng: () => number): number {
  if (icc === 0) return mean
  // Beta(a, b) with mean a / (a + b) and intracluster correlation 1 / (a + b + 1).
  const total = 1 / icc - 1
  const a = gamma(mean * total, rng)
  const b = gamma((1 - mean) * total, rng)
  return a / (a + b)
}

const COHORT: CanaryCohortReceipt = {
  protocolDigest: 'simulated',
  assignmentRosterDigest: 'simulated',
  assignmentCount: 0,
  assignmentLedgerSourceId: 'simulated',
  assignmentLedgerTipDigest: 'simulated',
  outcomeLedgerSourceId: 'simulated',
  billingLedgerSourceId: 'simulated',
  observationSnapshotDigest: 'simulated',
  observationFrozenAt: '1970-01-01T00:00:00Z',
  authorityId: 'simulated',
  attestationSourceId: 'simulated',
  closedAt: '1970-01-01T00:00:00Z',
  attestedAt: '1970-01-01T00:00:00Z',
}

/** Simulate the canary decision under a declared cluster structure and outcome model. */
export function randomizedCanaryPower(
  options: RandomizedCanaryPowerOptions,
): RandomizedCanaryPowerResult {
  const {
    clusterSizes,
    controlRate,
    intraclusterCorrelation: icc,
    lifts,
    candidateShare = 0.5,
    minimumLift = 0,
    minimumClusters = 40,
    confirmatoryFamilySize = 1,
    targetPower = 0.8,
    trials = 2000,
    seed,
  } = options
  check(
    clusterSizes.length > 0 && clusterSizes.every((n) => Number.isSafeInteger(n) && n >= 1),
    'clusterSizes must be positive integers',
  )
  check(controlRate > 0 && controlRate < 1, 'controlRate must be in (0, 1)')
  check(icc >= 0 && icc < 1, 'intraclusterCorrelation must be in [0, 1)')
  check(lifts.length > 0 && lifts.every((lift) => lift >= 0 && lift < 1), 'lifts must be in [0, 1)')
  check(candidateShare > 0 && candidateShare < 1, 'candidateShare must be in (0, 1)')
  check(targetPower > 0 && targetPower < 1, 'targetPower must be in (0, 1)')
  check(Number.isSafeInteger(trials) && trials >= 1, 'trials must be a positive integer')
  check(Number.isSafeInteger(seed), 'seed must be an integer')
  const digest = 'sha256:simulated'
  const sealed = sealRandomizedCanaryRule({
    experimentId: 'power',
    populationId: 'power',
    eligibilityRuleDigest: digest,
    randomizationSourceId: 'power',
    assignmentLedgerAuthorityId: 'power',
    controlProfileDigest: 'control',
    candidateProfileDigest: 'candidate',
    servedCodeRevisionDigest: 'served',
    outcomeCheckerDigest: 'checker',
    confirmatoryFamilyId: 'power',
    confirmatoryFamilySize,
    confirmatoryIndex: 1,
    familyReservationSourceId: 'power',
    assignmentUnit: 'task',
    clusterUnit: 'repository',
    stoppingRule: 'fixed-time',
    analysisCutoff: '1970-01-01T00:00:00Z',
    outcomeMaturityMs: 0,
    minimumLift,
    minimumClusters,
  })
  const curve = lifts.map((lift, liftIndex): RandomizedCanaryPowerPoint => {
    const rng = mulberry32((seed + Math.imul(liftIndex + 1, 0x9e3779b1)) >>> 0)
    const refusals = {
      'missing-evidence': 0,
      'missing-trace': 0,
      'execution-drift': 0,
      'insufficient-clusters': 0,
      'dominant-cluster': 0,
      'zero-variance': 0,
    }
    let passes = 0
    const widths: number[] = []
    for (let trial = 0; trial < trials; trial++) {
      const rows: CanaryObservation[] = []
      for (const [cluster, size] of clusterSizes.entries()) {
        const q = propensity(controlRate, icc, rng)
        for (let k = 0; k < size; k++) {
          const arm = rng() < candidateShare ? 'candidate' : 'control'
          const p = arm === 'candidate' ? Math.min(1, q + lift) : q
          const id = `${cluster}-${k}`
          rows.push({
            assignmentId: id,
            assignmentSourceId: id,
            clusterId: String(cluster),
            arm,
            checkedOutcome: rng() < p ? 1 : 0,
            outcomeSourceId: 'simulated',
            billedCostUsd: null,
            billingSourceId: 'simulated',
            billingBasis: 'subscription',
            traceSourceId: 'simulated',
            noExecutionSourceId: null,
            servedProfileDigest: arm === 'candidate' ? 'candidate' : 'control',
            servedCodeRevisionDigest: 'served',
            outcomeCheckerDigest: 'checker',
            turns: 1,
          })
        }
      }
      const decision = analyzeVerifiedCanaryRows(sealed, COHORT, rows)
      if (decision.refusal !== null) refusals[decision.refusal]++
      if (decision.successCriterionMet) passes++
      if (decision.nominal95Interval !== null)
        widths.push(decision.nominal95Interval.high - decision.nominal95Interval.low)
    }
    widths.sort((a, b) => a - b)
    return {
      lift,
      power: passes / trials,
      refusals: Object.fromEntries(
        Object.entries(refusals).map(([reason, count]) => [reason, count / trials]),
      ) as RandomizedCanaryPowerPoint['refusals'],
      medianIntervalWidth: widths.length === 0 ? null : widths[Math.floor(widths.length / 2)]!,
    }
  })
  const detectable = curve
    .filter((point) => point.power >= targetPower)
    .map((point) => point.lift)
    .sort((a, b) => a - b)[0]
  return {
    clusters: clusterSizes.length,
    assignments: clusterSizes.reduce((total, n) => total + n, 0),
    controlRate,
    intraclusterCorrelation: icc,
    candidateShare,
    minimumLift,
    targetPower,
    trials,
    seed,
    curve,
    detectableLift: detectable ?? null,
  }
}
