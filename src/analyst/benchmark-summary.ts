import { compareCodeUnits } from '../ledger-core/canonical'
import type {
  AnalystBenchmarkObservation,
  AnalystBenchmarkSummary,
  AnalystLatencyDistribution,
} from './benchmark'

import { harmonicMeanScore } from './benchmark-scoring'

export function summarizeAnalystBenchmarkRunner(
  runnerId: string,
  observations: readonly AnalystBenchmarkObservation[],
): AnalystBenchmarkSummary {
  const issueBearing = observations.filter((observation) => observation.labelState === 'positive')
  const completed = observations.filter((observation) => !observation.error)
  const expectedIssues = issueBearing.reduce(
    (sum, observation) => sum + observation.score.expectedIssueCount,
    0,
  )
  const matchedIssues = issueBearing.reduce(
    (sum, observation) => sum + observation.score.matchedIssueIds.length,
    0,
  )
  const issueFindings = issueBearing.reduce(
    (sum, observation) => sum + (observation.error ? 0 : observation.findings.length),
    0,
  )
  const supportedFindings = issueBearing.reduce(
    (sum, observation) => sum + observation.score.supportedFindingIndexes.length,
    0,
  )
  const issueRecall = expectedIssues === 0 ? null : matchedIssues / expectedIssues
  const findingPrecision =
    expectedIssues === 0 ? null : issueFindings === 0 ? 0 : supportedFindings / issueFindings
  const macroIssueRecall =
    issueBearing.length === 0
      ? null
      : mean(issueBearing.map((observation) => observation.score.issueRecall))
  const macroFindingPrecision =
    issueBearing.length === 0
      ? null
      : mean(issueBearing.map((observation) => observation.score.findingPrecision))
  const macroF1 =
    issueBearing.length === 0 ? null : mean(issueBearing.map((observation) => observation.score.f1))
  const critical = observations
    .map((observation) => observation.score.criticalStepAccuracy)
    .filter((value): value is number => value !== null)
  const findingsWithEvidence = completed.reduce(
    (sum, observation) =>
      sum + observation.findings.filter((finding) => finding.evidence_refs.length > 0).length,
    0,
  )
  const allFindings = completed.reduce((sum, observation) => sum + observation.findings.length, 0)
  const allCitations = completed.flatMap((observation) =>
    observation.findings.flatMap((finding) => finding.evidence_refs),
  )
  const citationObservations = completed.filter(
    (observation) => observation.score.citationLabelAgreement !== null,
  )
  const citationCount = citationObservations.reduce(
    (sum, observation) =>
      sum +
      observation.findings.reduce((count, finding) => count + finding.evidence_refs.length, 0),
    0,
  )
  const invalidCitationCount = citationObservations.reduce(
    (sum, observation) => sum + observation.score.unlabeledEvidence.length,
    0,
  )
  const trustedNegative = observations.filter(
    (observation) => observation.labelState === 'trusted-negative',
  )
  const completedTrustedNegative = trustedNegative.filter((observation) => !observation.error)
  const unlabeled = observations.filter((observation) => observation.labelState === 'unlabeled')
  const completedUnlabeled = unlabeled.filter((observation) => !observation.error)
  const resolvedCitations = completed.reduce(
    (sum, observation) => sum + (observation.evidenceResolution?.resolved ?? 0),
    0,
  )
  const unresolvedCitations = completed.reduce(
    (sum, observation) => sum + (observation.evidenceResolution?.unresolvedEvidence.length ?? 0),
    0,
  )
  const citationResolutionErrors = completed.reduce(
    (sum, observation) => sum + (observation.evidenceResolution?.errors.length ?? 0),
    0,
  )
  const resolutionAttempts = completed.filter((observation) =>
    observation.findings.some((finding) => finding.evidence_refs.length > 0),
  )
  const citationResolutionUnknownRuns = resolutionAttempts.filter(
    (observation) =>
      !observation.evidenceResolution || observation.evidenceResolution.errors.length > 0,
  ).length
  const usages = observations.map((observation) => observation.usage)
  const knownCostUsd = stableSum(
    usages.map((usage) => {
      if (!usage) return 0
      return usage.cost.kind === 'uncaptured' ? (usage.knownCostUsd ?? 0) : usage.cost.usd
    }),
  )
  const predictionAgreement = repeatedObservationAgreement(observations, predictionSignature)
  const matchedLabelAgreement = repeatedObservationAgreement(
    observations.filter((observation) => observation.labelState === 'positive'),
    matchedLabelSignature,
  )
  return {
    runnerId,
    plannedRuns: observations.length,
    completedRuns: observations.filter((observation) => !observation.error).length,
    failedRuns: observations.filter((observation) => Boolean(observation.error)).length,
    issueBearingRuns: issueBearing.length,
    trustedNegativeRuns: trustedNegative.length,
    unlabeledRuns: unlabeled.length,
    issueRecall,
    findingPrecision,
    f1:
      findingPrecision === null || issueRecall === null
        ? null
        : harmonicMeanScore(findingPrecision, issueRecall),
    macroIssueRecall,
    macroFindingPrecision,
    macroF1,
    criticalStepAccuracy: critical.length === 0 ? null : mean(critical),
    citationCoverage: allFindings === 0 ? null : findingsWithEvidence / allFindings,
    citationExcerptCoverage:
      allCitations.length === 0
        ? null
        : allCitations.filter((evidence) => Boolean(evidence.excerpt?.trim())).length /
          allCitations.length,
    citationLabelAgreement:
      citationObservations.length === 0
        ? null
        : citationCount === 0
          ? 0
          : (citationCount - invalidCitationCount) / citationCount,
    citationResolution:
      resolutionAttempts.length === 0 ||
      citationResolutionUnknownRuns > 0 ||
      resolvedCitations + unresolvedCitations === 0
        ? null
        : resolvedCitations / (resolvedCitations + unresolvedCitations),
    citationResolutionUnknownRuns,
    unresolvedCitations,
    citationResolutionErrors,
    trustedNegativeFalsePositiveRate:
      completedTrustedNegative.length === 0
        ? null
        : completedTrustedNegative.filter(
            (observation) => observation.score.predictionOnLabelEmptyCase,
          ).length / completedTrustedNegative.length,
    trustedNegativeFailureRate:
      trustedNegative.length === 0
        ? null
        : trustedNegative.filter((observation) => Boolean(observation.error)).length /
          trustedNegative.length,
    unlabeledPredictionRate:
      completedUnlabeled.length === 0
        ? null
        : completedUnlabeled.filter((observation) => observation.findings.length > 0).length /
          completedUnlabeled.length,
    unlabeledFailureRate:
      unlabeled.length === 0
        ? null
        : unlabeled.filter((observation) => Boolean(observation.error)).length / unlabeled.length,
    predictionAgreement: predictionAgreement.value,
    predictionAgreementCases: predictionAgreement.cases,
    matchedLabelAgreement: matchedLabelAgreement.value,
    matchedLabelAgreementCases: matchedLabelAgreement.cases,
    latencyMs: latencyDistribution(
      observations
        .map((observation) => observation.latencyMs)
        .filter((value): value is number => value !== null),
    ),
    benchmarkClockLatencyRuns: observations.filter(
      (observation) => observation.latencySource === 'benchmark-clock',
    ).length,
    runnerReportedLatencyRuns: observations.filter(
      (observation) => observation.latencySource === 'runner-reported',
    ).length,
    latencyUnknownRuns: observations.filter(
      (observation) => observation.latencySource === 'uncaptured',
    ).length,
    calls: usages.reduce((sum, usage) => sum + (usage?.calls ?? 0), 0),
    callsUnknownRuns: usages.filter((usage) => !usage || usage.calls === null).length,
    inputTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.input ?? 0), 0),
    outputTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.output ?? 0), 0),
    reasoningTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.reasoning ?? 0), 0),
    cachedTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.cached ?? 0), 0),
    cacheWriteTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.cacheWrite ?? 0), 0),
    tokenUsageUnknownRuns: usages.filter((usage) => !usage?.tokens).length,
    reasoningTokenUsageUnknownRuns: usages.filter((usage) => usage?.tokens?.reasoning === undefined)
      .length,
    cachedTokenUsageUnknownRuns: usages.filter((usage) => usage?.tokens?.cached === undefined)
      .length,
    cacheWriteTokenUsageUnknownRuns: usages.filter(
      (usage) => usage?.tokens?.cacheWrite === undefined,
    ).length,
    knownCostUsd,
    costUnknownRuns: usages.filter((usage) => !usage || usage.cost.kind === 'uncaptured').length,
  }
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : stableSum(values) / values.length
}

function stableSum(values: readonly number[]): number {
  const ordered = [...values].sort(
    (left, right) => Math.abs(left) - Math.abs(right) || left - right,
  )
  let sum = 0
  let correction = 0
  for (const value of ordered) {
    const next = sum + value
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum
    sum = next
  }
  return sum + correction
}

function latencyDistribution(values: readonly number[]): AnalystLatencyDistribution | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    min: sorted[0]!,
    mean: mean(sorted),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1)!,
  }
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? sorted.at(-1) ?? 0
}

function repeatedObservationAgreement(
  observations: readonly AnalystBenchmarkObservation[],
  signature: (observation: AnalystBenchmarkObservation) => readonly string[],
): { value: number | null; cases: number } {
  const byCase = new Map<string, AnalystBenchmarkObservation[]>()
  for (const observation of observations) {
    const rows = byCase.get(observation.caseId) ?? []
    rows.push(observation)
    byCase.set(observation.caseId, rows)
  }
  const caseAgreements: number[] = []
  for (const rows of byCase.values()) {
    const agreements: number[] = []
    for (let left = 0; left < rows.length; left++) {
      for (let right = left + 1; right < rows.length; right++) {
        agreements.push(jaccard(signature(rows[left]!), signature(rows[right]!)))
      }
    }
    if (agreements.length > 0) caseAgreements.push(mean(agreements))
  }
  return {
    value: caseAgreements.length === 0 ? null : mean(caseAgreements),
    cases: caseAgreements.length,
  }
}

function matchedLabelSignature(observation: AnalystBenchmarkObservation): readonly string[] {
  if (observation.error) return [`error:${observation.error.class}`]
  return observation.score.matchedIssueIds
}

function predictionSignature(observation: AnalystBenchmarkObservation): readonly string[] {
  if (observation.error) return [`error:${observation.error.class}`]
  return observation.findings
    .map((finding) =>
      JSON.stringify([
        finding.finding_id,
        finding.evidence_refs
          .map((evidence) => [evidence.kind, evidence.uri, evidence.excerpt ?? null])
          .sort((left, right) => compareCodeUnits(JSON.stringify(left), JSON.stringify(right))),
      ]),
    )
    .sort()
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  const union = new Set([...a, ...b])
  if (union.size === 0) return 1
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / union.size
}
