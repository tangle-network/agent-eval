import { describe, expect, it } from 'vitest'
import {
  assertReleaseConfidence,
  type DatasetManifest,
  evaluateReleaseConfidence,
  type ReleaseTraceEvidence,
  type RunRecord,
} from '../src/index'

const manifest: DatasetManifest = {
  name: 'company-agent-corpus',
  provenance: { version: '2026.05.03', createdAt: '2026-05-03T00:00:00Z' },
  contentHash: 'a'.repeat(64),
  scenarioCount: 6,
  splitCounts: { train: 2, dev: 1, test: 1, holdout: 2 },
}

function rec(overrides: Partial<RunRecord> = {}): RunRecord {
  const splitTag = overrides.splitTag ?? 'search'
  const costUsd = overrides.costUsd ?? 0.01
  const score = splitTag === 'holdout' ? { holdoutScore: 0.88 } : { searchScore: 0.9 }
  return {
    runId: `run-${splitTag}-${Math.random()}`,
    experimentId: 'scenario-a',
    candidateId: 'candidate',
    seed: 1,
    model: 'gpt-5.2@2026-01-01',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'deadbeef',
    wallMs: 1_000,
    costUsd,
    costProvenance:
      overrides.costProvenance ??
      (costUsd === null ? { kind: 'uncaptured', usd: null } : { kind: 'observed', usd: costUsd }),
    tokenUsage: { input: 10, output: 20 },
    terminalOutcome: 'succeeded',
    outcome: { ...score, raw: { score: Object.values(score)[0]! } },
    splitTag,
    scenarioId: 'scenario-a',
    ...overrides,
  }
}

describe('evaluateReleaseConfidence', () => {
  it('fails closed when corpus and run evidence are missing', () => {
    const scorecard = evaluateReleaseConfidence({ target: 'agent-builder' })

    expect(scorecard.status).toBe('fail')
    expect(scorecard.promote).toBe(false)
    expect(scorecard.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'missing_corpus',
        'few_scenarios',
        'missing_holdout_split',
        'few_search_runs',
        'few_holdout_runs',
        'missing_reliability_evidence',
      ]),
    )
  })

  it('passes a release with search, holdout, diagnostics, and budget evidence', () => {
    const runs = [
      rec({ splitTag: 'search', outcome: { searchScore: 0.91, raw: { score: 0.91 } } }),
      rec({ splitTag: 'search', outcome: { searchScore: 0.93, raw: { score: 0.93 } } }),
      rec({ splitTag: 'holdout', outcome: { holdoutScore: 0.88, raw: { score: 0.88 } } }),
      rec({ splitTag: 'holdout', outcome: { holdoutScore: 0.86, raw: { score: 0.86 } } }),
    ]

    const scorecard = evaluateReleaseConfidence({
      target: 'blueprint-agent/autoresearch',
      candidateId: 'candidate',
      dataset: manifest,
      runs,
      traces: [
        {
          scenarioId: 'one-shot',
          candidateId: 'candidate',
          split: 'search',
          score: 0.9,
          ok: true,
          turnCount: 1,
        },
        {
          scenarioId: 'multi-shot',
          candidateId: 'candidate',
          split: 'holdout',
          score: 0.86,
          ok: true,
          turnCount: 4,
        },
      ],
      thresholds: {
        minScenarioCount: 6,
        minSearchRuns: 2,
        minHoldoutRuns: 2,
        minPassRate: 0.8,
        minMeanScore: 0.8,
        maxMeanCostUsd: 0.02,
        maxP95WallMs: 2_000,
      },
    })

    expect(scorecard.status).toBe('pass')
    expect(scorecard.promote).toBe(true)
    expect(scorecard.metrics.singleShotTraces).toBe(1)
    expect(scorecard.metrics.multiShotTraces).toBe(1)
  })

  it('uses only the score matching each row split', () => {
    const crossed = evaluateReleaseConfidence({
      target: 'crossed-scores',
      dataset: manifest,
      runs: [
        rec({
          splitTag: 'search',
          outcome: { holdoutScore: 0.99, raw: { score: 0.99 } },
        }),
        rec({
          splitTag: 'holdout',
          outcome: { searchScore: 0.99, raw: { score: 0.99 } },
        }),
      ],
    })

    expect(crossed.metrics.searchRuns).toBe(0)
    expect(crossed.metrics.holdoutRuns).toBe(0)
    expect(crossed.metrics.meanScore).toBeNull()
    expect(crossed.metrics.passRate).toBeNull()
    expect(crossed.metrics.unscoredRuns).toBe(2)
    expect(crossed.promote).toBe(false)

    const conflicting = evaluateReleaseConfidence({
      target: 'conflicting-scores',
      dataset: manifest,
      runs: [
        rec({
          splitTag: 'search',
          outcome: { searchScore: 0.1, holdoutScore: 0.99, raw: { score: 0.99 } },
        }),
        rec({
          splitTag: 'holdout',
          outcome: { searchScore: 0.99, holdoutScore: 0.2, raw: { score: 0.99 } },
        }),
      ],
    })

    expect(conflicting.metrics.searchMeanScore).toBeCloseTo(0.1)
    expect(conflicting.metrics.holdoutMeanScore).toBeCloseTo(0.2)
    expect(conflicting.metrics.passRate).toBe(0)
    expect(conflicting.promote).toBe(false)
  })

  it('counts explicit task failures as failures even when their scores are high', () => {
    const scorecard = evaluateReleaseConfidence({
      target: 'explicit-task-failures',
      dataset: manifest,
      runs: [
        rec({
          splitTag: 'search',
          failureClass: 'reasoning_error',
          outcome: { searchScore: 0.99, raw: { score: 0.99, asi: 1 } },
        }),
        rec({
          splitTag: 'holdout',
          failureClass: 'instruction_following',
          failureMode: 'wrong_answer',
          outcome: { holdoutScore: 0.99, raw: { score: 0.99, asi: 1 } },
        }),
      ],
    })

    expect(scorecard.metrics.passRate).toBe(0)
    expect(scorecard.metrics.failedRows).toBe(2)
    expect(scorecard.metrics.failureClassCounts).toEqual({
      instruction_following: 1,
      reasoning_error: 1,
    })
    expect(scorecard.issues.map((issue) => issue.code)).toContain('low_pass_rate')
    expect(scorecard.promote).toBe(false)
  })

  it('requires ASI on failed low-score rows', () => {
    const scorecard = evaluateReleaseConfidence({
      target: 'gtm-agent',
      dataset: manifest,
      runs: [
        rec({ splitTag: 'search', outcome: { searchScore: 0.9, raw: { score: 0.9 } } }),
        rec({ splitTag: 'holdout', outcome: { holdoutScore: 0.4, raw: { score: 0.4 } } }),
      ],
      thresholds: {
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        minMeanScore: 0.1,
        minPassRate: 0.1,
      },
    })

    expect(scorecard.status).toBe('fail')
    expect(scorecard.issues.map((i) => i.code)).toContain('missing_failure_asi')
  })

  it('does not turn a recovered child error into a failed task result', () => {
    const scorecard = evaluateReleaseConfidence({
      target: 'recovered-tool-error',
      dataset: manifest,
      runs: [
        rec({
          splitTag: 'search',
          terminalOutcome: 'succeeded',
          outcome: { searchScore: 0.9, raw: { execution_error_count: 1 } },
        }),
        rec({
          splitTag: 'holdout',
          terminalOutcome: 'succeeded',
          outcome: { holdoutScore: 0.9, raw: {} },
        }),
      ],
      thresholds: { minSearchRuns: 1, minHoldoutRuns: 1 },
    })

    expect(scorecard.metrics.passRate).toBe(1)
    expect(scorecard.metrics.failedRows).toBe(0)
    expect(scorecard.metrics.failureClassCounts).toEqual({})
    expect(scorecard.status).toBe('pass')
  })

  it.each(['failed', 'cancelled', 'incomplete'] as const)(
    'keeps terminal outcome %s out of quality and fails reliability',
    (terminalOutcome) => {
      const measuredRuns = [
        rec({
          splitTag: 'search',
          terminalOutcome: 'succeeded',
          outcome: { searchScore: 0.9, raw: {} },
        }),
        rec({
          splitTag: 'holdout',
          terminalOutcome: 'succeeded',
          outcome: { holdoutScore: 0.9, raw: {} },
        }),
      ]
      const thresholds = {
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        minPassRate: 0,
        minMeanScore: 0,
        requireAsiForFailures: false,
      }
      const baseline = evaluateReleaseConfidence({
        target: 'successful-runs',
        dataset: manifest,
        runs: measuredRuns,
        thresholds,
      })
      const failed = evaluateReleaseConfidence({
        target: 'terminal-failure',
        dataset: manifest,
        runs: [
          ...measuredRuns,
          rec({
            splitTag: 'search',
            terminalOutcome,
            terminalFailureReason: 'worker crashed',
            outcome: { raw: {} },
          }),
        ],
        thresholds,
      })

      const baselineQuality = baseline.axes.find((axis) => axis.name === 'quality')
      const failedQuality = failed.axes.find((axis) => axis.name === 'quality')
      const failedReliability = failed.axes.find((axis) => axis.name === 'reliability')
      expect(failed.metrics.passRate).toBe(1)
      expect(failed.metrics.meanScore).toBe(0.9)
      expect(failed.metrics.failedRows).toBe(0)
      expect(failed.metrics.unscoredRuns).toBe(0)
      expect(failed.metrics.terminalFailureRuns).toBe(1)
      expect(failed.metrics.reliabilityRate).toBeCloseTo(2 / 3)
      expect(failed.metrics.failureClassCounts).toEqual({})
      expect(failedQuality).toEqual(baselineQuality)
      expect(failedQuality?.status).toBe('pass')
      expect(failedReliability?.status).toBe('fail')
      expect(failed.issues).toContainEqual(
        expect.objectContaining({ axis: 'reliability', code: 'terminal_run_failures' }),
      )
      expect(failed.issues.map((issue) => issue.code)).not.toContain('unscored_runs')
      expect(failed.promote).toBe(false)
    },
  )

  it('blocks a successful run without a task score', () => {
    const unscored = evaluateReleaseConfidence({
      target: 'unscored-success',
      dataset: manifest,
      runs: [
        rec({
          splitTag: 'search',
          terminalOutcome: 'succeeded',
          outcome: { raw: { execution_error_count: 1 } },
        }),
        rec({
          splitTag: 'holdout',
          terminalOutcome: 'succeeded',
          outcome: { holdoutScore: 0.9, raw: {} },
        }),
      ],
      thresholds: {
        minSearchRuns: 0,
        minHoldoutRuns: 1,
        minPassRate: 0,
        minMeanScore: 0,
      },
    })
    expect(unscored.metrics.unscoredRuns).toBe(1)
    expect(unscored.metrics.failedRows).toBe(0)
    expect(unscored.issues.map((issue) => issue.code)).toContain('unscored_runs')
    expect(unscored.promote).toBe(false)
  })

  it('represents absent quality and generalization measurements as JSON-safe nulls', () => {
    const scorecard = evaluateReleaseConfidence({
      target: 'no-quality-labels',
      dataset: manifest,
      runs: [
        rec({
          splitTag: 'search',
          terminalOutcome: 'succeeded',
          outcome: { raw: { execution_error_count: 1 } },
        }),
        rec({
          splitTag: 'holdout',
          terminalOutcome: 'succeeded',
          outcome: { raw: {} },
        }),
      ],
      thresholds: {
        minSearchRuns: 0,
        minHoldoutRuns: 0,
        minPassRate: 0,
        minMeanScore: 0,
        requireHoldout: false,
      },
    })

    expect(scorecard.metrics.passRate).toBeNull()
    expect(scorecard.metrics.meanScore).toBeNull()
    expect(scorecard.metrics.searchMeanScore).toBeNull()
    expect(scorecard.metrics.holdoutMeanScore).toBeNull()
    expect(scorecard.metrics.overfitGap).toBeNull()
    expect(scorecard.issues.map((issue) => issue.code)).toContain('missing_quality_scores')
    expect(scorecard.promote).toBe(false)
    expect(scorecard.axes.find((axis) => axis.name === 'quality')?.score).toBeNull()
    expect(scorecard.axes.find((axis) => axis.name === 'generalization')?.score).toBeNull()

    const serialized = JSON.parse(JSON.stringify(scorecard)) as typeof scorecard
    expect(serialized.metrics.meanScore).toBeNull()
    expect(serialized.axes.find((axis) => axis.name === 'quality')?.score).toBeNull()
    expect(serialized.axes.find((axis) => axis.name === 'generalization')?.score).toBeNull()
  })

  it('does not average an uncaptured cost sentinel as measured zero', () => {
    const scorecard = evaluateReleaseConfidence({
      target: 'missing-cost',
      dataset: manifest,
      runs: [
        rec({
          splitTag: 'search',
          costUsd: null,
          costProvenance: { kind: 'uncaptured', usd: null },
        }),
        rec({
          splitTag: 'holdout',
          costUsd: null,
          costProvenance: { kind: 'uncaptured', usd: null },
        }),
      ],
      thresholds: {
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        maxMeanCostUsd: 1,
      },
    })

    expect(scorecard.metrics.meanCostUsd).toBeNull()
    expect(scorecard.issues.map((issue) => issue.code)).toContain('missing_cost')
  })

  it('does not double-count trace summaries when run rows are present', () => {
    const scorecard = evaluateReleaseConfidence({
      target: 'deduplicated-measurements',
      dataset: manifest,
      runs: [
        rec({ splitTag: 'search', costUsd: 0.1, wallMs: 100 }),
        rec({ splitTag: 'holdout', costUsd: 0.1, wallMs: 100 }),
      ],
      traces: [
        {
          scenarioId: 'duplicate-summary',
          candidateId: 'candidate',
          ok: false,
          costUsd: 0.9,
          durationMs: 9_000,
        },
      ],
      thresholds: { minSearchRuns: 1, minHoldoutRuns: 1 },
    })

    expect(scorecard.metrics.meanCostUsd).toBeCloseTo(0.1)
    expect(scorecard.metrics.p95WallMs).toBe(100)
    expect(scorecard.metrics.passRate).toBe(1)
  })

  it('accepts ASI trace evidence and counts responsible surfaces', () => {
    const traces: ReleaseTraceEvidence[] = [
      {
        scenarioId: 'tax-hard',
        candidateId: 'candidate',
        split: 'holdout',
        score: 0.2,
        ok: false,
        failureClass: 'bad_retrieval',
        turnCount: 2,
        costUsd: 0.01,
        durationMs: 500,
        asi: [
          {
            message: 'Missed filing-state constraint.',
            responsibleSurface: 'tax-rubric',
            severity: 'error',
          },
        ],
      },
    ]

    const scorecard = evaluateReleaseConfidence({
      target: 'tax-agent',
      candidateId: 'candidate',
      dataset: manifest,
      runs: [
        rec({ splitTag: 'search', outcome: { searchScore: 0.9, raw: { score: 0.9 } } }),
        rec({ splitTag: 'holdout', outcome: { holdoutScore: 0.8, raw: { score: 0.8 } } }),
      ],
      traces,
      thresholds: {
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        minMeanScore: 0.1,
        minPassRate: 0.1,
      },
    })

    expect(scorecard.issues.map((i) => i.code)).not.toContain('missing_failure_asi')
    expect(scorecard.metrics.responsibleSurfaceCounts['tax-rubric']).toBe(1)
    expect(scorecard.metrics.failureClassCounts).toEqual({ bad_retrieval: 1 })
    expect(scorecard.metrics.multiShotTraces).toBe(1)
  })

  it('rejects the removed free-form trace failure mode', () => {
    expect(() =>
      evaluateReleaseConfidence({
        target: 'current-trace-contract',
        traces: [
          {
            scenarioId: 'legacy',
            failureMode: 'wrong-answer',
          } as unknown as ReleaseTraceEvidence,
        ],
        thresholds: {
          requireCorpus: false,
          requireHoldout: false,
          minScenarioCount: 0,
          minSearchRuns: 0,
          minHoldoutRuns: 0,
          requireAsiForFailures: false,
        },
      }),
    ).toThrow(/failureMode is not supported/)
  })

  it('uses explicit trace results for reliability when run rows are absent', () => {
    const scorecard = evaluateReleaseConfidence({
      target: 'trace-only',
      dataset: manifest,
      traces: [
        {
          scenarioId: 'search',
          split: 'search',
          score: 0.9,
          ok: true,
        },
        {
          scenarioId: 'holdout',
          split: 'holdout',
          score: 0.8,
          ok: true,
        },
      ],
      thresholds: {
        minSearchRuns: 0,
        minHoldoutRuns: 0,
        requireHoldout: false,
      },
    })

    expect(scorecard.metrics.reliabilityRate).toBe(1)
    expect(scorecard.metrics.terminalFailureRuns).toBe(0)
    expect(scorecard.issues.map((issue) => issue.code)).not.toContain(
      'missing_reliability_evidence',
    )
  })

  it('fails on cost, latency, and overfit budget breaches', () => {
    const scorecard = evaluateReleaseConfidence({
      target: 'agent-builder',
      dataset: manifest,
      runs: [
        rec({
          splitTag: 'search',
          wallMs: 5_000,
          costUsd: 0.2,
          outcome: { searchScore: 0.99, raw: { score: 0.99 } },
        }),
        rec({
          splitTag: 'holdout',
          wallMs: 4_000,
          costUsd: 0.2,
          outcome: { holdoutScore: 0.7, raw: { score: 0.7 } },
        }),
      ],
      thresholds: {
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        minPassRate: 0.5,
        minMeanScore: 0.5,
        maxOverfitGap: 0.1,
        maxMeanCostUsd: 0.05,
        maxP95WallMs: 2_000,
      },
    })

    expect(scorecard.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['overfit_gap', 'cost_budget', 'latency_budget']),
    )
  })

  it('throws with the scorecard summary in assert mode', () => {
    expect(() => assertReleaseConfidence({ target: 'missing' })).toThrow(/release confidence fail/)
  })
})
