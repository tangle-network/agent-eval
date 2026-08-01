import {
  type AgentCandidateBenchmarkCellRef,
  type AgentCandidateBenchmarkSuiteInputs,
  type AgentCandidateBenchmarkTask,
  type AgentCandidateBenchmarkTaskMaterial,
  type AgentCandidateBundle,
  type AgentCandidateEvaluationPolicy,
  type AgentCandidateExperiment,
  type AgentCandidateExperimentMaterial,
  type AgentCandidateExperimentMeasurement,
  type AgentCandidateFixedSpend,
  type AgentImprovementCost,
  type AgentImprovementMeasuredComparison,
  agentCandidateBenchmarkSuiteSchema,
  agentCandidateBenchmarkTaskSchema,
  agentCandidateBundleSchema,
  agentCandidateEvaluationPolicySchema,
  agentCandidateExperimentSchema,
  agentImprovementMeasuredComparisonSchema,
  type CandidateExecutionEvidence,
  candidateExecutionEvidenceSchema,
  canonicalCandidateDigest,
  numbersApproximatelyEqual,
  omitTopLevelDigest,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import { heldoutSignificance } from '../campaign/gates/statistical-heldout'
import type { CostLedgerHandle, CostReceiptInput } from '../cost-ledger'
import { decidePairedPromotion } from '../paired-promotion-decision'
import { pairedBootstrap } from '../statistics'
import { addFixedSpend } from './fixed-spend'
import { runPaidPairedMeasurement } from './paid-paired-measurement'

export interface SealCandidateBenchmarkSuiteOptions {
  tasks: [AgentCandidateBenchmarkTask, ...AgentCandidateBenchmarkTask[]]
  reps: number
  seeds: [number, ...number[]]
}

export interface CandidateExperimentExecutionInput {
  experiment: AgentCandidateExperiment
  arm: 'baseline' | 'candidate'
  bundle: AgentCandidateBundle
  task: AgentCandidateBenchmarkTask
  benchmarkCell: AgentCandidateBenchmarkCellRef
  seed: number
  signal?: AbortSignal
}

export interface RunCandidateExperimentOptions {
  experiment: AgentCandidateExperiment
  execute(input: CandidateExperimentExecutionInput): Promise<CandidateExecutionEvidence>
  /** Maximum number of simultaneous execute calls across both arms. */
  maxConcurrency?: number
  /** Shared run budget that also accounts for analysis and candidate search. */
  costLedger?: CostLedgerHandle
  signal?: AbortSignal
}

export interface CandidateExperimentRun {
  measurements: AgentCandidateExperimentMeasurement[]
  measurement: {
    wallDurationMs: number
    cost: AgentImprovementCost
  }
}

export interface CompareCandidateExperimentOptions {
  experiment: AgentCandidateExperiment
  measurements: AgentCandidateExperimentMeasurement[]
  preparation: {
    wallDurationMs: number
    cost: AgentImprovementCost
  }
  measurement: CandidateExperimentRun['measurement']
  runId: string
  candidate?: AgentImprovementMeasuredComparison['candidate']
  generationsExplored?: number
  metadata?: AgentImprovementMeasuredComparison['metadata']
}

/** One exact baseline/candidate observation of the same held-out cell. */
export interface PairedMeasurement<TRun> {
  cellId: string
  baseline: TRun
  candidate: TRun
}

/** Maps a product-owned run receipt into the measurements required for a fair paired decision. */
export interface PairedMeasurementAdapter<TRun> {
  score(run: TRun): number
  dimensions(run: TRun): readonly { name: string; score: number }[]
  costUsd(run: TRun): number
  costProvenance(run: TRun): AgentImprovementCost['provenance']
  latencyMs(run: TRun): number
  completed(run: TRun): boolean
  passed(run: TRun): boolean
}

export interface EvaluatePairedMeasurementsOptions<TRun> {
  measurements: readonly PairedMeasurement<TRun>[]
  policy: AgentCandidateEvaluationPolicy
  adapter: PairedMeasurementAdapter<TRun>
  /** Whether both arms use the same scorer family as the promotion decision. */
  sharedScorerChannel: boolean
  /** Analysis and candidate-search spend that belongs to the same frozen budget. */
  preparationCost?: AgentImprovementCost
  /** Settled aggregate receipt for this exact paired suite, when an executor provides one. */
  measurementCost?: AgentImprovementCost
}

/** Statistical and operational result derived from complete paired receipts. */
export type PairedMeasurementEvaluation = Pick<
  AgentImprovementMeasuredComparison,
  'overall' | 'objectives' | 'decision' | 'power'
> & {
  measurementCost: AgentImprovementCost
  totalCost: AgentImprovementCost
  measurementWorkDurationMs: number
}

/** Content-address one task before any measured execution can see it. */
export function sealCandidateBenchmarkTask(
  material: AgentCandidateBenchmarkTaskMaterial,
): AgentCandidateBenchmarkTask {
  return agentCandidateBenchmarkTaskSchema.parse({
    ...material,
    digest: canonicalCandidateDigest(material),
  })
}

/** Freeze task order, repetitions, and every seed before either arm runs. */
export function sealCandidateBenchmarkSuite(
  options: SealCandidateBenchmarkSuiteOptions,
): AgentCandidateBenchmarkSuiteInputs {
  for (const task of options.tasks) verifyCandidateBenchmarkTask(task)
  const material = {
    kind: 'agent-candidate-benchmark-suite' as const,
    digestAlgorithm: 'rfc8785-sha256' as const,
    taskDigests: options.tasks.map((task) => task.digest) as [Sha256Digest, ...Sha256Digest[]],
    reps: options.reps,
    seeds: options.seeds,
  }
  const suite = agentCandidateBenchmarkSuiteSchema.parse({
    ...material,
    digest: canonicalCandidateDigest(material),
  })
  return { suite, tasks: options.tasks }
}

/** Freeze both complete agent states and their exact held-out work. */
export function sealCandidateExperiment(
  material: AgentCandidateExperimentMaterial,
): AgentCandidateExperiment {
  const parsed = agentCandidateExperimentSchema.parse({
    ...material,
    digest: canonicalCandidateDigest(material),
  })
  return verifyCandidateExperiment(parsed)
}

export function verifyCandidateExperiment(input: unknown): AgentCandidateExperiment {
  const experiment = agentCandidateExperimentSchema.parse(input)
  verifySelfAddressed(experiment, 'candidate experiment')
  verifyBundle(experiment.baseline, 'baseline bundle')
  verifyBundle(experiment.candidate, 'candidate bundle')
  if (experiment.baseline.digest === experiment.candidate.digest) {
    throw new Error('candidate experiment baseline and candidate bundles are identical')
  }
  verifyCandidateBenchmarkSuiteInputs(experiment.benchmark)
  return experiment
}

/** Execute each signed cell for both arms. The callback is Runtime's one executor. */
export async function runCandidateExperiment(
  options: RunCandidateExperimentOptions,
): Promise<CandidateExperimentRun> {
  const experiment = verifyCandidateExperiment(options.experiment)
  const { suite, tasks } = experiment.benchmark
  const run = await runPaidPairedMeasurement({
    count: suite.taskDigests.length * suite.reps,
    maxConcurrency: options.maxConcurrency ?? 2,
    label: 'candidate experiment',
    budgetUsd: experiment.policy.budgetUsd,
    ...(options.costLedger ? { costLedger: options.costLedger } : {}),
    maximumCostUsd: candidateMeasurementMaximumCostUsd(experiment),
    call: {
      callId: `candidate-measurement:${experiment.digest}`,
      channel: 'measurement',
      phase: 'heldout',
      actor: experiment.digest,
      model: candidateMeasurementModel(experiment),
      tags: { experimentDigest: experiment.digest },
    },
    ...(options.signal ? { signal: options.signal } : {}),
    async execute(index, arm, signal) {
      const taskIndex = Math.floor(index / suite.reps)
      const repetition = index % suite.reps
      const task = tasks[taskIndex]
      const seed = suite.seeds[index]
      if (!task || seed === undefined) {
        throw new Error(`candidate experiment cell ${index} has no signed task or seed`)
      }
      const benchmarkCell = {
        suiteDigest: suite.digest,
        taskIndex,
        repetition,
      }
      return verifyExecutionEvidence(
        await options.execute({
          experiment,
          arm,
          bundle: experiment[arm],
          task,
          benchmarkCell,
          seed,
          signal,
        }),
      )
    },
    receipt(measurements) {
      return candidateMeasurementCostReceipt(measurements, candidateMeasurementModel(experiment))
    },
  })
  return {
    measurements: run.measurements.map((measurement, index) =>
      verifyMeasurement(experiment, measurement, index),
    ),
    measurement: {
      wallDurationMs: run.wallDurationMs,
      cost: { usd: run.cost.usd, provenance: run.cost.kind },
    },
  }
}

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
  assertKnownCost(measurementCost, 'paired measurement cost')
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
          `candidate regressed ${regressedTasks.length} benchmark tasks the baseline passed: ` +
            regressedTasks.map((measurement) => measurement.cellId).join(', '),
        ]),
    ...(budgetPassed ? [] : [`total cost ${totalCost.usd} exceeded budget ${budgetUsd}`]),
    // Non-blocking accounting, emitted only when the gate already holds, so an
    // operator reading a hold can tell "the candidate is bad" from "the
    // benchmark has tasks neither arm solves". It never appears on a ship, so it
    // cannot be misread as a blocking reason.
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
 *     Re-measured here rather than taken on trust: under the bounded asymmetric
 *     null this module documents (2 % of pairs drop by 1.0, the rest gain
 *     0.0204, true mean paired delta exactly 0), a constant-positive sample is
 *     what 87.4 % of n = 6 samples and 64.7 % of n = 20 samples look like. A
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

/** Build the only publishable comparison: paired statistics over Runtime receipts. */
export function measuredComparisonFromCandidateExperiment(
  options: CompareCandidateExperimentOptions,
): AgentImprovementMeasuredComparison {
  const experiment = verifyCandidateExperiment(options.experiment)
  const measurements = options.measurements.map((measurement, index) =>
    verifyMeasurement(experiment, measurement, index),
  )
  const expectedN = experiment.benchmark.suite.taskDigests.length * experiment.benchmark.suite.reps
  if (measurements.length !== expectedN) {
    throw new Error(
      `candidate experiment is incomplete (${measurements.length}/${expectedN} paired cells)`,
    )
  }
  verifyStableProfileMaterialization(measurements)
  if (!options.runId.trim()) throw new Error('candidate experiment runId is required')
  assertPhaseAccounting(options.preparation, 'candidate preparation')
  assertPhaseAccounting(options.measurement, 'candidate measurement')
  const evaluation = evaluatePairedMeasurements({
    measurements: measurements.map((measurement, index) => ({
      cellId: cellIds(experiment)[index]!,
      ...measurement,
    })),
    policy: experiment.policy,
    adapter: candidateExecutionEvidenceAdapter,
    sharedScorerChannel: true,
    preparationCost: options.preparation.cost,
    measurementCost: options.measurement.cost,
  })
  const diff = deriveCandidateBundleDiff(experiment)
  const provisional = agentImprovementMeasuredComparisonSchema.parse({
    kind: 'agent-improvement-measured-comparison',
    experiment,
    measurements,
    overall: evaluation.overall,
    objectives: evaluation.objectives,
    ...(options.candidate ? { candidate: options.candidate } : {}),
    decision: evaluation.decision,
    power: evaluation.power,
    provenance: {
      kind: 'agent-eval-loop',
      schema: 'agent-candidate-experiment',
      runId: options.runId,
      recordDigest: canonicalCandidateDigest({}),
      baselineContentHash: experiment.baseline.digest,
      candidateContentHash: experiment.candidate.digest,
    },
    diff,
    evaluation: {
      generationsExplored: options.generationsExplored ?? 0,
      preparation: options.preparation,
      measurement: {
        wallDurationMs: options.measurement.wallDurationMs,
        workDurationMs: evaluation.measurementWorkDurationMs,
        cost: evaluation.measurementCost,
      },
      total: {
        wallDurationMs: options.preparation.wallDurationMs + options.measurement.wallDurationMs,
        cost: evaluation.totalCost,
      },
    },
    ...(options.metadata ? { metadata: options.metadata } : {}),
  })
  const { recordDigest: _recordDigest, ...provenance } = provisional.provenance
  return agentImprovementMeasuredComparisonSchema.parse({
    ...provisional,
    provenance: {
      ...provenance,
      recordDigest: canonicalCandidateDigest({ ...provisional, provenance }),
    },
  })
}

/** Recompute every statistic and decision from the signed experiment receipts. */
export function verifyCandidateExperimentComparison(
  input: unknown,
): AgentImprovementMeasuredComparison {
  const comparison = agentImprovementMeasuredComparisonSchema.parse(input)
  const recomputed = measuredComparisonFromCandidateExperiment({
    experiment: comparison.experiment,
    measurements: comparison.measurements,
    runId: comparison.provenance.runId,
    ...(comparison.candidate ? { candidate: comparison.candidate } : {}),
    generationsExplored: comparison.evaluation.generationsExplored,
    preparation: comparison.evaluation.preparation,
    measurement: {
      wallDurationMs: comparison.evaluation.measurement.wallDurationMs,
      cost: comparison.evaluation.measurement.cost,
    },
    ...(comparison.metadata ? { metadata: comparison.metadata } : {}),
  })
  if (canonicalCandidateDigest(recomputed) !== canonicalCandidateDigest(comparison)) {
    throw new Error('candidate experiment comparison does not match its Runtime receipts')
  }
  return comparison
}

function candidateMeasurementMaximumCostUsd(experiment: AgentCandidateExperiment): number {
  const maximum = experiment.benchmark.tasks.reduce(
    (sum, task) => sum + task.limits.maxCostUsd * experiment.benchmark.suite.reps * 2,
    0,
  )
  if (!Number.isFinite(maximum) || maximum < 0) {
    throw new Error('candidate measurement maximum cost is invalid')
  }
  return maximum
}

function candidateMeasurementModel(experiment: AgentCandidateExperiment): string {
  const models = [...new Set(experiment.benchmark.tasks.map((task) => task.model.model))]
  return models.length === 1 ? models[0]! : 'multiple-models'
}

function candidateMeasurementCostReceipt(
  measurements: Array<{
    baseline: CandidateExecutionEvidence
    candidate: CandidateExecutionEvidence
  }>,
  model: string,
): CostReceiptInput {
  const usage = measurements.reduce<AgentCandidateFixedSpend>(
    (sum, measurement) =>
      addFixedSpend(
        addFixedSpend(sum, combinedUsage(measurement.baseline)),
        combinedUsage(measurement.candidate),
      ),
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      modelCalls: 0,
      costUsdNanos: 0,
      costProvenance: 'observed',
    },
  )
  const costUsd = usage.costUsdNanos / 1_000_000_000
  return {
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedInputTokens,
    reasoningTokens: usage.reasoningTokens,
    ...(usage.costProvenance === 'observed'
      ? { actualCostUsd: costUsd }
      : { estimatedCostUsd: costUsd }),
  }
}

function assertPhaseAccounting(
  accounting: CompareCandidateExperimentOptions['preparation'],
  label: string,
): void {
  if (!Number.isFinite(accounting.wallDurationMs) || accounting.wallDurationMs < 0) {
    throw new Error(`${label} wall duration must be a non-negative number`)
  }
  assertKnownCost(accounting.cost, `${label} cost`)
}

function assertKnownCost(cost: AgentImprovementCost, label: string): void {
  if (!Number.isFinite(cost.usd) || cost.usd < 0) {
    throw new Error(`${label} must be a non-negative number`)
  }
  if (cost.provenance !== 'observed' && cost.provenance !== 'estimated') {
    throw new Error(`${label} provenance must be observed or estimated`)
  }
}

function deriveCandidateBundleDiff(experiment: AgentCandidateExperiment): string {
  const surfaces = ['profile', 'code', 'execution', 'knowledge', 'memory'] as const
  const changed = surfaces.flatMap((surface) => {
    const baseline = experiment.baseline[surface] ?? null
    const candidate = experiment.candidate[surface] ?? null
    const baselineDigest = canonicalCandidateDigest(baseline)
    const candidateDigest = canonicalCandidateDigest(candidate)
    if (baselineDigest === candidateDigest) return []
    return [
      [
        `--- baseline/${surface} (${baselineDigest})`,
        `+++ candidate/${surface} (${candidateDigest})`,
        JSON.stringify({ baseline, candidate }, null, 2),
      ].join('\n'),
    ]
  })
  if (changed.length === 0) {
    throw new Error('candidate experiment has no changed candidate surface')
  }
  return changed.join('\n\n')
}

export function verifyCandidateBenchmarkTask(input: unknown): AgentCandidateBenchmarkTask {
  const task = agentCandidateBenchmarkTaskSchema.parse(input)
  verifySelfAddressed(task, 'candidate benchmark task')
  return task
}

export function verifyCandidateBenchmarkSuiteInputs(
  input: unknown,
): AgentCandidateBenchmarkSuiteInputs {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('candidate benchmark suite inputs must be an object')
  }
  const candidate = input as AgentCandidateBenchmarkSuiteInputs
  const suite = verifyCandidateBenchmarkSuite(candidate.suite)
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length !== suite.taskDigests.length) {
    throw new Error('candidate benchmark suite task count does not match its signed digests')
  }
  candidate.tasks.forEach((task, index) => {
    const verified = verifyCandidateBenchmarkTask(task)
    if (verified.digest !== suite.taskDigests[index]) {
      throw new Error(`candidate benchmark task ${index} does not match the signed suite`)
    }
  })
  return { suite, tasks: candidate.tasks }
}

export function verifyCandidateBenchmarkSuite(input: unknown) {
  const suite = agentCandidateBenchmarkSuiteSchema.parse(input)
  verifySelfAddressed(suite, 'candidate benchmark suite')
  return suite
}

function verifyBundle(input: unknown, label: string): AgentCandidateBundle {
  const bundle = agentCandidateBundleSchema.parse(input)
  verifySelfAddressed(bundle, label)
  return bundle
}

function verifyMeasurement(
  experiment: AgentCandidateExperiment,
  input: AgentCandidateExperimentMeasurement,
  index: number,
): AgentCandidateExperimentMeasurement {
  const suite = experiment.benchmark.suite
  const taskIndex = Math.floor(index / suite.reps)
  const repetition = index % suite.reps
  const task = experiment.benchmark.tasks[taskIndex]
  const seed = suite.seeds[index]
  if (!task || seed === undefined) {
    throw new Error(`candidate experiment measurement ${index} is outside the signed suite`)
  }
  const baseline = verifyExecutionEvidence(input.baseline)
  const candidate = verifyExecutionEvidence(input.candidate)
  for (const [arm, evidence] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ] as const) {
    const bundle = experiment[arm]
    const materialization = evidence.materializationReceipt
    const plan = materialization.executionPlan.material
    const runCell = plan.runCell
    verifySelfAddressed(runCell, 'candidate run cell')
    if (
      runCell.experimentDigest !== experiment.digest ||
      runCell.arm !== arm ||
      runCell.bundleDigest !== bundle.digest ||
      runCell.suiteDigest !== suite.digest ||
      runCell.taskDigest !== task.digest ||
      runCell.taskIndex !== taskIndex ||
      runCell.repetition !== repetition ||
      runCell.seed !== seed ||
      runCell.attempt > task.attempt.maxAttempts ||
      materialization.bundleDigest !== bundle.digest ||
      materialization.benchmark.suite.digest !== suite.digest ||
      materialization.benchmark.task.digest !== task.digest ||
      materialization.codeKind !== bundle.code.kind ||
      materialization.profileActivation.profilePlan.material.sourceProfileDigest !==
        canonicalCandidateDigest(bundle.profile) ||
      evidence.receipt.runCellDigest !== runCell.digest ||
      JSON.stringify(materialization.resolvedModel) !== JSON.stringify(task.model)
    ) {
      throw new Error(`candidate experiment measurement ${index} substituted its ${arm} arm`)
    }
    verifyTaskOutcome(task, evidence, index, arm)
  }
  const baselinePlan = baseline.materializationReceipt.executionPlan.material
  const candidatePlan = candidate.materializationReceipt.executionPlan.material
  if (
    baselinePlan.executionId === candidatePlan.executionId ||
    baselinePlan.runCell.digest === candidatePlan.runCell.digest ||
    baseline.materializationReceipt.digest === candidate.materializationReceipt.digest ||
    baseline.receipt.digest === candidate.receipt.digest ||
    baseline.digest === candidate.digest
  ) {
    throw new Error(`candidate experiment measurement ${index} reused one execution across arms`)
  }
  return { baseline, candidate }
}

function verifyExecutionEvidence(input: unknown): CandidateExecutionEvidence {
  const evidence = candidateExecutionEvidenceSchema.parse(input)
  verifySelfAddressed(evidence, 'candidate execution evidence')
  verifySelfAddressed(evidence.materializationReceipt, 'candidate materialization receipt')
  verifySelfAddressed(
    evidence.materializationReceipt.profileActivation,
    'candidate profile activation',
  )
  verifyMaterialAddressed(
    evidence.materializationReceipt.profileActivation.profilePlan,
    'candidate profile plan',
  )
  verifyMaterialAddressed(evidence.materializationReceipt.executionPlan, 'candidate execution plan')
  verifySelfAddressed(evidence.receipt, 'candidate run receipt')
  verifyMaterialAddressed(evidence.receipt.modelSettlement, 'candidate model settlement')
  verifyMaterialAddressed(evidence.receipt.taskOutcome, 'candidate task outcome')
  verifyMaterialAddressed(evidence.receipt.benchmarkResult, 'candidate benchmark result')
  return evidence
}

function verifySelfAddressed<T extends { digest: Sha256Digest }>(document: T, label: string): void {
  if (canonicalCandidateDigest(omitTopLevelDigest(document)) !== document.digest) {
    throw new Error(`${label} digest is invalid`)
  }
}

function verifyTaskOutcome(
  task: AgentCandidateBenchmarkTask,
  evidence: CandidateExecutionEvidence,
  index: number,
  arm: 'baseline' | 'candidate',
): void {
  const outcome = evidence.receipt.taskOutcome.material.outcome
  const result = evidence.receipt.benchmarkResult.material
  const prefix = `candidate experiment measurement ${index} ${arm}`
  if (result.evidence.sha256 === task.grader.artifact.sha256) {
    throw new Error(`${prefix} reused grader bytes as grading evidence`)
  }
  const usage = combinedUsage(evidence)
  const usageChecks: Array<[number, number, string]> = [
    [usage.modelCalls, task.limits.maxModelCalls, 'model calls'],
    [usage.inputTokens, task.limits.maxInputTokens, 'input tokens'],
    [usage.outputTokens, task.limits.maxOutputTokens, 'output tokens'],
    [usage.costUsdNanos, Math.round(task.limits.maxCostUsd * 1_000_000_000), 'cost'],
  ]
  for (const [actual, maximum, label] of usageChecks) {
    if (actual > maximum) {
      throw new Error(`${prefix} ${label} ${actual} exceeds the signed limit ${maximum}`)
    }
  }
  if (outcome.kind !== task.outcome.kind) {
    throw new Error(`${prefix} returned an outcome outside the signed task contract`)
  }
  if (task.outcome.kind === 'output') {
    if (
      outcome.kind !== 'output' ||
      outcome.spec.mediaType !== task.outcome.mediaType ||
      outcome.spec.maxBytes !== task.outcome.maxBytes
    ) {
      throw new Error(`${prefix} changed the signed output contract`)
    }
    return
  }
  const repository = task.repository
  if (
    outcome.kind !== 'workspace' ||
    repository === undefined ||
    outcome.baseRepository.identity !== repository.identity ||
    outcome.baseRepository.rootIdentity !== repository.rootIdentity ||
    outcome.baseRepository.commit !== repository.baseCommit ||
    outcome.baseRepository.tree !== repository.baseTree
  ) {
    throw new Error(`${prefix} did not start from the signed repository state`)
  }
}

function verifyStableProfileMaterialization(
  measurements: AgentCandidateExperimentMeasurement[],
): void {
  for (const arm of ['baseline', 'candidate'] as const) {
    const expected = measurements[0]?.[arm].materializationReceipt.profileActivation
    if (!expected) throw new Error('candidate experiment contains no profile materialization')
    const expectedDigest = canonicalCandidateDigest({
      profilePlanDigest: expected.profilePlan.digest,
      files: expected.files,
    })
    for (const [index, measurement] of measurements.entries()) {
      const activation = measurement[arm].materializationReceipt.profileActivation
      if (
        canonicalCandidateDigest({
          profilePlanDigest: activation.profilePlan.digest,
          files: activation.files,
        }) !== expectedDigest
      ) {
        throw new Error(
          `candidate experiment measurement ${index} ${arm} materialized a different profile`,
        )
      }
    }
  }
}

function completedSuccessfully(evidence: CandidateExecutionEvidence): boolean {
  const termination = evidence.receipt.termination
  return termination.kind === 'exit' && termination.exitCode === 0
}

function verifyMaterialAddressed(
  evidence: { digest: Sha256Digest; material: unknown },
  label: string,
): void {
  if (canonicalCandidateDigest(evidence.material) !== evidence.digest) {
    throw new Error(`${label} digest is invalid`)
  }
}

interface ProjectedRun {
  score: number
  dimensions: Map<string, number>
  costUsd: number
  costProvenance: AgentImprovementCost['provenance']
  latencyMs: number
  completed: boolean
  passed: boolean
}

interface ProjectedPairedMeasurement {
  cellId: string
  baseline: ProjectedRun
  candidate: ProjectedRun
}

function projectPairedMeasurement<TRun>(
  measurement: PairedMeasurement<TRun>,
  index: number,
  adapter: PairedMeasurementAdapter<TRun>,
): ProjectedPairedMeasurement {
  if (typeof measurement.cellId !== 'string' || !measurement.cellId.trim()) {
    throw new Error(`paired measurement ${index} requires a cell id`)
  }
  return {
    cellId: measurement.cellId,
    baseline: projectRun(measurement.baseline, adapter, `paired measurement ${index} baseline`),
    candidate: projectRun(measurement.candidate, adapter, `paired measurement ${index} candidate`),
  }
}

function projectRun<TRun>(
  run: TRun,
  adapter: PairedMeasurementAdapter<TRun>,
  label: string,
): ProjectedRun {
  const suppliedDimensions = adapter.dimensions(run)
  if (!Array.isArray(suppliedDimensions)) {
    throw new Error(`${label} dimensions must be an array`)
  }
  const dimensions = new Map<string, number>()
  for (const dimension of suppliedDimensions) {
    if (typeof dimension.name !== 'string' || !dimension.name.trim()) {
      throw new Error(`${label} contains an unnamed dimension`)
    }
    if (dimensions.has(dimension.name)) {
      throw new Error(`${label} repeats dimension '${dimension.name}'`)
    }
    dimensions.set(dimension.name, finiteMeasurement(dimension.score, `${label} ${dimension.name}`))
  }
  const completed = adapter.completed(run)
  const passed = adapter.passed(run)
  if (typeof completed !== 'boolean' || typeof passed !== 'boolean') {
    throw new Error(`${label} completion and pass values must be booleans`)
  }
  const costProvenance = adapter.costProvenance(run)
  if (costProvenance !== 'observed' && costProvenance !== 'estimated') {
    throw new Error(`${label} cost provenance must be observed or estimated`)
  }
  return {
    score: finiteMeasurement(adapter.score(run), `${label} score`),
    dimensions,
    costUsd: nonNegativeMeasurement(adapter.costUsd(run), `${label} cost`),
    costProvenance,
    latencyMs: nonNegativeMeasurement(adapter.latencyMs(run), `${label} latency`),
    completed,
    passed,
  }
}

function sharedProjectedDimensions(measurements: readonly ProjectedPairedMeasurement[]): string[] {
  const expected = [...measurements[0]!.baseline.dimensions.keys()]
  for (const [index, measurement] of measurements.entries()) {
    for (const [arm, run] of [
      ['baseline', measurement.baseline],
      ['candidate', measurement.candidate],
    ] as const) {
      const actual = [...run.dimensions.keys()]
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`paired measurement ${index} ${arm} dimensions do not match the suite`)
      }
    }
  }
  return expected
}

function dimensionScore(run: ProjectedRun, name: string): number {
  const value = run.dimensions.get(name)
  if (value === undefined) throw new Error(`paired measurement is missing dimension '${name}'`)
  return value
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

function finiteMeasurement(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function nonNegativeMeasurement(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`)
  return value
}

const candidateExecutionEvidenceAdapter: PairedMeasurementAdapter<CandidateExecutionEvidence> = {
  score: (evidence) => evidence.receipt.benchmarkResult.material.score,
  dimensions: (evidence) => evidence.receipt.benchmarkResult.material.dimensions,
  costUsd: costFromEvidence,
  costProvenance: (evidence) => combinedUsage(evidence).costProvenance,
  latencyMs: latencyFromEvidence,
  completed: completedSuccessfully,
  passed: (evidence) => evidence.receipt.benchmarkResult.material.passed,
}

function costFromEvidence(evidence: CandidateExecutionEvidence): number {
  return combinedUsage(evidence).costUsdNanos / 1_000_000_000
}

function latencyFromEvidence(evidence: CandidateExecutionEvidence): number {
  return (
    evidence.receipt.timing.durationMs +
    evidence.receipt.benchmarkResult.material.grading.timing.durationMs
  )
}

function combinedUsage(evidence: CandidateExecutionEvidence): AgentCandidateFixedSpend {
  const candidate = evidence.receipt.modelSettlement.material.usage
  const grader = evidence.receipt.benchmarkResult.material.grading.usage
  return addFixedSpend(candidate, grader)
}

function cellIds(experiment: AgentCandidateExperiment): string[] {
  const { suite, tasks } = experiment.benchmark
  return suite.seeds.map((_, index) => {
    const taskIndex = Math.floor(index / suite.reps)
    const repetition = index % suite.reps
    return `${tasks[taskIndex]?.scenario.id ?? taskIndex}:${repetition}`
  })
}

function mean(values: number[]): number {
  if (values.length === 0) throw new Error('candidate experiment requires measured values')
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
