/** Shared significance, regression, precision, and budget decisions on paired receipts. */

import {
  type AgentImprovementCost,
  type AgentImprovementMeasuredComparison,
  agentCandidateEvaluationPolicySchema,
  numbersApproximatelyEqual,
} from '@tangle-network/agent-interface'
import { heldoutSignificance } from '../campaign/gates/statistical-heldout'
import { decidePairedPromotion } from '../paired-promotion-decision'
import { pairedBootstrap } from '../statistics'
import type {
  EvaluatePairedMeasurementsOptions,
  PairedMeasurementEvaluation,
} from './measured-comparison-types'
import {
  dimensionScore,
  projectPairedMeasurement,
  sharedProjectedDimensions,
} from './paired-measurement-input'

/**
 * Calculate the shared paired decision from any complete receipt shape.
 *
 * Callers still own sealing their tasks, verifying each receipt against its
 * expected arm and state, and proving every expected cell exists. This function
 * only validates the projected measurements and derives their shared decision.
 */
export function evaluatePairedMeasurements<TRun>(
  options: EvaluatePairedMeasurementsOptions<TRun>,
): PairedMeasurementEvaluation {
  const s0 = validatePairedInput({ options })
  const s1 = pairedEstimates(s0)
  const s2 = dimensionRegressions(s1)
  const s3 = runTotals(s2)
  const s4 = budgetAndChecks(s3)
  return pairedVerdict(s4)
}

/** The checked policy and measurements, their cell ids, shared dimensions and score arrays. */
function validatePairedInput<TRun>(prev: { options: EvaluatePairedMeasurementsOptions<TRun> }) {
  const { options } = prev
  if (options.measurements.length === 0) {
    throw new Error('paired measurement evaluation requires at least one paired cell')
  }
  const preparationCost = options.preparationCost ?? { usd: 0, provenance: 'observed' as const }
  if (!Number.isFinite(preparationCost.usd) || preparationCost.usd < 0) {
    throw new Error('paired measurement evaluation preparation cost must be a non-negative number')
  }
  if (typeof options.sharedScorerChannel !== 'boolean') {
    throw new Error('paired measurement evaluation sharedScorerChannel must be a boolean')
  }
  const policy = agentCandidateEvaluationPolicySchema.parse(options.policy)
  const measurements = options.measurements.map((measurement, index) =>
    projectPairedMeasurement(measurement, index, options.adapter),
  )
  const cellIds = measurements.map((measurement) => measurement.cellId)
  if (new Set(cellIds).size !== cellIds.length) {
    throw new Error('paired measurement evaluation cell ids must be unique')
  }
  const dimensions = sharedProjectedDimensions(measurements)
  const baselineScores = measurements.map((measurement) => measurement.baseline.score)
  const candidateScores = measurements.map((measurement) => measurement.candidate.score)
  const {
    confidenceLevel: confidence,
    resamples,
    bootstrapSeed,
    deltaThreshold,
    minProductiveRuns,
    budgetUsd,
    criticalDimensions,
    regressionTolerance,
  } = policy
  return {
    ...prev,
    preparationCost,
    policy,
    measurements,
    cellIds,
    dimensions,
    baselineScores,
    candidateScores,
    confidence,
    resamples,
    bootstrapSeed,
    deltaThreshold,
    minProductiveRuns,
    budgetUsd,
    criticalDimensions,
    regressionTolerance,
  }
}

/** Held-out significance, the overall, cost and latency estimates, and the observed power. */
function pairedEstimates<TRun>(prev: ReturnType<typeof validatePairedInput<TRun>>) {
  const {
    options,
    measurements,
    cellIds,
    dimensions,
    baselineScores,
    candidateScores,
    confidence,
    resamples,
    bootstrapSeed,
    deltaThreshold,
    minProductiveRuns,
  } = prev
  const significance = heldoutSignificance(
    { before: baselineScores, after: candidateScores, cellIds },
    {
      confidence,
      resamples,
      seed: bootstrapSeed,
      statistic: 'mean',
      deltaThreshold,
      minProductiveRuns,
    },
  )
  const overall = measuredEstimate(baselineScores, candidateScores, {
    confidence,
    resamples,
    seed: bootstrapSeed,
  })
  const objectives: AgentImprovementMeasuredComparison['objectives'] = [
    {
      kind: 'objective',
      name: 'benchmark-score',
      direction: 'higher-is-better',
      unit: 'score',
      availability: 'measured',
      ...overall,
    },
    ...dimensions.map((name, index) => ({
      kind: 'dimension' as const,
      objective: 'benchmark-score',
      name,
      direction: 'higher-is-better' as const,
      unit: 'score' as const,
      availability: 'measured' as const,
      ...measuredEstimate(
        measurements.map((measurement) => dimensionScore(measurement.baseline, name)),
        measurements.map((measurement) => dimensionScore(measurement.candidate, name)),
        {
          confidence,
          resamples,
          seed: bootstrapSeed + index + 1,
        },
      ),
    })),
  ]
  const cost = measuredEstimate(
    measurements.map((measurement) => measurement.baseline.costUsd),
    measurements.map((measurement) => measurement.candidate.costUsd),
    {
      confidence,
      resamples,
      seed: bootstrapSeed + dimensions.length + 1,
    },
  )
  const latency = measuredEstimate(
    measurements.map((measurement) => measurement.baseline.latencyMs),
    measurements.map((measurement) => measurement.candidate.latencyMs),
    {
      confidence,
      resamples,
      seed: bootstrapSeed + dimensions.length + 2,
    },
  )
  objectives.push(
    {
      kind: 'cost',
      name: 'cost',
      direction: 'lower-is-better',
      unit: 'usd',
      availability: 'measured',
      ...cost,
    },
    {
      kind: 'latency',
      name: 'latency',
      direction: 'lower-is-better',
      unit: 'milliseconds',
      availability: 'measured',
      ...latency,
    },
  )

  const power = observedPairedPrecision({
    baselineScores,
    candidateScores,
    delta: overall.delta,
    lowerBound: overall.confidenceInterval.lower,
    deltaThreshold,
    minProductiveRuns: significance.minimumRequired,
    confidence,
    sharedScorerChannel: options.sharedScorerChannel,
  })
  return { ...prev, significance, overall, objectives, cost, latency, power }
}

/** Critical dimensions that regressed, on either burden of proof. */
function dimensionRegressions<TRun>(prev: ReturnType<typeof pairedEstimates<TRun>>) {
  const {
    measurements,
    dimensions,
    confidence,
    resamples,
    bootstrapSeed,
    minProductiveRuns,
    criticalDimensions,
    regressionTolerance,
    objectives,
    power,
  } = prev
  const powerSufficient = power.sufficient
  const guardedDimensions = new Set(criticalDimensions)
  const missingCriticalDimensions = criticalDimensions.filter(
    (dimension) => !dimensions.includes(dimension),
  )
  // The dimension floor fires on EITHER burden of proof, because the interval
  // arm alone fails OPEN on exactly the shape a safety dimension lands in.
  // `regressionTolerance` is positive, so an interval pinned at [0, 0] — which
  // is what a pass/fail dimension gives whenever its pairs are concordant, and
  // what a percentile bootstrap of the mean gives whenever every delta is
  // identical — never satisfies `lower < -tolerance`, and a real regression is
  // reported as no regression. `decidePairedPromotion` on the reversed arms
  // adds the proven-drop path: a two-point dimension is judged on Tango's score
  // interval, which is valid at the nonzero margin the tolerance creates.
  const regressionProven = new Set(
    dimensions.filter((name) => {
      if (!guardedDimensions.has(name)) return false
      const baselineDim = measurements.map((m) => dimensionScore(m.baseline, name))
      const candidateDim = measurements.map((m) => dimensionScore(m.candidate, name))
      return decidePairedPromotion(candidateDim, baselineDim, {
        confidence,
        resamples,
        statistic: 'mean',
        seed: bootstrapSeed,
        threshold: regressionTolerance,
        minPairs: minProductiveRuns,
      }).promote
    }),
  )
  const regressions = objectives.filter(
    (objective) =>
      objective.kind === 'dimension' &&
      guardedDimensions.has(objective.name) &&
      objective.availability === 'measured' &&
      (objective.confidenceInterval.lower < -regressionTolerance ||
        regressionProven.has(objective.name)),
  )
  return {
    ...prev,
    powerSufficient,
    guardedDimensions,
    missingCriticalDimensions,
    regressionProven,
    regressions,
  }
}

/** Run completion, per-task regressions and the measurement cost. */
function runTotals<TRun>(prev: ReturnType<typeof dimensionRegressions<TRun>>) {
  const { options, measurements } = prev
  const measurementCostUsd = measurements.reduce(
    (sum, measurement) => sum + measurement.baseline.costUsd + measurement.candidate.costUsd,
    0,
  )
  const measurementWorkDurationMs = measurements.reduce(
    (sum, measurement) => sum + measurement.baseline.latencyMs + measurement.candidate.latencyMs,
    0,
  )
  const completedRuns = measurements.flatMap((measurement) => [
    measurement.baseline,
    measurement.candidate,
  ])
  const incompleteRuns = completedRuns.filter((run) => !run.completed)
  // FAILED is not REGRESSED, and the gate must ship on the second one.
  //
  // The blocking bar used to be `!candidate.passed` on any cell, i.e. the
  // candidate had to pass EVERY benchmark task. On a benchmark hard enough to
  // be worth running, nothing passes everything, so the bar was unreachable.
  //
  // The demonstration is the synthetic case `repairedNotRegressed(8)` in this
  // file's tests: baseline mean 0.3339, candidate mean 0.8685, paired delta
  // +0.5346 — held with "candidate failed 2 benchmark tasks", where both were
  // tasks the BASELINE failed too. An improvement reported as a defect.
  //
  // Stated precisely because an earlier draft of this comment was not: that case
  // is CONSTRUCTED, not observed. No live run of this gate is on disk, and no
  // arm of the work that found this defect ever called a model. The argument for
  // the change is the unreachable bar itself, which is visible in the predicate;
  // it does not rest on a measured candidate, and none should be claimed here.
  //
  // The consequence still holds and is the reason this matters: an improvement
  // null measured through the OLD gate cannot be read as evidence that
  // improvement does not work, because the gate could reject winners.
  //
  // The honest bar is improvement WITHOUT regression. The improvement half is
  // already carried by `paired-significance` (the lift must clear the threshold
  // with statistical evidence) and the quality half by `critical-dimensions`.
  // What was missing here is the per-task regression: a cell the baseline
  // PASSED and the candidate now fails. The baseline arm is already projected
  // through the same `adapter.passed`, so the comparison needs no new evidence —
  // it was available and simply not read.
  //
  // The three-way split is retained (not just the regression count) so a future
  // reader can tell a gate artifact from a real null: `repaired` is the work the
  // candidate did, `shared` is the work neither arm can do, and only `regressed`
  // blocks.
  const regressedTasks = measurements.filter(
    (measurement) => !measurement.candidate.passed && measurement.baseline.passed,
  )
  const sharedTaskFailures = measurements.filter(
    (measurement) => !measurement.candidate.passed && !measurement.baseline.passed,
  )
  const repairedTasks = measurements.filter(
    (measurement) => measurement.candidate.passed && !measurement.baseline.passed,
  )
  const derivedMeasurementCost: AgentImprovementCost = {
    usd: measurementCostUsd,
    provenance: measurements.every(
      (measurement) =>
        measurement.baseline.costProvenance === 'observed' &&
        measurement.candidate.costProvenance === 'observed',
    )
      ? 'observed'
      : 'estimated',
  }
  const measurementCost = options.measurementCost ?? derivedMeasurementCost
  return {
    ...prev,
    measurementCostUsd,
    measurementWorkDurationMs,
    completedRuns,
    incompleteRuns,
    regressedTasks,
    sharedTaskFailures,
    repairedTasks,
    derivedMeasurementCost,
    measurementCost,
  }
}

/** Total cost against the budget, and the checks the verdict is drawn from. */
function budgetAndChecks<TRun>(prev: ReturnType<typeof runTotals<TRun>>) {
  const {
    options,
    preparationCost,
    budgetUsd,
    significance,
    powerSufficient,
    missingCriticalDimensions,
    regressions,
    incompleteRuns,
    regressedTasks,
    derivedMeasurementCost,
    measurementCost,
  } = prev
  if (
    options.measurementCost !== undefined &&
    (measurementCost.provenance !== derivedMeasurementCost.provenance ||
      !numbersApproximatelyEqual(measurementCost.usd, derivedMeasurementCost.usd))
  ) {
    throw new Error('paired measurement cost does not match its signed receipts')
  }
  const totalCost: AgentImprovementCost = {
    usd: preparationCost.usd + measurementCost.usd,
    provenance:
      preparationCost.provenance === 'observed' && measurementCost.provenance === 'observed'
        ? 'observed'
        : 'estimated',
  }
  const budgetPassed =
    budgetUsd === undefined ||
    totalCost.usd < budgetUsd ||
    numbersApproximatelyEqual(totalCost.usd, budgetUsd)
  const checks = [
    { name: 'paired-significance', passed: significance.significant },
    { name: 'paired-precision', passed: powerSufficient },
    { name: 'all-runs-completed', passed: incompleteRuns.length === 0 },
    // Renamed from `candidate-task-pass` with the semantics. A consumer keyed on
    // the old name now sees a MISSING check rather than a silently different
    // one, which is the failure mode worth having.
    { name: 'no-task-regression', passed: regressedTasks.length === 0 },
    {
      name: 'critical-dimensions',
      passed: regressions.length === 0 && missingCriticalDimensions.length === 0,
    },
    { name: 'budget', passed: budgetPassed },
  ]
  const shipped = checks.every((check) => check.passed)
  const hardFailure =
    incompleteRuns.length > 0 ||
    regressedTasks.length > 0 ||
    regressions.length > 0 ||
    missingCriticalDimensions.length > 0 ||
    !budgetPassed
  return { ...prev, totalCost, budgetPassed, checks, shipped, hardFailure }
}

/** The verdict, its reasons and the evaluation record. */
function pairedVerdict<TRun>(
  prev: ReturnType<typeof budgetAndChecks<TRun>>,
): PairedMeasurementEvaluation {
  const {
    options,
    baselineScores,
    confidence,
    deltaThreshold,
    budgetUsd,
    significance,
    overall,
    objectives,
    power,
    powerSufficient,
    missingCriticalDimensions,
    regressions,
    measurementWorkDurationMs,
    incompleteRuns,
    regressedTasks,
    sharedTaskFailures,
    repairedTasks,
    measurementCost,
    totalCost,
    budgetPassed,
    checks,
    shipped,
    hardFailure,
  } = prev
  const reasons = [
    ...(significance.significant ? [] : [significanceReason(significance, deltaThreshold)]),
    ...(powerSufficient || significance.fewRuns ? [] : [power.reason]),
    ...(regressions.length === 0
      ? []
      : [`critical dimensions regressed: ${regressions.map((entry) => entry.name).join(', ')}`]),
    ...(missingCriticalDimensions.length === 0
      ? []
      : [`critical dimensions missing: ${missingCriticalDimensions.join(', ')}`]),
    ...(incompleteRuns.length === 0
      ? []
      : [`${incompleteRuns.length} benchmark executions did not exit successfully`]),
    ...(regressedTasks.length === 0
      ? []
      : [
          `candidate regressed ${regressedTasks.length} benchmark ` +
            `${regressedTasks.length === 1 ? 'task' : 'tasks'} the baseline passed: ` +
            regressedTasks.map((measurement) => measurement.cellId).join(', '),
        ]),
    ...(budgetPassed ? [] : [`total cost ${totalCost.usd} exceeded budget ${budgetUsd}`]),
    // Non-blocking accounting, emitted on any outcome that did NOT ship and has
    // tasks both arms failed — so a `hold` (whatever caused it) and also a
    // `need_more_work`. It lets an operator reading a refusal tell "the
    // candidate is bad" from "the benchmark has tasks neither arm solves". The
    // `shipped` term is what keeps it off a ship, where it could be misread as a
    // blocking reason.
    ...(shipped || sharedTaskFailures.length === 0
      ? []
      : [
          `benchmark tasks: ${repairedTasks.length} repaired, ${regressedTasks.length} regressed, ` +
            `${sharedTaskFailures.length} still failing that the baseline also failed`,
        ]),
  ]

  return {
    overall: {
      name: 'composite',
      direction: 'higher-is-better',
      unit: 'score',
      ...overall,
    },
    objectives,
    decision: {
      outcome: shipped
        ? 'ship'
        : hardFailure
          ? 'hold'
          : // A degenerate paired sample is a MEASUREMENT that cannot decide, not
            // a candidate that lost. `hold` sends the operator to build a better
            // candidate; `need_more_work` sends them to the held-out set, which is
            // the only thing that can actually resolve a zero-variance sample.
            significance.fewRuns || !powerSufficient || significance.decision.indeterminate
            ? 'need_more_work'
            : 'hold',
      reasons: reasons.length > 0 ? reasons : ['all measured checks passed'],
      contributingChecks: checks,
    },
    power: {
      sufficient: powerSufficient,
      n: baselineScores.length,
      minimumDetectableDelta: power.minimumDetectableDelta,
      confidenceLevel: confidence,
      scaleAssumed: power.scaleAssumed,
      sharedScorerChannel: options.sharedScorerChannel,
      reason: power.reason,
    },
    measurementCost,
    totalCost,
    measurementWorkDurationMs,
  }
}

/**
 * Say why the paired significance check refused, reading the interval that
 * ACTUALLY decided.
 *
 * The old string always printed `significance.bootstrap.low`, which is a
 * DIAGNOSTIC bootstrap that on several paths never enters the decision at all.
 * That produced self-contradicting holds — observed live: "paired interval lower
 * bound 0.6666666666666669 did not clear 0", where 0.667 plainly clears 0. Three
 * paths where the old string was simply reporting the wrong number:
 *
 *   - ZERO-VARIANCE sample. Every paired delta identical ⇒ the resample
 *     distribution is a point mass and the interval collapses to [g, g]. The
 *     refusal is correct and load-bearing, and the reason has to say so.
 *     Under the bounded asymmetric null this repo documents (2 % of pairs drop
 *     by 1.0, the rest gain 0.0204, true mean paired delta exactly 0), a
 *     constant-positive sample is exactly a sample in which no pair drew the
 *     drop, so its frequency is closed-form 0.98^n — 88.6 % at n = 6 and 66.8 %
 *     at n = 20. That reconciles with the false-promotion rates measured on the
 *     composable gate for the same null, 88.50 % at n = 6 and 65.65 % at n = 20
 *     (see {@link decidePairedPromotion} in `src/paired-promotion-decision.ts`);
 *     no number here is independently measured, and none needs to be. A
 *     constant positive delta is therefore NOT the strongest evidence — it is
 *     the signature of a held-out set too small or too uniform to have sampled
 *     the tail, and promoting on it would false-promote a true-zero candidate
 *     most of the time. No distribution-free bound rescues it either: a
 *     Hoeffding 95 % lower bound on a constant +0.667 with scores in [0, 1] is
 *     −0.33 at n = 6 and −0.11 at n = 10, first clearing 0 at n = 20. The
 *     estimator genuinely cannot express this sample, so the gate says that and
 *     routes to `need_more_work` — vary or extend the held-out cells.
 *   - TWO-POINT outcome, where the score interval decided and the bootstrap was
 *     never consulted.
 *   - McNEMAR VETO, where no interval failed at all.
 */
function significanceReason(
  significance: ReturnType<typeof heldoutSignificance>,
  deltaThreshold: number,
): string {
  if (significance.fewRuns) {
    return `only ${significance.n} paired runs; ${significance.minimumRequired} required`
  }
  const { decision } = significance
  if (decision.indeterminate) {
    return (
      `paired ${decision.statistic} interval is degenerate at [${decision.low}, ${decision.high}] ` +
      `(${decision.indeterminateCause}); a zero-width interval carries no information about its ` +
      `own error, so no threshold can be cleared on it — vary or extend the held-out cells`
    )
  }
  if (decision.exactTestVetoes && decision.mcnemar !== null) {
    return (
      `McNemar's exact test refuses at threshold ${deltaThreshold}: ` +
      `b=${decision.mcnemar.b}, c=${decision.mcnemar.c}, p=${decision.mcnemar.pValue}`
    )
  }
  return (
    `paired ${decision.statistic} interval lower bound ${decision.low} ` +
    `did not clear ${deltaThreshold}.${decision.methodDetail}`
  )
}

function measuredEstimate(
  baseline: number[],
  candidate: number[],
  options: { confidence: number; resamples: number; seed: number },
): Pick<
  AgentImprovementMeasuredComparison['overall'],
  'baseline' | 'candidate' | 'delta' | 'confidenceInterval' | 'n'
> {
  const bootstrap = pairedBootstrap(baseline, candidate, {
    confidence: options.confidence,
    resamples: options.resamples,
    statistic: 'mean',
    seed: options.seed,
  })
  const baselineMean = mean(baseline)
  const candidateMean = mean(candidate)
  const delta = candidateMean - baselineMean
  return {
    baseline: baselineMean,
    candidate: candidateMean,
    delta,
    confidenceInterval: {
      level: bootstrap.confidence,
      lower: Math.min(bootstrap.low, delta),
      upper: Math.max(bootstrap.high, delta),
      method: 'paired-bootstrap',
      statistic: 'mean',
      resamples: bootstrap.resamples,
    },
    n: bootstrap.n,
  }
}

function observedPairedPrecision(options: {
  baselineScores: number[]
  candidateScores: number[]
  delta: number
  lowerBound: number
  deltaThreshold: number
  minProductiveRuns: number
  confidence: number
  sharedScorerChannel: boolean
}): { sufficient: boolean; minimumDetectableDelta: number; scaleAssumed: boolean; reason: string } {
  const n = options.baselineScores.length
  const lowerMargin = Math.max(0, options.delta - options.lowerBound)
  const minimumDetectableDelta = options.deltaThreshold + lowerMargin
  const allScores = [...options.baselineScores, ...options.candidateScores]
  const scaleAssumed = allScores.every((score) => score >= -0.001 && score <= 1.001)
  const headroom = Math.max(0, 1 - mean(options.baselineScores))
  const enoughRuns = n >= options.minProductiveRuns
  const attainable = !scaleAssumed || minimumDetectableDelta <= headroom
  const sufficient = enoughRuns && attainable
  const scorerNote = options.sharedScorerChannel
    ? ' The same scorer evaluated both arms, so scorer bias is not measured.'
    : ''

  if (!enoughRuns) {
    return {
      sufficient,
      minimumDetectableDelta,
      scaleAssumed,
      reason: `only ${n} paired runs; ${options.minProductiveRuns} required.${scorerNote}`,
    }
  }
  if (!attainable) {
    return {
      sufficient,
      minimumDetectableDelta,
      scaleAssumed,
      reason:
        `observed paired uncertainty gives a minimum detectable delta of ` +
        `${minimumDetectableDelta.toFixed(3)}, above the remaining score headroom ` +
        `${headroom.toFixed(3)}.${scorerNote}`,
    }
  }
  return {
    sufficient,
    minimumDetectableDelta,
    scaleAssumed,
    reason:
      `observed paired uncertainty gives a minimum detectable delta of ` +
      `${minimumDetectableDelta.toFixed(3)} at ${options.confidence.toFixed(2)} confidence ` +
      `from ${n} runs.${scorerNote}`,
  }
}

function mean(values: number[]): number {
  if (values.length === 0) throw new Error('candidate experiment requires measured values')
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
