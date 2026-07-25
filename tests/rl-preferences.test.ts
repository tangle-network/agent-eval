import { describe, expect, it } from 'vitest'
import { extractPreferences } from '../src/rl/preferences'
import type { RunRecord } from '../src/run-record'

function rec(args: {
  runId: string
  candidateId: string
  scenarioId: string
  seed: number
  score?: number
  splitTag?: RunRecord['splitTag']
  terminalOutcome?: RunRecord['terminalOutcome']
}): RunRecord {
  const splitTag = args.splitTag ?? 'search'
  return {
    runId: args.runId,
    experimentId: 'exp',
    candidateId: args.candidateId,
    seed: args.seed,
    model: 'm@1',
    promptHash: `p-${args.candidateId}`,
    configHash: `c-${args.candidateId}`,
    commitSha: 'abcd',
    wallMs: 100,
    costUsd: 0.01,
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 1, output: 1 },
    terminalOutcome: args.terminalOutcome ?? 'succeeded',
    outcome:
      args.score === undefined
        ? { raw: {} }
        : splitTag === 'holdout'
          ? { holdoutScore: args.score, raw: {} }
          : { searchScore: args.score, raw: {} },
    splitTag,
    scenarioId: args.scenarioId,
  }
}

describe('extractPreferences — paired-by-scenario-and-seed', () => {
  it('forms preferences from same (scenario, seed) cells with sufficient margin', () => {
    const runs: RunRecord[] = []
    for (const seed of [0, 1]) {
      for (const v of ['a', 'b', 'c']) {
        const score = v === 'a' ? 0.5 : v === 'b' ? 0.7 : 0.6
        runs.push(
          rec({
            runId: `${v}-${seed}`,
            candidateId: v,
            scenarioId: 's1',
            seed,
            score,
          }),
        )
      }
    }
    const report = extractPreferences(runs, {
      strategy: 'paired-by-scenario-and-seed',
      minMargin: 0.05,
    })
    // 3 candidates × 2 seeds × C(3,2)=3 pairs per cell = 6 pairs total
    expect(report.pairs.length).toBe(6)
    expect(report.pairs.every((p) => p.marginScore >= 0.05)).toBe(true)
    expect(report.pairs.every((p) => p.scores!.chosen >= p.scores!.rejected)).toBe(true)
  })

  it('drops pairs below minMargin and counts them in pairsBelowMargin', () => {
    const runs = [
      rec({ runId: 'a', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.5 }),
      rec({ runId: 'b', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.51 }),
    ]
    const report = extractPreferences(runs, {
      strategy: 'paired-by-scenario-and-seed',
      minMargin: 0.1,
    })
    expect(report.pairs).toHaveLength(0)
    expect(report.pairsBelowMargin).toBe(1)
  })

  it('counts singleton cells where no comparison is possible', () => {
    const runs = [rec({ runId: 'a', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.7 })]
    const report = extractPreferences(runs, { strategy: 'paired-by-scenario-and-seed' })
    expect(report.pairs).toHaveLength(0)
    expect(report.cellsSingleton).toBe(1)
  })
})

describe('extractPreferences — top-vs-bottom', () => {
  it('forms one pair per scenario from the highest- and lowest-scoring runs', () => {
    const runs: RunRecord[] = []
    for (const v of ['a', 'b', 'c']) {
      runs.push(
        rec({
          runId: `${v}-0`,
          candidateId: v,
          scenarioId: 's',
          seed: 0,
          score: v === 'a' ? 0.3 : v === 'b' ? 0.6 : 0.8,
        }),
      )
    }
    const report = extractPreferences(runs, { strategy: 'top-vs-bottom', minMargin: 0.05 })
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]?.chosenVariantId).toBe('c')
    expect(report.pairs[0]?.rejectedVariantId).toBe('a')
  })
})

describe('extractPreferences — paired-by-scenario', () => {
  it('aggregates across seeds and forms pairs from per-(variant, scenario) means', () => {
    const runs: RunRecord[] = [
      rec({ runId: 'a-0', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.5 }),
      rec({ runId: 'a-1', candidateId: 'a', scenarioId: 's', seed: 1, score: 0.6 }),
      rec({ runId: 'b-0', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.8 }),
      rec({ runId: 'b-1', candidateId: 'b', scenarioId: 's', seed: 1, score: 0.9 }),
    ]
    const report = extractPreferences(runs, { strategy: 'paired-by-scenario', minMargin: 0.05 })
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]?.marginScore).toBeCloseTo(0.3, 2) // (0.85 - 0.55) = 0.3
    expect(report.pairs[0]?.chosenVariantId).toBe('b')
  })
})

describe('extractPreferences — reward override', () => {
  it('uses rewardOf when supplied so preferences drive off a verifiable signal', () => {
    const runs = [
      rec({ runId: 'a', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.9 }),
      rec({ runId: 'b', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.5 }),
    ]
    // Headline score says A wins; reward override flips it.
    runs[0]!.outcome.raw.test_pass_rate = 0.3
    runs[1]!.outcome.raw.test_pass_rate = 0.95
    const report = extractPreferences(runs, {
      strategy: 'top-vs-bottom',
      minMargin: 0.1,
      rewardOf: (run) => run.outcome.raw.test_pass_rate ?? null,
    })
    expect(report.pairs[0]?.chosenVariantId).toBe('b')
    expect(report.pairs[0]?.rejectedVariantId).toBe('a')
  })
})

describe('extractPreferences — training-data selection', () => {
  it('defaults to positive, completed search runs', () => {
    const runs = [
      rec({ runId: 'search-a', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.9 }),
      rec({ runId: 'search-b', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.5 }),
      rec({
        runId: 'dev-a',
        candidateId: 'a',
        scenarioId: 'd',
        seed: 0,
        score: 0.8,
        splitTag: 'dev',
      }),
      rec({
        runId: 'dev-b',
        candidateId: 'b',
        scenarioId: 'd',
        seed: 0,
        score: 0.4,
        splitTag: 'dev',
      }),
      rec({
        runId: 'holdout-a',
        candidateId: 'a',
        scenarioId: 'h',
        seed: 0,
        score: 1,
        splitTag: 'holdout',
      }),
      rec({
        runId: 'holdout-b',
        candidateId: 'b',
        scenarioId: 'h',
        seed: 0,
        score: 0.1,
        splitTag: 'holdout',
      }),
      rec({ runId: 'zero', candidateId: 'c', scenarioId: 's', seed: 0, score: 0 }),
      rec({
        runId: 'failed',
        candidateId: 'd',
        scenarioId: 's',
        seed: 0,
        score: 1,
        terminalOutcome: 'failed',
      }),
    ]

    const report = extractPreferences(runs, { strategy: 'top-vs-bottom' })
    expect(report.pairs.map((pair) => pair.scenarioId)).toEqual(['s'])
    expect(report.pairs.flatMap((pair) => [pair.chosenRunId, pair.rejectedRunId])).not.toContain(
      'zero',
    )
  })

  it('requires the named override for held-out preference data', () => {
    const runs = [
      rec({
        runId: 'a',
        candidateId: 'a',
        scenarioId: 's',
        seed: 0,
        score: 0.9,
        splitTag: 'holdout',
      }),
      rec({
        runId: 'b',
        candidateId: 'b',
        scenarioId: 's',
        seed: 0,
        score: 0.5,
        splitTag: 'holdout',
      }),
    ]

    expect(() => extractPreferences(runs, { splitTag: 'holdout' })).toThrow(
      /allowHeldOutTrainingData: true/,
    )
    expect(
      extractPreferences(runs, {
        splitTag: 'holdout',
        allowHeldOutTrainingData: true,
      }).pairs,
    ).toHaveLength(1)
  })

  it('rejects dev as a training split', () => {
    expect(() => extractPreferences([], { splitTag: 'dev' })).toThrow(/evaluation-only/)
  })
})
