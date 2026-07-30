import type { AnalystBenchmarkResult } from './benchmark'
import type { AnalystRunnerComparison } from './benchmark-comparison'

export function renderAnalystBenchmarkMarkdown(
  result: AnalystBenchmarkResult,
  comparisons: readonly AnalystRunnerComparison[] = [],
): string {
  const { provenance } = result
  const lines = [
    '# Trace analyst benchmark',
    '',
    '## Run',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Benchmark | ${escapeCell(provenance.id ?? 'unspecified')} |`,
    `| Dataset | ${escapeCell(provenance.dataset?.id ?? 'unspecified')} |`,
    `| Dataset revision | ${escapeCell(provenance.dataset?.revision ?? 'unspecified')} |`,
    `| Dataset split | ${escapeCell(provenance.dataset?.split ?? 'unspecified')} |`,
    `| Started | ${escapeCell(provenance.startedAt)} |`,
    `| Ended | ${escapeCell(provenance.endedAt)} |`,
    `| Cases | ${provenance.caseCount} |`,
    `| Runners | ${escapeCell(provenance.runnerIds.join(', '))} |`,
    `| Repetitions | ${provenance.repetitions} |`,
    `| Maximum concurrency | ${provenance.maxConcurrency} |`,
    `| Runner-order seed | ${provenance.runnerOrderSeed} |`,
    `| Command | ${escapeCell(provenance.command ?? 'uncaptured')} |`,
    `| Environment | ${escapeCell(json(provenance.environment))} |`,
    `| Metadata | ${escapeCell(json(provenance.metadata))} |`,
    '',
    '## Summary',
    '',
  ]
  lines.push(
    '| Runner | Runs | Failed | Issue-bearing | Trusted negatives | Unlabeled | Micro recall | Micro precision | Micro F1 | Macro recall | Macro precision | Macro F1 | Critical step | Citation coverage | Quote coverage | Label-location agreement | Citation resolution | Resolution unknown runs | Unresolved citations | Resolution errors | Trusted-negative false positives | Trusted-negative failures | Unlabeled prediction rate | Unlabeled failures | Prediction repeat | Prediction repeated cases | Matched-label repeat | Matched-label repeated cases | Latency min/mean/p50/p95/max ms | Locally timed runs | Runner-reported latency runs | Unknown latency | Calls | Input tokens | Output tokens | Reasoning tokens | Cached tokens | Cache-write tokens | Known cost USD | Unknown calls | Unknown input/output | Unknown reasoning | Unknown cached | Unknown cache-write | Unknown cost |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const summary of result.summaries) {
    lines.push(
      `| ${escapeCell(summary.runnerId)} | ${summary.completedRuns}/${summary.plannedRuns} | ${summary.failedRuns} | ${summary.issueBearingRuns} | ${summary.trustedNegativeRuns} | ${summary.unlabeledRuns} | ${optionalRate(summary.issueRecall)} | ${optionalRate(summary.findingPrecision)} | ${optionalRate(summary.f1)} | ${optionalRate(summary.macroIssueRecall)} | ${optionalRate(summary.macroFindingPrecision)} | ${optionalRate(summary.macroF1)} | ${optionalRate(summary.criticalStepAccuracy)} | ${optionalRate(summary.citationCoverage)} | ${optionalRate(summary.citationExcerptCoverage)} | ${optionalRate(summary.citationLabelAgreement)} | ${optionalRate(summary.citationResolution)} | ${summary.citationResolutionUnknownRuns} | ${summary.unresolvedCitations} | ${summary.citationResolutionErrors} | ${optionalRate(summary.trustedNegativeFalsePositiveRate)} | ${optionalRate(summary.trustedNegativeFailureRate)} | ${optionalRate(summary.unlabeledPredictionRate)} | ${optionalRate(summary.unlabeledFailureRate)} | ${optionalRate(summary.predictionAgreement)} | ${summary.predictionAgreementCases} | ${optionalRate(summary.matchedLabelAgreement)} | ${summary.matchedLabelAgreementCases} | ${latency(summary.latencyMs)} | ${summary.benchmarkClockLatencyRuns} | ${summary.runnerReportedLatencyRuns} | ${summary.latencyUnknownRuns} | ${summary.calls} | ${summary.inputTokens} | ${summary.outputTokens} | ${summary.reasoningTokens} | ${summary.cachedTokens} | ${summary.cacheWriteTokens} | ${summary.knownCostUsd.toFixed(6)} | ${summary.callsUnknownRuns} | ${summary.tokenUsageUnknownRuns} | ${summary.reasoningTokenUsageUnknownRuns} | ${summary.cachedTokenUsageUnknownRuns} | ${summary.cacheWriteTokenUsageUnknownRuns} | ${summary.costUnknownRuns} |`,
    )
  }

  for (const comparison of comparisons) {
    lines.push(
      '',
      `## ${escapeCell(comparison.candidateRunnerId)} compared with ${escapeCell(comparison.baselineRunnerId)}`,
      '',
      '| Metric | Better direction | Paired cases | Independent clusters | Eligible observations | Paired observations | Missing baseline | Missing candidate | Missing asymmetry | Survivor-only | Baseline mean | Candidate mean | Delta | Interval | Minimum sample | Population inference | Limits |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- |',
    )
    for (const metric of comparison.metrics) {
      lines.push(
        `| ${metric.metric} | ${metric.direction} | ${metric.pairedCases} | ${metric.pairedClusters} | ${metric.eligibleObservations} | ${metric.pairedObservations} | ${metric.baselineMissingObservations} | ${metric.candidateMissingObservations} | ${metric.asymmetricMissingObservations} | ${metric.survivorOnly ? 'yes' : 'no'} | ${optionalMetricNumber(metric.baselineMean)} | ${optionalMetricNumber(metric.candidateMean)} | ${optionalSigned(metric.meanDelta)} | ${interval(metric.intervalLow, metric.intervalHigh)} | ${metric.minimumSampleMet ? 'yes' : 'no'} | ${metric.populationInferenceEligible ? 'yes' : 'no'} | ${escapeCell(metric.inferenceLimitations.join(', ') || 'none')} |`,
      )
    }
  }

  lines.push(
    '',
    '## Runs',
    '',
    '| Runner | Case | Cluster | Label state | Tags | Case metadata | Runner metadata | Rep | Execution index | Completed | Recall | Precision | F1 | Critical step | Citation coverage | Quote coverage | Label-location agreement | Citation resolution | Prediction on label-empty case | Scored findings | Diagnostic findings | Unlabeled citations | Unresolved citations | Resolution errors | Latency ms | Latency source | Calls | Input tokens | Output tokens | Reasoning tokens | Cached tokens | Cache-write tokens | Cost USD | Known cost USD | Cost source | Error class | Error |',
    '| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
  )
  for (const observation of result.observations) {
    const usage = observation.usage
    const cost = usage?.cost.kind === 'uncaptured' ? null : usage?.cost.usd
    const positive = observation.labelState === 'positive'
    lines.push(
      `| ${escapeCell(observation.runnerId)} | ${escapeCell(observation.caseId)} | ${escapeCell(observation.clusterId)} | ${observation.labelState} | ${escapeCell(observation.caseTags.join(', '))} | ${escapeCell(json(observation.caseMetadata))} | ${escapeCell(json(observation.runnerMetadata))} | ${observation.repetition} | ${observation.executionIndex} | ${observation.error ? 'no' : 'yes'} | ${positive ? rate(observation.score.issueRecall) : 'n/a'} | ${positive ? rate(observation.score.findingPrecision) : 'n/a'} | ${positive ? rate(observation.score.f1) : 'n/a'} | ${optionalRate(observation.score.criticalStepAccuracy)} | ${optionalRate(observation.score.citationCoverage)} | ${optionalRate(observation.score.citationExcerptCoverage)} | ${optionalRate(observation.score.citationLabelAgreement)} | ${optionalRate(observation.evidenceResolution?.validity ?? null)} | ${positive ? 'n/a' : observation.score.predictionOnLabelEmptyCase ? 'yes' : 'no'} | ${observation.score.supportedFindingIndexes.length}/${observation.error ? 0 : observation.findings.length} | ${observation.error ? observation.findings.length : 0} | ${observation.score.unlabeledEvidence.length} | ${observation.evidenceResolution?.unresolvedEvidence.length ?? 'unknown'} | ${observation.evidenceResolution?.errors.length ?? 'unknown'} | ${optionalNumber(observation.latencyMs)} | ${observation.latencySource} | ${usage?.calls ?? 'unknown'} | ${usage?.tokens?.input ?? 'unknown'} | ${usage?.tokens?.output ?? 'unknown'} | ${usage?.tokens?.reasoning ?? 'unknown'} | ${usage?.tokens?.cached ?? 'unknown'} | ${usage?.tokens?.cacheWrite ?? 'unknown'} | ${cost === null || cost === undefined ? 'unknown' : cost.toFixed(6)} | ${usage?.knownCostUsd?.toFixed(6) ?? (cost === null || cost === undefined ? 'unknown' : cost.toFixed(6))} | ${usage?.cost.kind ?? 'unknown'} | ${escapeCell(observation.error?.class ?? '')} | ${escapeCell(observation.error?.message ?? '')} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

function rate(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function optionalRate(value: number | null): string {
  return value === null ? 'n/a' : rate(value)
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3)
}

function optionalNumber(value: number | null): string {
  return value === null ? 'unknown' : number(value)
}

function optionalMetricNumber(value: number | null): string {
  return value === null ? 'n/a' : number(value)
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${number(value)}`
}

function optionalSigned(value: number | null): string {
  return value === null ? 'n/a' : signed(value)
}

function interval(low: number | null, high: number | null): string {
  return low === null || high === null ? 'n/a' : `[${number(low)}, ${number(high)}]`
}

function latency(value: AnalystBenchmarkResult['summaries'][number]['latencyMs']): string {
  if (value === null) return 'unknown'
  return [value.min, value.mean, value.p50, value.p95, value.max].map(number).join('/')
}

function json(value: unknown): string {
  return value === undefined ? 'uncaptured' : JSON.stringify(value)
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
