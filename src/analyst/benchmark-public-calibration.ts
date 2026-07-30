import type { AnalystBenchmarkObservation, AnalystBenchmarkResult } from './benchmark'
import { codeTraceStepFromEvidence } from './benchmark-evidence-validation'

export interface CodeTraceCalibrationRunnerSummary {
  runnerId: string
  selectedRuns: number
  positiveRuns: number
  trustedNegativeRuns: number
  unlabeledRuns: number
  failedLabelEmptyRuns: number
  unknownLabelEmptyRuns: number
  completedRuns: number
  failedRuns: number
  expectedIncorrectSteps: number
  predictedIncorrectSteps: number
  matchedIncorrectSteps: number
  /** CodeTraceBench's published mean per-row incorrect-step F1 over every row. */
  officialAllRowF1: number | null
  officialAllRowRuns: number
  precision: number | null
  recall: number | null
  f1: number | null
  trustedNegativeFalsePositiveRate: number | null
  trustedNegativeFailureRate: number | null
  unlabeledPredictionRate: number | null
  unlabeledFailureRate: number | null
}

export interface CodeTraceCalibrationSummary {
  protocol: 'labeled-positive-and-solved-negative'
  rationale: string
  runners: CodeTraceCalibrationRunnerSummary[]
}

export function summarizeCodeTraceCalibration(
  result: AnalystBenchmarkResult,
): CodeTraceCalibrationSummary {
  return {
    protocol: 'labeled-positive-and-solved-negative',
    rationale:
      'Uses rows with incorrect-step labels as positives and solved label-empty rows as trusted negatives. Failed label-empty rows remain in the published result but are not treated as clean controls.',
    runners: result.provenance.runnerIds.map((runnerId) =>
      summarizeRunner(
        runnerId,
        result.observations.filter((observation) => observation.runnerId === runnerId),
      ),
    ),
  }
}

export function renderCodeTraceCalibrationMarkdown(summary: CodeTraceCalibrationSummary): string {
  return [
    '## CodeTraceBench Calibrated View',
    '',
    summary.rationale,
    '',
    '| Runner | Completed/selected | Failed | Positive runs | Trusted negative runs | Unlabeled runs | Failed label-empty | Unknown label-empty | Matched/expected steps | Predicted steps | Precision | Recall | F1 | Official all-row F1 | Official rows | Trusted-negative false positives | Trusted-negative failures | Unlabeled predictions | Unlabeled failures |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summary.runners.map(
      (runner) =>
        `| ${escapeCell(runner.runnerId)} | ${runner.completedRuns}/${runner.selectedRuns} | ${runner.failedRuns} | ${runner.positiveRuns} | ${runner.trustedNegativeRuns} | ${runner.unlabeledRuns} | ${runner.failedLabelEmptyRuns} | ${runner.unknownLabelEmptyRuns} | ${runner.matchedIncorrectSteps}/${runner.expectedIncorrectSteps} | ${runner.predictedIncorrectSteps} | ${rate(runner.precision)} | ${rate(runner.recall)} | ${rate(runner.f1)} | ${rate(runner.officialAllRowF1)} | ${runner.officialAllRowRuns} | ${rate(runner.trustedNegativeFalsePositiveRate)} | ${rate(runner.trustedNegativeFailureRate)} | ${rate(runner.unlabeledPredictionRate)} | ${rate(runner.unlabeledFailureRate)} |`,
    ),
  ].join('\n')
}

function summarizeRunner(
  runnerId: string,
  observations: readonly AnalystBenchmarkObservation[],
): CodeTraceCalibrationRunnerSummary {
  const positive = observations.filter((observation) => observation.labelState === 'positive')
  const trustedNegative = observations.filter(
    (observation) => observation.labelState === 'trusted-negative',
  )
  const excluded = observations.filter((observation) => observation.labelState === 'unlabeled')
  const selected = [...positive, ...trustedNegative]
  const expected = sum(positive.map((observation) => observation.score.expectedIssueCount))
  const predicted = sum(
    selected.map((observation) => (observation.error ? 0 : observation.findings.length)),
  )
  const matched = sum(positive.map((observation) => observation.score.matchedIssueIds.length))
  const precision = predicted === 0 ? (expected > 0 ? 0 : null) : matched / predicted
  const recall = ratio(matched, expected)
  const completedTrustedNegative = trustedNegative.filter((observation) => !observation.error)
  const completedExcluded = excluded.filter((observation) => !observation.error)
  const officialRows = observations.map(officialCodeTraceF1)

  return {
    runnerId,
    selectedRuns: selected.length,
    positiveRuns: positive.length,
    trustedNegativeRuns: trustedNegative.length,
    unlabeledRuns: excluded.length,
    failedLabelEmptyRuns: excluded.filter(
      (observation) => observation.caseMetadata?.solved === false,
    ).length,
    unknownLabelEmptyRuns: excluded.filter(
      (observation) => observation.caseMetadata?.solved !== false,
    ).length,
    completedRuns: selected.filter((observation) => !observation.error).length,
    failedRuns: selected.filter((observation) => observation.error).length,
    expectedIncorrectSteps: expected,
    predictedIncorrectSteps: predicted,
    matchedIncorrectSteps: matched,
    officialAllRowF1: mean(officialRows),
    officialAllRowRuns: officialRows.length,
    precision,
    recall,
    f1: harmonicMean(precision, recall),
    trustedNegativeFalsePositiveRate: ratio(
      completedTrustedNegative.filter((observation) => observation.score.predictionOnLabelEmptyCase)
        .length,
      completedTrustedNegative.length,
    ),
    trustedNegativeFailureRate: ratio(
      trustedNegative.filter((observation) => observation.error).length,
      trustedNegative.length,
    ),
    unlabeledPredictionRate: ratio(
      completedExcluded.filter((observation) => observation.findings.length > 0).length,
      completedExcluded.length,
    ),
    unlabeledFailureRate: ratio(
      excluded.filter((observation) => Boolean(observation.error)).length,
      excluded.length,
    ),
  }
}

function officialCodeTraceF1(observation: AnalystBenchmarkObservation): number {
  const trajectoryId = observation.caseMetadata?.trajectoryId
  if (typeof trajectoryId !== 'string' || !trajectoryId.trim()) {
    throw new TypeError(`${observation.caseId}: CodeTraceBench trajectoryId metadata is missing`)
  }
  const expected = new Set(
    [...observation.score.matchedIssueIds, ...observation.score.missedIssueIds].map((issueId) => {
      const match = /^incorrect:(\d+)$/.exec(issueId)
      if (!match) {
        throw new TypeError(`${observation.caseId}: invalid incorrect-step label '${issueId}'`)
      }
      return Number(match[1])
    }),
  )
  const predicted = new Set<number>()
  if (!observation.error) {
    for (const finding of observation.findings) {
      if (finding.area !== 'incorrect') continue
      for (const evidence of finding.evidence_refs) {
        const location = codeTraceStepFromEvidence(evidence.uri)
        if (!location || location.traceId !== trajectoryId) {
          throw new TypeError(
            `${observation.caseId}: invalid CodeTraceBench prediction evidence '${evidence.uri}'`,
          )
        }
        predicted.add(location.step)
      }
    }
  }
  let matched = 0
  for (const step of predicted) if (expected.has(step)) matched += 1
  const precision = predicted.size === 0 ? 0 : matched / predicted.size
  const recall = expected.size === 0 ? 0 : matched / expected.size
  return harmonicMean(precision, recall) ?? 0
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length
}

function harmonicMean(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null
  return left + right === 0 ? 0 : (2 * left * right) / (left + right)
}

function rate(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3)
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
