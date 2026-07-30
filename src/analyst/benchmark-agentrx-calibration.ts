import type { AnalystBenchmarkObservation, AnalystBenchmarkResult } from './benchmark'
import { roundAgentRxStep } from './benchmark-datasets'

export const AGENT_RX_UPSTREAM_REVISION = 'f228165bfec60a801fd5fedd9d8ffe0f9de0c69d'

export interface AgentRxCalibrationRunnerSummary {
  runnerId: string
  selectedRuns: number
  completedRuns: number
  failedRuns: number
  predictedRuns: number
  missingPredictionRuns: number
  exactStepAccuracy: number | null
  stepAccuracyWithin1: number | null
  stepAccuracyWithin2: number | null
  stepAccuracyWithin3: number | null
  stepAccuracyWithin4: number | null
  stepAccuracyWithin5: number | null
  meanStepDistance: number | null
  normalizedMeanStepDistance: number | null
  normalizedDistanceRuns: number
  normalizedDistanceUnknownRuns: number
  rootCauseCategoryAccuracy: number | null
  anyFailureCategoryAccuracy: number | null
  earliestFailureCategoryAccuracy: number | null
  terminalFailureCategoryAccuracy: number | null
}

export interface AgentRxCalibrationSummary {
  protocol: 'official-agentrx-root-cause'
  upstreamRevision: string
  rationale: string
  runners: AgentRxCalibrationRunnerSummary[]
}

export function summarizeAgentRxCalibration(
  result: AnalystBenchmarkResult,
  upstreamRevision: string,
): AgentRxCalibrationSummary {
  if (!upstreamRevision.trim()) {
    throw new TypeError('AgentRx calibration requires an upstream revision')
  }
  return {
    protocol: 'official-agentrx-root-cause',
    upstreamRevision,
    rationale:
      'Matches AgentRx root-category accuracy, Python-rounded exact and tolerance step accuracy, unrounded mean step distance, normalized distance, and any, earliest, and terminal category accuracy. Failed runs and empty predictions score as no prediction.',
    runners: result.provenance.runnerIds.map((runnerId) =>
      summarizeRunner(
        runnerId,
        result.observations.filter((observation) => observation.runnerId === runnerId),
      ),
    ),
  }
}

export function renderAgentRxCalibrationMarkdown(summary: AgentRxCalibrationSummary): string {
  return [
    '## AgentRx Published Metrics',
    '',
    summary.rationale,
    '',
    `Upstream revision: \`${summary.upstreamRevision}\`.`,
    '',
    '| Runner | Completed/selected | Failed | Predictions | Missing predictions | Exact step | Within 1 | Within 2 | Within 3 | Within 4 | Within 5 | Mean step distance | Normalized distance | Normalized known/unknown | Root category | Any category | Earliest category | Terminal category |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summary.runners.map(
      (runner) =>
        `| ${escapeCell(runner.runnerId)} | ${runner.completedRuns}/${runner.selectedRuns} | ${runner.failedRuns} | ${runner.predictedRuns} | ${runner.missingPredictionRuns} | ${rate(runner.exactStepAccuracy)} | ${rate(runner.stepAccuracyWithin1)} | ${rate(runner.stepAccuracyWithin2)} | ${rate(runner.stepAccuracyWithin3)} | ${rate(runner.stepAccuracyWithin4)} | ${rate(runner.stepAccuracyWithin5)} | ${number(runner.meanStepDistance)} | ${number(runner.normalizedMeanStepDistance)} | ${runner.normalizedDistanceRuns}/${runner.normalizedDistanceUnknownRuns} | ${rate(runner.rootCauseCategoryAccuracy)} | ${rate(runner.anyFailureCategoryAccuracy)} | ${rate(runner.earliestFailureCategoryAccuracy)} | ${rate(runner.terminalFailureCategoryAccuracy)} |`,
    ),
  ].join('\n')
}

function summarizeRunner(
  runnerId: string,
  observations: readonly AnalystBenchmarkObservation[],
): AgentRxCalibrationRunnerSummary {
  const scored = observations.map(scoredObservation)
  const normalized = scored.filter(
    (row): row is ReturnType<typeof scoredObservation> & { normalizedDistance: number } =>
      row.normalizedDistance !== null,
  )
  const predicted = scored.filter(
    (row): row is ReturnType<typeof scoredObservation> & { distance: number } =>
      row.distance !== null,
  )
  return {
    runnerId,
    selectedRuns: observations.length,
    completedRuns: observations.filter((observation) => !observation.error).length,
    failedRuns: observations.filter((observation) => Boolean(observation.error)).length,
    predictedRuns: predicted.length,
    missingPredictionRuns: scored.length - predicted.length,
    exactStepAccuracy: mean(scored.map((row) => Number(row.roundedDistance === 0))),
    stepAccuracyWithin1: mean(
      scored.map((row) => Number(row.roundedDistance !== null && row.roundedDistance <= 1)),
    ),
    stepAccuracyWithin2: mean(
      scored.map((row) => Number(row.roundedDistance !== null && row.roundedDistance <= 2)),
    ),
    stepAccuracyWithin3: mean(
      scored.map((row) => Number(row.roundedDistance !== null && row.roundedDistance <= 3)),
    ),
    stepAccuracyWithin4: mean(
      scored.map((row) => Number(row.roundedDistance !== null && row.roundedDistance <= 4)),
    ),
    stepAccuracyWithin5: mean(
      scored.map((row) => Number(row.roundedDistance !== null && row.roundedDistance <= 5)),
    ),
    meanStepDistance: mean(predicted.map((row) => row.distance)),
    normalizedMeanStepDistance: mean(normalized.map((row) => row.normalizedDistance)),
    normalizedDistanceRuns: normalized.length,
    normalizedDistanceUnknownRuns: scored.length - normalized.length,
    rootCauseCategoryAccuracy: mean(scored.map((row) => Number(row.rootCategoryMatch))),
    anyFailureCategoryAccuracy: mean(scored.map((row) => Number(row.anyCategoryMatch))),
    earliestFailureCategoryAccuracy: mean(scored.map((row) => Number(row.earliestCategoryMatch))),
    terminalFailureCategoryAccuracy: mean(scored.map((row) => Number(row.terminalCategoryMatch))),
  }
}

function scoredObservation(observation: AnalystBenchmarkObservation) {
  const metadata = record(observation.caseMetadata)
  const rootStep = requiredPositiveNumber(
    metadata.rootCauseStep,
    observation.caseId,
    'rootCauseStep',
  )
  const rootCategory = requiredString(
    metadata.rootCauseCategory,
    observation.caseId,
    'rootCauseCategory',
  )
  const allCategories = requiredStringArray(
    metadata.allFailureCategories,
    observation.caseId,
    'allFailureCategories',
  )
  const earliestCategory = requiredString(
    metadata.earliestFailureCategory,
    observation.caseId,
    'earliestFailureCategory',
  )
  const terminalCategory = requiredString(
    metadata.terminalFailureCategory,
    observation.caseId,
    'terminalFailureCategory',
  )
  const finding = observation.error ? undefined : observation.findings[0]
  const findingMetadata = record(finding?.metadata)
  const stepMean = finding
    ? finiteNonNegative(
        findingMetadata.step_mean ?? findingMetadata.step,
        observation.caseId,
        'predicted step',
      )
    : null
  const roundedDistance = stepMean === null ? null : Math.abs(roundAgentRxStep(stepMean) - rootStep)
  const distance = stepMean === null ? null : Math.abs(stepMean - rootStep)
  const trajectoryLength =
    metadata.trajectoryLength === undefined
      ? null
      : requiredPositiveNumber(metadata.trajectoryLength, observation.caseId, 'trajectoryLength')
  const predictedCategory = finding?.area
  return {
    roundedDistance,
    distance,
    normalizedDistance:
      trajectoryLength === null || distance === null ? null : distance / trajectoryLength,
    rootCategoryMatch: predictedCategory === rootCategory,
    anyCategoryMatch: predictedCategory !== undefined && allCategories.includes(predictedCategory),
    earliestCategoryMatch: predictedCategory === earliestCategory,
    terminalCategoryMatch: predictedCategory === terminalCategory,
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function requiredPositiveNumber(value: unknown, caseId: string, field: string): number {
  const numberValue = finiteNonNegative(value, caseId, field)
  if (numberValue <= 0) throw new TypeError(`${caseId}: ${field} must be positive`)
  return numberValue
}

function finiteNonNegative(value: unknown, caseId: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${caseId}: ${field} must be a finite non-negative number`)
  }
  return value
}

function requiredString(value: unknown, caseId: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${caseId}: ${field} must be a non-empty string`)
  }
  return value
}

function requiredStringArray(value: unknown, caseId: string, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    throw new TypeError(`${caseId}: ${field} must be a non-empty string array`)
  }
  return value as string[]
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length
}

function rate(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3)
}

function number(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3)
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
