import {
  type AgentCandidateBenchmarkCellRef,
  type AgentCandidateBenchmarkSuiteInputs,
  type AgentCandidateBenchmarkTask,
  type AgentCandidateBenchmarkTaskMaterial,
  type AgentCandidateBundle,
  type AgentCandidateExperiment,
  type AgentCandidateExperimentMaterial,
  type AgentCandidateExperimentMeasurement,
  type AgentImprovementMeasuredComparison,
  agentCandidateBenchmarkSuiteSchema,
  agentCandidateBenchmarkTaskSchema,
  agentCandidateBundleSchema,
  agentCandidateExperimentSchema,
  agentImprovementMeasuredComparisonSchema,
  type CandidateExecutionEvidence,
  candidateExecutionEvidenceSchema,
  canonicalCandidateDigest,
  omitTopLevelDigest,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import { powerPreflight } from '../campaign/gates/power-preflight'
import { heldoutSignificance } from '../campaign/gates/statistical-heldout'
import { pairedBootstrap } from '../statistics'

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
  maxConcurrency?: number
  signal?: AbortSignal
}

export interface CompareCandidateExperimentOptions {
  experiment: AgentCandidateExperiment
  measurements: AgentCandidateExperimentMeasurement[]
  runId: string
  diff: string
  candidate?: AgentImprovementMeasuredComparison['candidate']
  generationsExplored?: number
  searchDurationMs?: number
  searchCostUsd?: number
  metadata?: AgentImprovementMeasuredComparison['metadata']
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
  verifyCandidateBenchmarkSuiteInputs(experiment.benchmark)
  return experiment
}

/** Execute each signed cell for both arms. The callback is Runtime's one executor. */
export async function runCandidateExperiment(
  options: RunCandidateExperimentOptions,
): Promise<AgentCandidateExperimentMeasurement[]> {
  const experiment = verifyCandidateExperiment(options.experiment)
  const { suite, tasks } = experiment.benchmark
  const maxConcurrency = options.maxConcurrency ?? 2
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('candidate experiment maxConcurrency must be a positive integer')
  }
  const measurements = new Array<AgentCandidateExperimentMeasurement>(
    suite.taskDigests.length * suite.reps,
  )
  let nextIndex = 0
  const lanes = Array.from({ length: Math.min(maxConcurrency, measurements.length) }, async () => {
    while (true) {
      if (options.signal?.aborted) throw abortError(options.signal)
      const index = nextIndex
      nextIndex += 1
      if (index >= measurements.length) return
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
      const [baseline, candidate] = await Promise.all([
        options.execute({
          experiment,
          arm: 'baseline',
          bundle: experiment.baseline,
          task,
          benchmarkCell,
          seed,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        options.execute({
          experiment,
          arm: 'candidate',
          bundle: experiment.candidate,
          task,
          benchmarkCell,
          seed,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      ])
      const measurement = { baseline, candidate }
      verifyMeasurement(experiment, measurement, index)
      measurements[index] = measurement
    }
  })
  await Promise.all(lanes)
  return measurements
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

  const {
    confidenceLevel: confidence,
    resamples,
    bootstrapSeed,
    deltaThreshold,
    minProductiveRuns,
    budgetUsd,
    criticalDimensions,
    regressionTolerance,
  } = experiment.policy
  const baselineScores = measurements.map(scoreOf('baseline'))
  const candidateScores = measurements.map(scoreOf('candidate'))
  const overall = measuredEstimate(baselineScores, candidateScores, {
    confidence,
    resamples,
    seed: bootstrapSeed,
  })
  const dimensions = sharedDimensions(measurements)
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
        measurements.map(dimensionOf('baseline', name)),
        measurements.map(dimensionOf('candidate', name)),
        { confidence, resamples, seed: bootstrapSeed + index + 1 },
      ),
    })),
  ]
  const cost = measuredEstimate(
    measurements.map(costOf('baseline')),
    measurements.map(costOf('candidate')),
    { confidence, resamples, seed: bootstrapSeed + dimensions.length + 1 },
  )
  const latency = measuredEstimate(
    measurements.map(latencyOf('baseline')),
    measurements.map(latencyOf('candidate')),
    { confidence, resamples, seed: bootstrapSeed + dimensions.length + 2 },
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

  const significance = heldoutSignificance(
    { before: baselineScores, after: candidateScores, cellIds: cellIds(experiment) },
    {
      confidence,
      resamples,
      seed: bootstrapSeed,
      statistic: 'mean',
      deltaThreshold,
      minProductiveRuns,
    },
  )
  const power =
    baselineScores.length >= 3
      ? powerPreflight({
          baselineComposites: baselineScores,
          pairedN: baselineScores.length,
          deltaThreshold,
          confidence,
          sharedScorerChannel: true,
        })
      : undefined
  const powerSufficient =
    baselineScores.length >= minProductiveRuns && power !== undefined && !power.underpowered
  const guardedDimensions = new Set(criticalDimensions)
  const regressions = objectives.filter(
    (objective) =>
      objective.kind === 'dimension' &&
      guardedDimensions.has(objective.name) &&
      objective.availability === 'measured' &&
      objective.confidenceInterval.lower < -regressionTolerance,
  )
  const executionCostUsd = measurements.reduce(
    (sum, measurement) =>
      sum + costFromEvidence(measurement.baseline) + costFromEvidence(measurement.candidate),
    0,
  )
  const searchCostUsd = options.searchCostUsd ?? 0
  const totalCostUsd = executionCostUsd + searchCostUsd
  const budgetPassed = budgetUsd === undefined || totalCostUsd <= budgetUsd
  const completedRuns = measurements.flatMap((measurement) => [
    measurement.baseline,
    measurement.candidate,
  ])
  const incompleteRuns = completedRuns.filter((evidence) => !completedSuccessfully(evidence))
  const failedCandidateResults = measurements.filter(
    (measurement) => !measurement.candidate.receipt.benchmarkResult.material.passed,
  )
  const checks = [
    { name: 'paired-significance', passed: significance.significant },
    { name: 'statistical-power', passed: powerSufficient },
    { name: 'all-runs-completed', passed: incompleteRuns.length === 0 },
    { name: 'candidate-task-pass', passed: failedCandidateResults.length === 0 },
    { name: 'critical-dimensions', passed: regressions.length === 0 },
    { name: 'budget', passed: budgetPassed },
  ]
  const shipped = checks.every((check) => check.passed)
  const reasons = [
    ...(significance.significant
      ? []
      : [
          significance.fewRuns
            ? `only ${significance.n} paired runs; ${minProductiveRuns} required`
            : `paired interval lower bound ${significance.bootstrap.low} did not clear ${deltaThreshold}`,
        ]),
    ...(powerSufficient
      ? []
      : [power?.recommendation ?? `need at least ${Math.max(3, minProductiveRuns)} paired runs`]),
    ...(regressions.length === 0
      ? []
      : [`critical dimensions regressed: ${regressions.map((entry) => entry.name).join(', ')}`]),
    ...(incompleteRuns.length === 0
      ? []
      : [`${incompleteRuns.length} benchmark executions did not exit successfully`]),
    ...(failedCandidateResults.length === 0
      ? []
      : [`candidate failed ${failedCandidateResults.length} benchmark tasks`]),
    ...(budgetPassed ? [] : [`total cost ${totalCostUsd} exceeded budget ${budgetUsd}`]),
  ]
  if (shipped && options.diff.trim().length === 0) {
    throw new Error('a passing candidate experiment requires a non-empty candidate diff')
  }
  const executionDurationMs = measurements.reduce(
    (sum, measurement) =>
      sum + latencyFromEvidence(measurement.baseline) + latencyFromEvidence(measurement.candidate),
    0,
  )
  const searchDurationMs = options.searchDurationMs ?? 0
  const durationMs = executionDurationMs + searchDurationMs
  const recordDigest = canonicalCandidateDigest({
    kind: 'agent-candidate-experiment-measurement',
    experimentDigest: experiment.digest,
    measurementDigests: measurements.flatMap((measurement) => [
      measurement.baseline.digest,
      measurement.candidate.digest,
    ]),
    confidence,
    resamples,
    bootstrapSeed,
    deltaThreshold,
    minProductiveRuns,
    criticalDimensions,
    regressionTolerance,
    budgetUsd: budgetUsd ?? null,
  })

  return agentImprovementMeasuredComparisonSchema.parse({
    kind: 'agent-improvement-measured-comparison',
    experiment,
    measurements,
    overall: {
      name: 'composite',
      direction: 'higher-is-better',
      unit: 'score',
      ...overall,
    },
    objectives,
    ...(options.candidate ? { candidate: options.candidate } : {}),
    decision: {
      outcome: shipped
        ? 'ship'
        : significance.fewRuns || !powerSufficient
          ? 'need_more_work'
          : 'hold',
      reasons: reasons.length > 0 ? reasons : ['all measured checks passed'],
      contributingChecks: checks,
    },
    power: {
      sufficient: powerSufficient,
      n: baselineScores.length,
      minimumDetectableDelta: power?.mde ?? 1,
      confidenceLevel: confidence,
      scaleAssumed: power?.scaleAssumed ?? true,
      sharedScorerChannel: true,
      reason:
        power?.recommendation ?? `need at least ${Math.max(3, minProductiveRuns)} paired runs`,
    },
    provenance: {
      kind: 'agent-eval-loop',
      schema: 'agent-candidate-experiment',
      runId: options.runId,
      recordDigest,
      baselineContentHash: experiment.baseline.digest,
      candidateContentHash: experiment.candidate.digest,
    },
    diff: options.diff,
    evaluation: {
      generationsExplored: options.generationsExplored ?? 0,
      searchDurationMs,
      executionDurationMs,
      durationMs,
      searchCostUsd,
      executionCostUsd,
      totalCostUsd,
    },
    ...(options.metadata ? { metadata: options.metadata } : {}),
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
    diff: comparison.diff,
    ...(comparison.candidate ? { candidate: comparison.candidate } : {}),
    generationsExplored: comparison.evaluation.generationsExplored,
    searchDurationMs: comparison.evaluation.searchDurationMs,
    searchCostUsd: comparison.evaluation.searchCostUsd,
    ...(comparison.metadata ? { metadata: comparison.metadata } : {}),
  })
  if (canonicalCandidateDigest(recomputed) !== canonicalCandidateDigest(comparison)) {
    throw new Error('candidate experiment comparison does not match its Runtime receipts')
  }
  return comparison
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

function sharedDimensions(measurements: AgentCandidateExperimentMeasurement[]): string[] {
  const expected = dimensionNames(measurements[0]?.baseline)
  for (const [index, measurement] of measurements.entries()) {
    for (const [arm, evidence] of [
      ['baseline', measurement.baseline],
      ['candidate', measurement.candidate],
    ] as const) {
      const actual = dimensionNames(evidence)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `candidate experiment measurement ${index} ${arm} dimensions do not match the suite`,
        )
      }
    }
  }
  return expected
}

function dimensionNames(evidence: CandidateExecutionEvidence | undefined): string[] {
  return (evidence?.receipt.benchmarkResult.material.dimensions ?? []).map(
    (dimension) => dimension.name,
  )
}

function scoreOf(arm: 'baseline' | 'candidate') {
  return (measurement: AgentCandidateExperimentMeasurement): number =>
    measurement[arm].receipt.benchmarkResult.material.score
}

function dimensionOf(arm: 'baseline' | 'candidate', name: string) {
  return (measurement: AgentCandidateExperimentMeasurement): number => {
    const dimension = measurement[arm].receipt.benchmarkResult.material.dimensions.find(
      (entry) => entry.name === name,
    )
    if (!dimension) throw new Error(`candidate experiment is missing dimension '${name}'`)
    return dimension.score
  }
}

function costOf(arm: 'baseline' | 'candidate') {
  return (measurement: AgentCandidateExperimentMeasurement): number =>
    costFromEvidence(measurement[arm])
}

function latencyOf(arm: 'baseline' | 'candidate') {
  return (measurement: AgentCandidateExperimentMeasurement): number =>
    latencyFromEvidence(measurement[arm])
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

function combinedUsage(evidence: CandidateExecutionEvidence) {
  const candidate = evidence.receipt.modelSettlement.material.usage
  const grader = evidence.receipt.benchmarkResult.material.grading.usage
  return {
    inputTokens: candidate.inputTokens + grader.inputTokens,
    outputTokens: candidate.outputTokens + grader.outputTokens,
    cachedInputTokens: candidate.cachedInputTokens + grader.cachedInputTokens,
    reasoningTokens: candidate.reasoningTokens + grader.reasoningTokens,
    modelCalls: candidate.modelCalls + grader.modelCalls,
    costUsdNanos: candidate.costUsdNanos + grader.costUsdNanos,
  }
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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('candidate experiment aborted')
}
