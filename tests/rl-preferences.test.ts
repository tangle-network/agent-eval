import { describe, expect, it } from 'vitest'
import { extractPreferences } from '../src/rl/preferences'
import { fixtureRolloutLine } from '../src/rollout/fixtures'
import type { MintedRolloutLine, RolloutSplit } from '../src/rollout/schema'

const BASE = fixtureRolloutLine()

function line(args: {
  runId: string
  candidateId: string
  scenarioId: string
  seed: number
  score?: number
  split?: RolloutSplit
  completed?: boolean
}): MintedRolloutLine {
  const score = args.score ?? null
  return fixtureRolloutLine({
    rollout_id: args.runId,
    run_id: args.runId,
    candidate_id: args.candidateId,
    task: {
      ...BASE.task,
      instance_id: args.scenarioId,
      seed: args.seed,
      split: args.split ?? 'search',
    },
    policy: {
      ...BASE.policy,
      prompt_hash: `p-${args.candidateId}`,
      config_hash: `c-${args.candidateId}`,
    },
    outcome: {
      ...BASE.outcome,
      reward: score,
      reward_source: score === null ? 'test/unscored' : 'test/reward',
      is_completed: args.completed ?? true,
      error: args.completed === false ? 'run failed' : null,
    },
  })
}

describe('extractPreferences: paired by scenario and seed', () => {
  it('forms all pairs with sufficient margin inside matched cells', () => {
    const lines: MintedRolloutLine[] = []
    for (const seed of [0, 1]) {
      for (const candidateId of ['a', 'b', 'c']) {
        const score = candidateId === 'a' ? 0.5 : candidateId === 'b' ? 0.7 : 0.6
        lines.push(
          line({
            runId: `${candidateId}-${seed}`,
            candidateId,
            scenarioId: 's1',
            seed,
            score,
          }),
        )
      }
    }

    const report = extractPreferences(lines, {
      strategy: 'paired-by-scenario-and-seed',
      minMargin: 0.05,
    })

    expect(report.pairs).toHaveLength(6)
    expect(report.pairs.every((pair) => pair.marginScore >= 0.05)).toBe(true)
    expect(report.pairs.every((pair) => pair.scores!.chosen >= pair.scores!.rejected)).toBe(true)
  })

  it('counts pairs below the minimum margin', () => {
    const lines = [
      line({ runId: 'a', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.5 }),
      line({ runId: 'b', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.51 }),
    ]

    const report = extractPreferences(lines, {
      strategy: 'paired-by-scenario-and-seed',
      minMargin: 0.1,
    })

    expect(report.pairs).toHaveLength(0)
    expect(report.pairsBelowMargin).toBe(1)
  })

  it('counts singleton cells', () => {
    const report = extractPreferences(
      [line({ runId: 'a', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.7 })],
      { strategy: 'paired-by-scenario-and-seed' },
    )

    expect(report.pairs).toHaveLength(0)
    expect(report.cellsSingleton).toBe(1)
  })
})

describe('extractPreferences: other strategies', () => {
  it('forms one top-vs-bottom pair per scenario', () => {
    const lines = ['a', 'b', 'c'].map((candidateId) =>
      line({
        runId: `${candidateId}-0`,
        candidateId,
        scenarioId: 's',
        seed: 0,
        score: candidateId === 'a' ? 0.3 : candidateId === 'b' ? 0.6 : 0.8,
      }),
    )

    const report = extractPreferences(lines, { strategy: 'top-vs-bottom', minMargin: 0.05 })

    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]?.chosenVariantId).toBe('c')
    expect(report.pairs[0]?.rejectedVariantId).toBe('a')
  })

  it('aggregates candidate scores across seeds', () => {
    const lines = [
      line({ runId: 'a-0', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.5 }),
      line({ runId: 'a-1', candidateId: 'a', scenarioId: 's', seed: 1, score: 0.6 }),
      line({ runId: 'b-0', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.8 }),
      line({ runId: 'b-1', candidateId: 'b', scenarioId: 's', seed: 1, score: 0.9 }),
    ]

    const report = extractPreferences(lines, {
      strategy: 'paired-by-scenario',
      minMargin: 0.05,
    })

    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]?.marginScore).toBeCloseTo(0.3, 2)
    expect(report.pairs[0]?.chosenVariantId).toBe('b')
  })
})

describe('extractPreferences: training selection', () => {
  it('uses completed scored search lines by default', () => {
    const lines = [
      line({ runId: 'search-a', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.9 }),
      line({ runId: 'search-b', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.5 }),
      line({
        runId: 'dev-a',
        candidateId: 'a',
        scenarioId: 'd',
        seed: 0,
        score: 0.8,
        split: 'dev',
      }),
      line({
        runId: 'holdout-a',
        candidateId: 'a',
        scenarioId: 'h',
        seed: 0,
        score: 1,
        split: 'holdout',
      }),
      line({ runId: 'unscored', candidateId: 'c', scenarioId: 's', seed: 0 }),
      line({
        runId: 'failed',
        candidateId: 'd',
        scenarioId: 's',
        seed: 0,
        score: 1,
        completed: false,
      }),
    ]

    const report = extractPreferences(lines, { strategy: 'top-vs-bottom' })

    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]?.chosenRunId).toBe('search-a')
    expect(report.pairs[0]?.rejectedRunId).toBe('search-b')
  })

  it('requires explicit consent for held-out preference data', () => {
    const lines = [
      line({
        runId: 'a',
        candidateId: 'a',
        scenarioId: 's',
        seed: 0,
        score: 0.9,
        split: 'holdout',
      }),
      line({
        runId: 'b',
        candidateId: 'b',
        scenarioId: 's',
        seed: 0,
        score: 0.5,
        split: 'holdout',
      }),
    ]

    expect(() => extractPreferences(lines, { split: 'holdout' })).toThrow(
      /allowHeldOutTrainingData: true/,
    )
    expect(
      extractPreferences(lines, {
        split: 'holdout',
        allowHeldOutTrainingData: true,
      }).pairs,
    ).toHaveLength(1)
  })

  it.each(['dev', 'canary'] as const)('rejects the %s evaluation split', (split) => {
    expect(() => extractPreferences([], { split })).toThrow(/evaluation-only/)
  })
})
