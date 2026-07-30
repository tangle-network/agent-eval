import { describe, expect, it } from 'vitest'
import type { AnalystBenchmarkResult } from './benchmark'
import { compareAnalystRunners } from './benchmark-comparison'
import { renderAnalystBenchmarkMarkdown } from './benchmark-report'

function result(): AnalystBenchmarkResult {
  const observations = ['baseline', 'candidate'].flatMap((runnerId) =>
    ['bad', 'clean'].map((caseId, repetition) => ({
      runnerId,
      caseId,
      repetition,
      executionIndex: repetition,
      latencyMs: runnerId === 'baseline' ? 20 : 10,
      findings: [],
      caseTags: [caseId],
      caseMetadata: { source: 'fixture' },
      runnerMetadata: { runner: runnerId },
      score: {
        expectedIssueCount: caseId === 'bad' ? 1 : 0,
        matchedIssueIds: runnerId === 'candidate' && caseId === 'bad' ? ['issue'] : [],
        missedIssueIds: runnerId === 'candidate' || caseId === 'clean' ? [] : ['issue'],
        supportedFindingIndexes: runnerId === 'candidate' && caseId === 'bad' ? [0] : [],
        unsupportedFindingIndexes: [],
        unlabeledEvidence: [],
        issueRecall: runnerId === 'candidate' || caseId === 'clean' ? 1 : 0,
        findingPrecision: runnerId === 'candidate' || caseId === 'clean' ? 1 : 0,
        f1: runnerId === 'candidate' || caseId === 'clean' ? 1 : 0,
        criticalStepAccuracy: caseId === 'bad' ? (runnerId === 'candidate' ? 1 : 0) : null,
        citationCoverage: caseId === 'bad' ? (runnerId === 'candidate' ? 1 : 0) : null,
        citationLabelAgreement: caseId === 'bad' ? (runnerId === 'candidate' ? 1 : 0) : null,
        cleanFalsePositive: false,
      },
      usage: {
        calls: 1,
        tokens: { input: 10, output: 2, reasoning: 1, cached: 3, cacheWrite: 4 },
        cost: { kind: 'observed' as const, usd: 0.001 },
      },
    })),
  )
  return {
    provenance: {
      id: 'fixture',
      dataset: { id: 'fixture-data', revision: 'abc123', split: 'test' },
      startedAt: '2026-07-29T00:00:00.000Z',
      endedAt: '2026-07-29T00:00:01.000Z',
      caseCount: 2,
      runnerIds: ['baseline', 'candidate'],
      repetitions: 1,
      maxConcurrency: 1,
      runnerOrderSeed: 0,
    },
    observations,
    summaries: ['baseline', 'candidate'].map((runnerId) => ({
      runnerId,
      plannedRuns: 2,
      completedRuns: 2,
      failedRuns: 0,
      issueRecall: runnerId === 'candidate' ? 1 : 0,
      findingPrecision: runnerId === 'candidate' ? 1 : 0,
      f1: runnerId === 'candidate' ? 1 : 0,
      criticalStepAccuracy: runnerId === 'candidate' ? 1 : 0,
      citationCoverage: runnerId === 'candidate' ? 1 : 0,
      citationLabelAgreement: runnerId === 'candidate' ? 1 : 0,
      citationResolution: null,
      citationResolutionUnknownRuns: 0,
      unresolvedCitations: 0,
      citationResolutionErrors: 0,
      cleanCaseFalsePositiveRate: 0,
      cleanCaseFailureRate: 0,
      runAgreement: null,
      latencyMs: { min: 10, mean: 10, p50: 10, p95: 10, max: 10 },
      calls: 2,
      callsUnknownRuns: 0,
      inputTokens: 20,
      outputTokens: 4,
      reasoningTokens: 2,
      cachedTokens: 6,
      cacheWriteTokens: 8,
      tokenUsageUnknownRuns: 0,
      reasoningTokenUsageUnknownRuns: 0,
      cachedTokenUsageUnknownRuns: 0,
      cacheWriteTokenUsageUnknownRuns: 0,
      knownCostUsd: 0.002,
      costUnknownRuns: 0,
    })),
  }
}

describe('compareAnalystRunners', () => {
  it('pairs the same case and repetition and keeps quality, reliability, and cost separate', () => {
    const benchmark = result()
    const comparison = compareAnalystRunners(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })
    expect(comparison.metrics.find((metric) => metric.metric === 'f1')).toMatchObject({
      pairedCases: 1,
      pairedObservations: 1,
      baselineMean: 0,
      candidateMean: 1,
      meanDelta: 1,
      enoughCasesForInference: false,
    })
    expect(comparison.metrics.find((metric) => metric.metric === 'latencyMs')).toMatchObject({
      pairedCases: 2,
      pairedObservations: 2,
      baselineMean: 20,
      candidateMean: 10,
      meanDelta: -10,
      direction: 'lower',
    })
  })

  it('counts failed runs as zero quality instead of scoring only survivors', () => {
    const benchmark = result()
    const failed = benchmark.observations.find(
      (observation) => observation.runnerId === 'candidate' && observation.caseId === 'bad',
    )!
    failed.error = { class: 'Error', message: 'analysis failed' }

    const comparison = compareAnalystRunners(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })

    expect(comparison.metrics.find((metric) => metric.metric === 'completion')).toMatchObject({
      pairedCases: 2,
      pairedObservations: 2,
      candidateMean: 0.5,
    })
    expect(comparison.metrics.find((metric) => metric.metric === 'f1')).toMatchObject({
      pairedCases: 1,
      pairedObservations: 1,
      candidateMean: 0,
    })
  })

  it('resamples independent cases instead of treating repetitions as new evidence', () => {
    const benchmark = result()
    const badRows = benchmark.observations.filter((observation) => observation.caseId === 'bad')
    benchmark.observations = badRows.flatMap((observation) =>
      Array.from({ length: 20 }, (_, repetition) => ({
        ...observation,
        repetition,
        executionIndex: repetition * 2 + (observation.runnerId === 'candidate' ? 1 : 0),
      })),
    )
    benchmark.provenance.caseCount = 1
    benchmark.provenance.repetitions = 20

    const comparison = compareAnalystRunners(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })

    expect(comparison.metrics.find((metric) => metric.metric === 'f1')).toMatchObject({
      pairedCases: 1,
      pairedObservations: 20,
      enoughCasesForInference: false,
    })
  })

  it('renders every summary and run field without hiding unknown values', () => {
    const benchmark = result()
    const report = renderAnalystBenchmarkMarkdown(benchmark, [
      compareAnalystRunners(benchmark, {
        baselineRunnerId: 'baseline',
        candidateRunnerId: 'candidate',
        resamples: 100,
      }),
    ])
    expect(report).toContain('Citation coverage')
    expect(report).toContain('At least 20 independent cases')
    expect(report).toContain('| candidate | bad |')
    expect(report).toContain('| Dataset revision | abc123 |')
    expect(report).toContain('| Reasoning tokens |')
    expect(report).toContain('{"source":"fixture"}')

    const tables = report
      .split('\n\n')
      .map((block) => block.split('\n').filter((line) => line.startsWith('|')))
      .filter((rows) => rows.length > 0)
    for (const rows of tables) {
      expect(new Set(rows.map(unescapedPipeCount)).size).toBe(1)
    }
  })
})

function unescapedPipeCount(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '|' && value[index - 1] !== '\\') count += 1
  }
  return count
}
