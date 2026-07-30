import { describe, expect, it } from 'vitest'
import type { AnalystBenchmarkResult } from './benchmark'
import { compareAnalystRunners } from './benchmark-comparison'
import { renderAnalystBenchmarkMarkdown } from './benchmark-report'
import { compareAnalystRunners as compareAnalystRunnersPublic } from './index'
import { makeFinding } from './types'

function result(): AnalystBenchmarkResult {
  const observations = ['baseline', 'candidate'].flatMap((runnerId) =>
    ['bad', 'clean'].map((caseId, repetition) => {
      const isSupportedCandidate = runnerId === 'candidate' && caseId === 'bad'
      return {
        runnerId,
        caseId,
        clusterId: caseId,
        labelState: caseId === 'bad' ? ('positive' as const) : ('trusted-negative' as const),
        repetition,
        executionIndex: repetition,
        latencyMs: runnerId === 'baseline' ? 20 : 10,
        latencySource: 'benchmark-clock' as const,
        findings: isSupportedCandidate
          ? [
              makeFinding({
                analyst_id: 'fixture',
                area: 'failure-mode',
                subject: 'failure-mode:tool-failure',
                claim: 'The tool failed',
                severity: 'high',
                confidence: 1,
                evidence_refs: [
                  {
                    kind: 'span',
                    uri: 'trace://bad/span/step-1',
                    excerpt: 'failed',
                  },
                ],
              }),
            ]
          : [],
        caseTags: [caseId],
        caseMetadata: { source: 'fixture' },
        runnerMetadata: { runner: runnerId },
        score: {
          expectedIssueCount: caseId === 'bad' ? 1 : 0,
          matchedIssueIds: isSupportedCandidate ? ['issue'] : [],
          missedIssueIds: runnerId === 'candidate' || caseId === 'clean' ? [] : ['issue'],
          supportedFindingIndexes: isSupportedCandidate ? [0] : [],
          unsupportedFindingIndexes: [],
          unlabeledEvidence: [],
          issueRecall: runnerId === 'candidate' || caseId === 'clean' ? 1 : 0,
          findingPrecision: runnerId === 'candidate' || caseId === 'clean' ? 1 : 0,
          f1: runnerId === 'candidate' || caseId === 'clean' ? 1 : 0,
          criticalStepAccuracy: caseId === 'bad' ? (runnerId === 'candidate' ? 1 : 0) : null,
          citationCoverage: caseId === 'bad' ? (runnerId === 'candidate' ? 1 : 0) : null,
          citationExcerptCoverage: caseId === 'bad' ? (runnerId === 'candidate' ? 1 : 0) : null,
          citationLabelAgreement: caseId === 'bad' ? (runnerId === 'candidate' ? 1 : 0) : null,
          predictionOnLabelEmptyCase: false,
        },
        usage: {
          calls: 1,
          tokens: { input: 10, output: 2, reasoning: 1, cached: 3, cacheWrite: 4 },
          cost: { kind: 'observed' as const, usd: 0.001 },
        },
      }
    }),
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
      metadata: { populationRepresentativenessProven: true },
    },
    observations,
    summaries: ['baseline', 'candidate'].map((runnerId) => ({
      runnerId,
      plannedRuns: 2,
      completedRuns: 2,
      failedRuns: 0,
      issueBearingRuns: 1,
      trustedNegativeRuns: 1,
      unlabeledRuns: 0,
      issueRecall: runnerId === 'candidate' ? 1 : 0,
      findingPrecision: runnerId === 'candidate' ? 1 : 0,
      f1: runnerId === 'candidate' ? 1 : 0,
      macroIssueRecall: runnerId === 'candidate' ? 1 : 0,
      macroFindingPrecision: runnerId === 'candidate' ? 1 : 0,
      macroF1: runnerId === 'candidate' ? 1 : 0,
      criticalStepAccuracy: runnerId === 'candidate' ? 1 : 0,
      citationCoverage: runnerId === 'candidate' ? 1 : 0,
      citationExcerptCoverage: runnerId === 'candidate' ? 1 : 0,
      citationLabelAgreement: runnerId === 'candidate' ? 1 : 0,
      citationResolution: null,
      citationResolutionUnknownRuns: 0,
      unresolvedCitations: 0,
      citationResolutionErrors: 0,
      trustedNegativeFalsePositiveRate: 0,
      trustedNegativeFailureRate: 0,
      unlabeledPredictionRate: null,
      unlabeledFailureRate: null,
      predictionAgreement: null,
      predictionAgreementCases: 0,
      matchedLabelAgreement: null,
      matchedLabelAgreementCases: 0,
      latencyMs: { min: 10, mean: 10, p50: 10, p95: 10, max: 10 },
      benchmarkClockLatencyRuns: 2,
      runnerReportedLatencyRuns: 0,
      latencyUnknownRuns: 0,
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
      minimumSampleMet: false,
    })
    expect(comparison.metrics.find((metric) => metric.metric === 'latencyMs')).toMatchObject({
      pairedCases: 2,
      pairedObservations: 2,
      baselineMean: 20,
      candidateMean: 10,
      meanDelta: -10,
      direction: 'lower',
    })
    expect(
      comparison.metrics.find((metric) => metric.metric === 'citationExcerptCoverage'),
    ).toMatchObject({
      pairedCases: 1,
      baselineMean: 0,
      candidateMean: 1,
      meanDelta: 1,
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

  it('does not invent critical-step measurements for failed cases without those labels', () => {
    const benchmark = result()
    for (const observation of benchmark.observations) {
      if (observation.caseId === 'clean') {
        observation.error = { class: 'Error', message: 'analysis failed' }
      }
    }

    const comparison = compareAnalystRunners(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })

    expect(
      comparison.metrics.find((metric) => metric.metric === 'criticalStepAccuracy'),
    ).toMatchObject({
      pairedCases: 1,
      pairedObservations: 1,
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
      minimumSampleMet: false,
    })
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s resample counts at the public comparison boundary', (_label, resamples) => {
    expect(() =>
      compareAnalystRunnersPublic(result(), {
        baselineRunnerId: 'baseline',
        candidateRunnerId: 'candidate',
        resamples,
      }),
    ).toThrow(
      'compareAnalystRunners: resamples must be a positive safe integer no greater than 1000000',
    )
  })

  it.each([
    ['zero', 0],
    ['one', 1],
    ['negative', -0.5],
    ['above one', 1.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s confidence at the public comparison boundary', (_label, confidence) => {
    expect(() =>
      compareAnalystRunnersPublic(result(), {
        baselineRunnerId: 'baseline',
        candidateRunnerId: 'candidate',
        confidence,
        resamples: 100,
      }),
    ).toThrow('compareAnalystRunners: confidence must be a finite number in (0,1)')
  })

  it('never returns non-finite numeric comparison fields', () => {
    const benchmark = result()
    benchmark.observations[0]!.latencyMs = Number.NaN

    expect(() =>
      compareAnalystRunnersPublic(benchmark, {
        baselineRunnerId: 'baseline',
        candidateRunnerId: 'candidate',
        resamples: 100,
      }),
    ).toThrow('compareAnalystRunners: latencyMs produced non-finite comparison output')
  })

  it('does not compare uncaptured latency as local import time', () => {
    const benchmark = result()
    benchmark.observations.find(
      (observation) => observation.runnerId === 'candidate' && observation.caseId === 'bad',
    )!.latencyMs = null

    const comparison = compareAnalystRunnersPublic(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })

    expect(comparison.metrics.find((metric) => metric.metric === 'latencyMs')).toMatchObject({
      pairedCases: 1,
      pairedClusters: 1,
      pairedObservations: 1,
      eligibleObservations: 2,
      baselineMissingObservations: 0,
      candidateMissingObservations: 1,
      asymmetricMissingObservations: 1,
      survivorOnly: true,
    })
  })

  it('counts cross-missing observations per paired repetition instead of netting them out', () => {
    const benchmark = result()
    benchmark.observations.find(
      (observation) => observation.runnerId === 'baseline' && observation.caseId === 'bad',
    )!.latencyMs = null
    benchmark.observations.find(
      (observation) => observation.runnerId === 'candidate' && observation.caseId === 'clean',
    )!.latencyMs = null

    const comparison = compareAnalystRunnersPublic(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })

    expect(comparison.metrics.find((metric) => metric.metric === 'latencyMs')).toMatchObject({
      eligibleObservations: 2,
      pairedObservations: 0,
      baselineMissingObservations: 1,
      candidateMissingObservations: 1,
      asymmetricMissingObservations: 2,
      survivorOnly: true,
    })
  })

  it('resamples shared source tasks as one independent cluster', () => {
    const benchmark = result()
    for (const observation of benchmark.observations) {
      observation.clusterId = 'shared-task'
    }

    const comparison = compareAnalystRunnersPublic(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })

    expect(comparison.metrics.find((metric) => metric.metric === 'completion')).toMatchObject({
      pairedCases: 2,
      pairedClusters: 1,
      pairedObservations: 2,
      minimumSampleMet: false,
    })
  })

  it('does not make population claims for a nonrepresentative selection', () => {
    const benchmark = result()
    benchmark.provenance.metadata = { populationRepresentativenessProven: false }

    const comparison = compareAnalystRunnersPublic(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })
    const f1 = comparison.metrics.find((metric) => metric.metric === 'f1')

    expect(f1).toMatchObject({
      populationInferenceEligible: false,
      inferenceLimitations: expect.arrayContaining(['population-representativeness-not-proven']),
    })
  })

  it('reports metrics with no usable pairs instead of dropping the dimension', () => {
    const benchmark = result()
    for (const observation of benchmark.observations) observation.usage = undefined

    const comparison = compareAnalystRunnersPublic(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })
    const cost = comparison.metrics.find((metric) => metric.metric === 'costUsd')

    expect(cost).toMatchObject({
      eligibleObservations: 2,
      pairedObservations: 0,
      pairedCases: 0,
      pairedClusters: 0,
      baselineMissingObservations: 2,
      candidateMissingObservations: 2,
      baselineMean: null,
      candidateMean: null,
      meanDelta: null,
      survivorOnly: true,
    })
  })

  it('counts an entirely missing runner row instead of dropping the case', () => {
    const benchmark = result()
    benchmark.observations = benchmark.observations.filter(
      (observation) => !(observation.runnerId === 'candidate' && observation.caseId === 'clean'),
    )

    const comparison = compareAnalystRunnersPublic(benchmark, {
      baselineRunnerId: 'baseline',
      candidateRunnerId: 'candidate',
      resamples: 100,
    })

    expect(comparison.metrics.find((metric) => metric.metric === 'completion')).toMatchObject({
      eligibleObservations: 2,
      pairedObservations: 1,
      candidateMissingObservations: 1,
      survivorOnly: true,
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
    expect(report).toContain('Quote coverage')
    expect(report).toContain('Independent clusters')
    expect(report).toContain('Population inference')
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
