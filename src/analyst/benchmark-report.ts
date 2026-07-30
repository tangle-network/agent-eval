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
    '| Runner | Runs | Failed | Recall | Precision | F1 | Critical step | Citation coverage | Label-location agreement | Citation resolution | Resolution unknown runs | Unresolved citations | Resolution errors | Clean false positives | Clean failures | Repeat agreement | Latency min/mean/p50/p95/max ms | Calls | Input tokens | Output tokens | Reasoning tokens | Cached tokens | Cache-write tokens | Known cost USD | Unknown calls | Unknown input/output | Unknown reasoning | Unknown cached | Unknown cache-write | Unknown cost |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const summary of result.summaries) {
    lines.push(
      `| ${escapeCell(summary.runnerId)} | ${summary.completedRuns}/${summary.plannedRuns} | ${summary.failedRuns} | ${optionalRate(summary.issueRecall)} | ${optionalRate(summary.findingPrecision)} | ${optionalRate(summary.f1)} | ${optionalRate(summary.criticalStepAccuracy)} | ${optionalRate(summary.citationCoverage)} | ${optionalRate(summary.citationLabelAgreement)} | ${optionalRate(summary.citationResolution)} | ${summary.citationResolutionUnknownRuns} | ${summary.unresolvedCitations} | ${summary.citationResolutionErrors} | ${optionalRate(summary.cleanCaseFalsePositiveRate)} | ${optionalRate(summary.cleanCaseFailureRate)} | ${optionalRate(summary.runAgreement)} | ${latency(summary.latencyMs)} | ${summary.calls} | ${summary.inputTokens} | ${summary.outputTokens} | ${summary.reasoningTokens} | ${summary.cachedTokens} | ${summary.cacheWriteTokens} | ${summary.knownCostUsd.toFixed(6)} | ${summary.callsUnknownRuns} | ${summary.tokenUsageUnknownRuns} | ${summary.reasoningTokenUsageUnknownRuns} | ${summary.cachedTokenUsageUnknownRuns} | ${summary.cacheWriteTokenUsageUnknownRuns} | ${summary.costUnknownRuns} |`,
    )
  }

  for (const comparison of comparisons) {
    lines.push(
      '',
      `## ${escapeCell(comparison.candidateRunnerId)} compared with ${escapeCell(comparison.baselineRunnerId)}`,
      '',
      '| Metric | Better direction | Paired cases | Paired observations | Baseline mean | Candidate mean | Delta | Interval | At least 20 independent cases |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    )
    for (const metric of comparison.metrics) {
      lines.push(
        `| ${metric.metric} | ${metric.direction} | ${metric.pairedCases} | ${metric.pairedObservations} | ${number(metric.baselineMean)} | ${number(metric.candidateMean)} | ${signed(metric.meanDelta)} | [${number(metric.intervalLow)}, ${number(metric.intervalHigh)}] | ${metric.enoughCasesForInference ? 'yes' : 'no'} |`,
      )
    }
  }

  lines.push(
    '',
    '## Runs',
    '',
    '| Runner | Case | Tags | Case metadata | Runner metadata | Rep | Execution index | Completed | Recall | Precision | F1 | Critical step | Citation coverage | Label-location agreement | Citation resolution | Clean false positive | Findings | Unlabeled citations | Unresolved citations | Resolution errors | Latency ms | Calls | Input tokens | Output tokens | Reasoning tokens | Cached tokens | Cache-write tokens | Cost USD | Known cost USD | Cost source | Error class | Error |',
    '| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
  )
  for (const observation of result.observations) {
    const usage = observation.usage
    const cost = usage?.cost.kind === 'uncaptured' ? null : usage?.cost.usd
    lines.push(
      `| ${escapeCell(observation.runnerId)} | ${escapeCell(observation.caseId)} | ${escapeCell(observation.caseTags.join(', '))} | ${escapeCell(json(observation.caseMetadata))} | ${escapeCell(json(observation.runnerMetadata))} | ${observation.repetition} | ${observation.executionIndex} | ${observation.error ? 'no' : 'yes'} | ${rate(observation.score.issueRecall)} | ${rate(observation.score.findingPrecision)} | ${rate(observation.score.f1)} | ${optionalRate(observation.score.criticalStepAccuracy)} | ${optionalRate(observation.score.citationCoverage)} | ${optionalRate(observation.score.citationLabelAgreement)} | ${optionalRate(observation.evidenceResolution?.validity ?? null)} | ${observation.score.expectedIssueCount === 0 ? (observation.score.cleanFalsePositive ? 'yes' : 'no') : 'n/a'} | ${observation.score.supportedFindingIndexes.length}/${observation.findings.length} | ${observation.score.unlabeledEvidence.length} | ${observation.evidenceResolution?.unresolvedEvidence.length ?? 'unknown'} | ${observation.evidenceResolution?.errors.length ?? 'unknown'} | ${number(observation.latencyMs)} | ${usage?.calls ?? 'unknown'} | ${usage?.tokens?.input ?? 'unknown'} | ${usage?.tokens?.output ?? 'unknown'} | ${usage?.tokens?.reasoning ?? 'unknown'} | ${usage?.tokens?.cached ?? 'unknown'} | ${usage?.tokens?.cacheWrite ?? 'unknown'} | ${cost === null || cost === undefined ? 'unknown' : cost.toFixed(6)} | ${usage?.knownCostUsd?.toFixed(6) ?? (cost === null || cost === undefined ? 'unknown' : cost.toFixed(6))} | ${usage?.cost.kind ?? 'unknown'} | ${escapeCell(observation.error?.class ?? '')} | ${escapeCell(observation.error?.message ?? '')} |`,
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

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${number(value)}`
}

function latency(value: AnalystBenchmarkResult['summaries'][number]['latencyMs']): string {
  return [value.min, value.mean, value.p50, value.p95, value.max].map(number).join('/')
}

function json(value: unknown): string {
  return value === undefined ? 'uncaptured' : JSON.stringify(value)
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
