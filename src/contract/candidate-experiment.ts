/** Seal held-out experiments, execute their signed cells, and publish verified comparisons. */

import {
  type AgentCandidateBenchmarkSuiteInputs,
  type AgentCandidateBenchmarkTask,
  type AgentCandidateBenchmarkTaskMaterial,
  type AgentCandidateBundle,
  type AgentCandidateExperiment,
  type AgentCandidateExperimentMaterial,
  type AgentImprovementMeasuredComparison,
  agentCandidateBenchmarkSuiteSchema,
  agentCandidateBenchmarkTaskSchema,
  agentCandidateBundleSchema,
  agentCandidateExperimentSchema,
  agentImprovementMeasuredComparisonSchema,
  canonicalCandidateDigest,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import {
  candidateExecutionEvidenceAdapter,
  candidateMeasurementCostReceipt,
  verifyExecutionEvidence,
  verifyMeasurement,
  verifySelfAddressed,
  verifyStableProfileMaterialization,
} from './candidate-experiment-evidence'
import type {
  CandidateExperimentRun,
  CompareCandidateExperimentOptions,
  RunCandidateExperimentOptions,
  SealCandidateBenchmarkSuiteOptions,
} from './measured-comparison-types'
import { runPaidPairedMeasurement } from './paid-paired-measurement'
import { evaluatePairedMeasurements } from './paired-measurement-evaluation'
import { assertKnownCost } from './paired-measurement-input'

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

function assertPhaseAccounting(
  accounting: CompareCandidateExperimentOptions['preparation'],
  label: string,
): void {
  if (!Number.isFinite(accounting.wallDurationMs) || accounting.wallDurationMs < 0) {
    throw new Error(`${label} wall duration must be a non-negative number`)
  }
  assertKnownCost(accounting.cost, `${label} cost`)
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

function verifyCandidateBenchmarkTask(input: unknown): AgentCandidateBenchmarkTask {
  const task = agentCandidateBenchmarkTaskSchema.parse(input)
  verifySelfAddressed(task, 'candidate benchmark task')
  return task
}

function verifyCandidateBenchmarkSuiteInputs(input: unknown): AgentCandidateBenchmarkSuiteInputs {
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

function verifyCandidateBenchmarkSuite(input: unknown) {
  const suite = agentCandidateBenchmarkSuiteSchema.parse(input)
  verifySelfAddressed(suite, 'candidate benchmark suite')
  return suite
}

function verifyBundle(input: unknown, label: string): AgentCandidateBundle {
  const bundle = agentCandidateBundleSchema.parse(input)
  verifySelfAddressed(bundle, label)
  return bundle
}

function cellIds(experiment: AgentCandidateExperiment): string[] {
  const { suite, tasks } = experiment.benchmark
  return suite.seeds.map((_, index) => {
    const taskIndex = Math.floor(index / suite.reps)
    const repetition = index % suite.reps
    return `${tasks[taskIndex]?.scenario.id ?? taskIndex}:${repetition}`
  })
}
