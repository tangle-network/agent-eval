import {
  type AgentCandidateFixedSpend,
  type AgentImprovementCost,
  type AgentProfileImprovementExperiment,
  type AgentProfileImprovementExperimentMaterial,
  type AgentProfileImprovementMeasuredComparison,
  type AgentProfileImprovementMeasurement,
  type AgentProfileImprovementRunCell,
  type AgentProfileImprovementRunReceipt,
  type AgentProfileImprovementSuiteInputs,
  type AgentProfileImprovementTask,
  type AgentProfileImprovementTaskMaterial,
  agentProfileImprovementExperimentSchema,
  agentProfileImprovementMeasuredComparisonSchema,
  agentProfileImprovementRunCellSchema,
  agentProfileImprovementRunReceiptSchema,
  agentProfileImprovementSuiteInputsSchema,
  agentProfileImprovementSuiteSchema,
  agentProfileImprovementTaskSchema,
  canonicalCandidateDigest,
  canonicalCandidateJson,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import type { CostLedgerHandle, CostReceiptInput } from '../cost-ledger'
import { addFixedSpend } from './fixed-spend'
import { evaluatePairedMeasurements, type PairedMeasurementAdapter } from './measured-comparison'
import { runPaidPairedMeasurement } from './paid-paired-measurement'

export interface SealAgentProfileImprovementSuiteOptions {
  splitDigest: Sha256Digest
  tasks: [AgentProfileImprovementTask, ...AgentProfileImprovementTask[]]
  reps: number
  seeds: [number, ...number[]]
}

export interface AgentProfileImprovementExperimentExecutionInput {
  experiment: AgentProfileImprovementExperiment
  arm: 'baseline' | 'candidate'
  stateDigest: Sha256Digest
  task: AgentProfileImprovementTask
  runCell: AgentProfileImprovementRunCell
  seed: number
  signal?: AbortSignal
}

export interface RunAgentProfileImprovementExperimentOptions {
  experiment: AgentProfileImprovementExperiment
  execute(
    input: AgentProfileImprovementExperimentExecutionInput,
  ): Promise<AgentProfileImprovementRunReceipt>
  /** Maximum number of simultaneous execute calls across both arms. */
  maxConcurrency?: number
  /** Shared run budget that also accounts for analysis and candidate search. */
  costLedger?: CostLedgerHandle
  signal?: AbortSignal
}

export interface AgentProfileImprovementExperimentRun {
  measurements: AgentProfileImprovementMeasurement[]
  measurement: {
    wallDurationMs: number
    cost: AgentImprovementCost
  }
}

export interface CompareAgentProfileImprovementExperimentOptions {
  experiment: AgentProfileImprovementExperiment
  measurements: AgentProfileImprovementMeasurement[]
  preparation: {
    wallDurationMs: number
    cost: AgentImprovementCost
  }
  measurement: AgentProfileImprovementExperimentRun['measurement']
  runId: string
  candidate?: AgentProfileImprovementMeasuredComparison['candidate']
  generationsExplored?: number
  metadata?: AgentProfileImprovementMeasuredComparison['metadata']
}

/** Content-address one held-out profile task before either state can execute it. */
export function sealAgentProfileImprovementTask(
  material: AgentProfileImprovementTaskMaterial,
): AgentProfileImprovementTask {
  return agentProfileImprovementTaskSchema.parse({
    ...material,
    digest: canonicalCandidateDigest(material),
  })
}

/** Freeze profile task order, repetitions, seeds, and the held-out split. */
export function sealAgentProfileImprovementSuite(
  options: SealAgentProfileImprovementSuiteOptions,
): AgentProfileImprovementSuiteInputs {
  for (const task of options.tasks) verifyAgentProfileImprovementTask(task)
  const material = {
    kind: 'agent-profile-improvement-suite' as const,
    digestAlgorithm: 'rfc8785-sha256' as const,
    splitDigest: options.splitDigest,
    taskDigests: options.tasks.map((task) => task.digest) as [Sha256Digest, ...Sha256Digest[]],
    reps: options.reps,
    seeds: options.seeds,
  }
  const suite = agentProfileImprovementSuiteSchema.parse({
    ...material,
    digest: canonicalCandidateDigest(material),
  })
  return agentProfileImprovementSuiteInputsSchema.parse({
    suite,
    tasks: options.tasks,
  })
}

/** Freeze the two host-owned profile states and their exact held-out work. */
export function sealAgentProfileImprovementExperiment(
  material: AgentProfileImprovementExperimentMaterial,
): AgentProfileImprovementExperiment {
  return verifyAgentProfileImprovementExperiment({
    ...material,
    digest: canonicalCandidateDigest(material),
  })
}

function verifyAgentProfileImprovementTask(input: unknown): AgentProfileImprovementTask {
  return agentProfileImprovementTaskSchema.parse(input)
}

function verifyAgentProfileImprovementExperiment(
  input: unknown,
): AgentProfileImprovementExperiment {
  return agentProfileImprovementExperimentSchema.parse(input)
}

/**
 * Execute each signed profile cell through the host's one exact-state executor.
 * Eval owns only the cell schedule and receipt checks; the host resolves each
 * state digest and captures its own run, billing, trace, and grader evidence.
 */
export async function runAgentProfileImprovementExperiment(
  options: RunAgentProfileImprovementExperimentOptions,
): Promise<AgentProfileImprovementExperimentRun> {
  const experiment = verifyAgentProfileImprovementExperiment(options.experiment)
  const expectedCount =
    experiment.benchmark.suite.taskDigests.length * experiment.benchmark.suite.reps
  const run = await runPaidPairedMeasurement({
    count: expectedCount,
    maxConcurrency: options.maxConcurrency ?? 2,
    label: 'profile improvement experiment',
    budgetUsd: experiment.policy.budgetUsd,
    ...(options.costLedger ? { costLedger: options.costLedger } : {}),
    maximumCostUsd: profileMeasurementMaximumCostUsd(experiment),
    call: {
      callId: `profile-improvement-measurement:${experiment.digest}`,
      channel: 'measurement',
      phase: 'heldout',
      actor: experiment.executionRef.identity,
      model: profileMeasurementModel(experiment),
      tags: { experimentDigest: experiment.digest, executorDigest: experiment.executionRef.digest },
    },
    ...(options.signal ? { signal: options.signal } : {}),
    async execute(index, arm, signal) {
      const expected = profileExecutionInput(experiment, arm, index, signal)
      const receipt = agentProfileImprovementRunReceiptSchema.parse(await options.execute(expected))
      verifyProfileReceiptContract(receipt, expected, index)
      return receipt
    },
    receipt(measurements) {
      return profileMeasurementCostReceipt(measurements, profileMeasurementModel(experiment))
    },
  })
  return {
    measurements: run.measurements.map((measurement, index) =>
      verifyProfileMeasurement(experiment, measurement, index),
    ),
    measurement: {
      wallDurationMs: run.wallDurationMs,
      cost: { usd: run.cost.usd, provenance: run.cost.kind },
    },
  }
}

/** Build the only publishable profile comparison from complete host receipts. */
export function measuredComparisonFromAgentProfileImprovementExperiment(
  options: CompareAgentProfileImprovementExperimentOptions,
): AgentProfileImprovementMeasuredComparison {
  const experiment = verifyAgentProfileImprovementExperiment(options.experiment)
  const measurements = options.measurements.map((measurement, index) =>
    verifyProfileMeasurement(experiment, measurement, index),
  )
  const expectedCount =
    experiment.benchmark.suite.taskDigests.length * experiment.benchmark.suite.reps
  if (measurements.length !== expectedCount) {
    throw new Error(
      `profile improvement experiment is incomplete (${measurements.length}/${expectedCount} paired cells)`,
    )
  }
  if (!options.runId.trim()) {
    throw new Error('profile improvement experiment runId is required')
  }

  const evaluation = evaluatePairedMeasurements({
    measurements: measurements.map((measurement, index) => ({
      cellId: profileCellId(experiment, index),
      ...measurement,
    })),
    policy: experiment.policy,
    adapter: profileReceiptAdapter,
    sharedScorerChannel: true,
    preparationCost: options.preparation.cost,
    measurementCost: options.measurement.cost,
  })
  const provisional = agentProfileImprovementMeasuredComparisonSchema.parse({
    kind: 'agent-profile-improvement-measured-comparison',
    experiment,
    measurements,
    overall: evaluation.overall,
    objectives: evaluation.objectives,
    ...(options.candidate ? { candidate: options.candidate } : {}),
    decision: evaluation.decision,
    power: evaluation.power,
    provenance: {
      kind: 'agent-eval-loop',
      schema: 'agent-profile-improvement-experiment',
      runId: options.runId,
      recordDigest: canonicalCandidateDigest({}),
      baselineContentHash: experiment.baseline.stateDigest,
      candidateContentHash: experiment.candidate.stateDigest,
    },
    diff: canonicalCandidateJson(experiment.change),
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
  return agentProfileImprovementMeasuredComparisonSchema.parse({
    ...provisional,
    provenance: {
      ...provenance,
      recordDigest: canonicalCandidateDigest({ ...provisional, provenance }),
    },
  })
}

/** Recompute a profile comparison from the exact sealed experiment and receipts. */
export function verifyAgentProfileImprovementExperimentComparison(
  input: unknown,
): AgentProfileImprovementMeasuredComparison {
  const comparison = agentProfileImprovementMeasuredComparisonSchema.parse(input)
  const recomputed = measuredComparisonFromAgentProfileImprovementExperiment({
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
    throw new Error('profile improvement comparison does not match its Runtime receipts')
  }
  return comparison
}

function profileMeasurementMaximumCostUsd(experiment: AgentProfileImprovementExperiment): number {
  const pairs = experiment.benchmark.suite.reps
  const maximum = experiment.benchmark.tasks.reduce(
    (sum, task) => sum + task.limits.maxCostUsd * pairs * 2,
    0,
  )
  if (!Number.isFinite(maximum) || maximum < 0) {
    throw new Error('profile improvement measurement maximum cost is invalid')
  }
  return maximum
}

function profileMeasurementModel(experiment: AgentProfileImprovementExperiment): string {
  const models = [...new Set(experiment.benchmark.tasks.map((task) => task.model.model))]
  return models.length === 1 ? models[0]! : 'multiple-models'
}

function profileMeasurementCostReceipt(
  measurements: Array<{
    baseline: AgentProfileImprovementRunReceipt
    candidate: AgentProfileImprovementRunReceipt
  }>,
  model: string,
): CostReceiptInput {
  const usage = measurements.reduce<AgentCandidateFixedSpend>(
    (sum, measurement) =>
      addFixedSpend(
        addFixedSpend(sum, combinedProfileUsage(measurement.baseline)),
        combinedProfileUsage(measurement.candidate),
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

function combinedProfileUsage(
  receipt: AgentProfileImprovementRunReceipt,
): AgentCandidateFixedSpend {
  return addFixedSpend(receipt.usage, receipt.grading.usage)
}

function profileExecutionInput(
  experiment: AgentProfileImprovementExperiment,
  arm: 'baseline' | 'candidate',
  index: number,
  signal: AbortSignal | undefined,
): AgentProfileImprovementExperimentExecutionInput {
  const { task, taskIndex, repetition, seed } = profileCell(experiment, index)
  const stateDigest = experiment[arm].stateDigest
  const runCellMaterial = {
    kind: 'agent-profile-improvement-run-cell' as const,
    experimentDigest: experiment.digest,
    arm,
    stateDigest,
    suiteDigest: experiment.benchmark.suite.digest,
    taskDigest: task.digest,
    taskIndex,
    repetition,
    seed,
    attempt: 1,
  }
  const runCell = agentProfileImprovementRunCellSchema.parse({
    ...runCellMaterial,
    digest: canonicalCandidateDigest(runCellMaterial),
  })
  return {
    experiment,
    arm,
    stateDigest,
    task,
    runCell,
    seed,
    ...(signal ? { signal } : {}),
  }
}

function verifyProfileMeasurement(
  experiment: AgentProfileImprovementExperiment,
  input: unknown,
  index: number,
): AgentProfileImprovementMeasurement {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`profile improvement measurement ${index} must be an object`)
  }
  const material = input as { baseline?: unknown; candidate?: unknown }
  const expectedBaseline = profileExecutionInput(experiment, 'baseline', index, undefined)
  const expectedCandidate = profileExecutionInput(experiment, 'candidate', index, undefined)
  const baseline = agentProfileImprovementRunReceiptSchema.parse(material.baseline)
  const candidate = agentProfileImprovementRunReceiptSchema.parse(material.candidate)
  if (
    baseline.runCell.digest !== expectedBaseline.runCell.digest ||
    candidate.runCell.digest !== expectedCandidate.runCell.digest
  ) {
    throw new Error(`profile improvement measurement ${index} substituted a measured arm`)
  }
  verifyProfileReceiptContract(baseline, expectedBaseline, index)
  verifyProfileReceiptContract(candidate, expectedCandidate, index)
  if (baseline.executionId === candidate.executionId || baseline.digest === candidate.digest) {
    throw new Error(`profile improvement measurement ${index} reused one execution across arms`)
  }
  return { baseline, candidate }
}

function verifyProfileReceiptContract(
  receipt: AgentProfileImprovementRunReceipt,
  expected: AgentProfileImprovementExperimentExecutionInput,
  index: number,
): void {
  const task = expected.task
  if (
    canonicalCandidateDigest(receipt.resolvedModel) !== canonicalCandidateDigest(task.model) ||
    canonicalCandidateDigest(receipt.limits) !== canonicalCandidateDigest(task.limits) ||
    canonicalCandidateDigest(receipt.grading.grader) !== canonicalCandidateDigest(task.grader)
  ) {
    throw new Error(
      `profile improvement measurement ${index} substituted its ${expected.arm} task contract`,
    )
  }
  if (
    canonicalCandidateDigest(receipt.executionRef) !==
    canonicalCandidateDigest(expected.experiment.executionRef)
  ) {
    throw new Error(
      `profile improvement measurement ${index} substituted its ${expected.arm} executor`,
    )
  }
}

function profileCell(
  experiment: AgentProfileImprovementExperiment,
  index: number,
): {
  task: AgentProfileImprovementTask
  taskIndex: number
  repetition: number
  seed: number
} {
  const { suite, tasks } = experiment.benchmark
  const taskIndex = Math.floor(index / suite.reps)
  const repetition = index % suite.reps
  const task = tasks[taskIndex]
  const seed = suite.seeds[index]
  if (!task || seed === undefined) {
    throw new Error(`profile improvement experiment cell ${index} is outside the signed suite`)
  }
  return { task, taskIndex, repetition, seed }
}

function profileCellId(experiment: AgentProfileImprovementExperiment, index: number): string {
  return `${experiment.benchmark.suite.digest}:${index}`
}

const profileReceiptAdapter: PairedMeasurementAdapter<AgentProfileImprovementRunReceipt> = {
  score: (receipt) => receipt.grading.score,
  dimensions: (receipt) => receipt.grading.dimensions,
  costUsd: (receipt) =>
    (receipt.usage.costUsdNanos + receipt.grading.usage.costUsdNanos) / 1_000_000_000,
  costProvenance: (receipt) =>
    receipt.usage.costProvenance === 'observed' &&
    receipt.grading.usage.costProvenance === 'observed'
      ? 'observed'
      : 'estimated',
  latencyMs: (receipt) => receipt.timing.durationMs + receipt.grading.timing.durationMs,
  completed: (receipt) => receipt.outcome.status === 'succeeded',
  passed: (receipt) => receipt.grading.passed,
}
