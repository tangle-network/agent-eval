import { describe, expect, it } from 'vitest'
import {
  assertReleaseConfidence,
  type DatasetManifest,
  evaluateReleaseConfidence,
  type MultiShotTrialResult,
  type RunRecord,
  releaseTraceEvidenceFromMultiShotTrials,
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
    costUsd: 0.01,
    tokenUsage: { input: 10, output: 20 },
    outcome: { ...score, raw: { score: Object.values(score)[0]! } },
    splitTag,
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

  it('accepts ASI projected from multi-shot trials and counts responsible surfaces', () => {
    const trials: MultiShotTrialResult[] = [
      {
        variantId: 'candidate',
        scenarioId: 'tax-hard',
        rep: 0,
        split: 'holdout',
        seed: 10,
        ok: false,
        score: 0.2,
        cost: 0.01,
        durationMs: 500,
        metrics: {},
        trace: { scenarioId: 'tax-hard', turns: [{ role: 'user' }, { role: 'assistant' }] },
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
      traces: releaseTraceEvidenceFromMultiShotTrials(trials),
      thresholds: {
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        minMeanScore: 0.1,
        minPassRate: 0.1,
      },
    })

    expect(scorecard.issues.map((i) => i.code)).not.toContain('missing_failure_asi')
    expect(scorecard.metrics.responsibleSurfaceCounts['tax-rubric']).toBe(1)
    expect(scorecard.metrics.multiShotTraces).toBe(1)
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
