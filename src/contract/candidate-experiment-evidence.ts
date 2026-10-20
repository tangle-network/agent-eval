/** Verify signed candidate execution receipts and read their measured usage. */

import {
  type AgentCandidateBenchmarkTask,
  type AgentCandidateExperiment,
  type AgentCandidateExperimentMeasurement,
  type AgentCandidateFixedSpend,
  type CandidateExecutionEvidence,
  candidateExecutionEvidenceSchema,
  canonicalCandidateDigest,
  omitTopLevelDigest,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import type { CostReceiptInput } from '../cost-ledger'
import { addFixedSpend, pairedFixedSpendReceipt } from './fixed-spend'
import type { PairedMeasurementAdapter } from './measured-comparison-types'

export const candidateExecutionEvidenceAdapter: PairedMeasurementAdapter<CandidateExecutionEvidence> =
  {
    score: (evidence) => evidence.receipt.benchmarkResult.material.score,
    dimensions: (evidence) => evidence.receipt.benchmarkResult.material.dimensions,
    costUsd: costFromEvidence,
    costProvenance: (evidence) => combinedUsage(evidence).costProvenance,
    latencyMs: latencyFromEvidence,
    completed: completedSuccessfully,
    passed: (evidence) => evidence.receipt.benchmarkResult.material.passed,
  }

export function verifyMeasurement(
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

export function verifyExecutionEvidence(input: unknown): CandidateExecutionEvidence {
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

export function verifySelfAddressed<T extends { digest: Sha256Digest }>(
  document: T,
  label: string,
): void {
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

export function verifyStableProfileMaterialization(
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

export function candidateMeasurementCostReceipt(
  measurements: Array<{
    baseline: CandidateExecutionEvidence
    candidate: CandidateExecutionEvidence
  }>,
  model: string,
): CostReceiptInput {
  return pairedFixedSpendReceipt(measurements, model, combinedUsage)
}
