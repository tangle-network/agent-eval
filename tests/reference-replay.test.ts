import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decideReferenceReplayPromotion,
  decideReferenceReplayRunPromotion,
  inMemoryReferenceReplayStore,
  jsonlReferenceReplayStore,
  type ReferenceReplayCase,
  type ReferenceReplayMatcher,
  type ReferenceReplayScenario,
  runReferenceReplay,
  scoreReferenceReplay,
} from '../src/reference-replay'
import {
  referenceReplayRunsToSteeringRows,
  referenceReplayScenarioToRunScore,
} from '../src/reference-replay-steering'

describe('reference replay', () => {
  it('scores hidden references after execution and keeps unmatched candidates as false positives', () => {
    const score = scoreReferenceReplay([
      {
        id: 'case-1',
        split: 'dev',
        references: [
          {
            id: 'r1',
            title: 'missing authorization on withdrawal',
            tags: ['auth'],
            severity: 'high',
          },
          { id: 'r2', title: 'stale oracle price accepted', tags: ['oracle'], severity: 'medium' },
        ],
        candidates: [
          { id: 'c1', title: 'withdrawal authorization bypass', tags: ['auth'], severity: 'high' },
          { id: 'c2', title: 'unrelated gas optimization', tags: ['gas'], severity: 'low' },
        ],
      },
    ])

    expect(score.aggregate.matched).toBe(1)
    expect(score.aggregate.total).toBe(2)
    expect(score.aggregate.falsePositives).toBe(1)
    expect(score.aggregate.precision).toBeCloseTo(0.5)
    expect(score.aggregate.recall).toBeCloseTo(0.5)
  })

  it('excludes holdout by default and includes it only when explicitly requested', () => {
    const scenarios = [
      scenario('train-case', 'train', true),
      scenario('holdout-case', 'holdout', true),
    ]

    expect(scoreReferenceReplay(scenarios).scenarios.map((s) => s.scenarioId)).toEqual([
      'train-case',
    ])
    expect(
      scoreReferenceReplay(scenarios, { includeHoldout: true }).scenarios.map((s) => s.scenarioId),
    ).toEqual(['train-case', 'holdout-case'])
  })

  it('uses greedy one-to-one matching so duplicate candidates do not inflate recall', () => {
    const score = scoreReferenceReplay([
      {
        id: 'case-1',
        split: 'dev',
        references: [
          { id: 'r1', title: 'unsafe callback reentrancy' },
          { id: 'r2', title: 'precision loss in fee accounting' },
        ],
        candidates: [
          { id: 'c1', title: 'unsafe callback reentrancy' },
          { id: 'c2', title: 'unsafe callback reentrancy duplicate' },
        ],
      },
    ])

    expect(score.scenarios[0].matched).toBe(1)
    expect(score.scenarios[0].falsePositives).toBe(1)
  })

  it('does not collapse duplicate candidate ids when counting false positives', () => {
    const score = scoreReferenceReplay([
      {
        id: 'case-1',
        split: 'dev',
        references: [{ id: 'r1', title: 'unsafe callback reentrancy' }],
        candidates: [
          { id: 'duplicate', title: 'unsafe callback reentrancy' },
          { id: 'duplicate', title: 'button label alignment issue' },
        ],
      },
    ])

    expect(score.scenarios[0].matched).toBe(1)
    expect(score.scenarios[0].falsePositives).toBe(1)
    expect(score.aggregate.precision).toBeCloseTo(0.5)
  })

  it('keeps reference-order matching as the default for compatibility', () => {
    const score = scoreReferenceReplay([ambiguousMatchingScenario()], {
      matcher: ambiguousMatcher,
    })

    expect(
      score.scenarios[0].matches.map((match) => [
        match.referenceId,
        match.candidateId,
        match.score,
      ]),
    ).toEqual([
      ['r1', 'c1', 0.7],
      ['r2', 'c2', 0.1],
    ])
    expect(score.scenarios[0].matched).toBe(1)
    expect(score.scenarios[0].falsePositives).toBe(1)
  })

  it('supports global greedy matching by pair score for public-audit replay', () => {
    const score = scoreReferenceReplay([ambiguousMatchingScenario()], {
      matcher: ambiguousMatcher,
      matchStrategy: 'global-greedy',
    })

    expect(
      score.scenarios[0].matches.map((match) => [
        match.referenceId,
        match.candidateId,
        match.score,
      ]),
    ).toEqual([
      ['r1', 'c2', 0.6],
      ['r2', 'c1', 0.95],
    ])
    expect(score.scenarios[0].matched).toBe(2)
    expect(score.scenarios[0].falsePositives).toBe(0)
  })

  it('does not collapse duplicate candidate ids under global greedy matching', () => {
    const score = scoreReferenceReplay(
      [
        {
          id: 'case-1',
          split: 'dev',
          references: [{ id: 'r1', title: 'unsafe callback reentrancy' }],
          candidates: [
            { id: 'duplicate', title: 'unsafe callback reentrancy' },
            { id: 'duplicate', title: 'button label alignment issue' },
          ],
        },
      ],
      {
        matchStrategy: 'global-greedy',
      },
    )

    expect(score.scenarios[0].matched).toBe(1)
    expect(score.scenarios[0].falsePositives).toBe(1)
    expect(score.aggregate.precision).toBeCloseTo(0.5)
  })

  it('rejects non-finite matcher scores', () => {
    expect(() =>
      scoreReferenceReplay(
        [
          {
            id: 'case-1',
            references: [{ id: 'r1', title: 'unsafe callback reentrancy' }],
            candidates: [{ id: 'c1', title: 'unsafe callback reentrancy' }],
          },
        ],
        {
          matcher: () => ({ score: Number.NaN }),
        },
      ),
    ).toThrow(/non-finite score/)
  })

  it('promotes only when required splits improve and holdout does not regress', () => {
    const baseline = scoreReferenceReplay(
      [
        scenario('dev-1', 'dev', false),
        scenario('test-1', 'test', false),
        scenario('holdout-1', 'holdout', true),
      ],
      { includeHoldout: true },
    )
    const candidate = scoreReferenceReplay(
      [
        scenario('dev-1', 'dev', true),
        scenario('test-1', 'test', true),
        scenario('holdout-1', 'holdout', true),
      ],
      { includeHoldout: true },
    )

    const decision = decideReferenceReplayPromotion(baseline, candidate, { minF1Delta: 0.1 })
    expect(decision.promote).toBe(true)
    expect(decision.regressions).toHaveLength(0)
  })

  it('rejects candidate variants that improve dev but regress holdout', () => {
    const baseline = scoreReferenceReplay(
      [scenario('dev-1', 'dev', false), scenario('holdout-1', 'holdout', true)],
      { includeHoldout: true },
    )
    const candidate = scoreReferenceReplay(
      [scenario('dev-1', 'dev', true), scenario('holdout-1', 'holdout', false)],
      { includeHoldout: true },
    )

    const decision = decideReferenceReplayPromotion(baseline, candidate, {
      requiredSplits: ['dev'],
      requireHoldoutNonRegression: true,
    })
    expect(decision.promote).toBe(false)
    expect(decision.reason).toMatch(/Regression in holdout/)
  })

  it('rejects promotion when required split coverage is missing from either side', () => {
    const baseline = scoreReferenceReplay(
      [scenario('train-1', 'train', false), scenario('holdout-1', 'holdout', true)],
      { includeHoldout: true },
    )
    const candidate = scoreReferenceReplay(
      [scenario('dev-1', 'dev', true), scenario('holdout-1', 'holdout', true)],
      { includeHoldout: true },
    )

    const decision = decideReferenceReplayPromotion(baseline, candidate, {
      requiredSplits: ['dev'],
      requireHoldoutNonRegression: true,
    })
    expect(decision.promote).toBe(false)
    expect(decision.reason).toBe('Required split missing from baseline or candidate: dev')
  })

  it('rejects promotion when holdout coverage is missing from either side', () => {
    const baseline = scoreReferenceReplay([scenario('dev-1', 'dev', false)], {
      includeHoldout: true,
    })
    const candidate = scoreReferenceReplay(
      [scenario('dev-1', 'dev', true), scenario('holdout-1', 'holdout', true)],
      { includeHoldout: true },
    )

    const decision = decideReferenceReplayPromotion(baseline, candidate, {
      requiredSplits: ['dev'],
      requireHoldoutNonRegression: true,
    })
    expect(decision.promote).toBe(false)
    expect(decision.reason).toBe('Holdout split is required for promotion')
  })

  it('runs adapters without exposing hidden references and persists full run records', async () => {
    const seen: unknown[] = []
    const store = inMemoryReferenceReplayStore<string>()
    const replayCases: ReferenceReplayCase<string>[] = [
      {
        id: 'case-1',
        split: 'dev',
        input: 'audit repo acme/vault',
        references: [{ id: 'r1', title: 'unchecked withdrawal authorization', tags: ['auth'] }],
        metadata: { repo: 'acme/vault' },
      },
    ]

    const run = await runReferenceReplay(replayCases, {
      runId: 'run-1',
      variantId: 'candidate-a',
      store,
      adapter: {
        async run(executionScenario) {
          seen.push(executionScenario)
          return [{ id: 'c1', title: 'withdrawal authorization is unchecked', tags: ['auth'] }]
        },
      },
      now: fixedClock([1000, 1010, 1020, 1030]),
    })

    expect(seen).toEqual([
      {
        id: 'case-1',
        split: 'dev',
        input: 'audit repo acme/vault',
        metadata: { repo: 'acme/vault' },
      },
    ])
    expect(run.id).toBe('run-1')
    expect(run.score.aggregate.matched).toBe(1)
    expect(run.cases[0].references).toEqual(replayCases[0].references)
    expect(await store.list()).toEqual([run])
  })

  it('records adapter failures as scored misses when continueOnError is enabled', async () => {
    const run = await runReferenceReplay(
      [
        {
          id: 'case-1',
          split: 'dev',
          input: { repo: 'acme/vault' },
          references: [{ id: 'r1', title: 'oracle accepts stale prices' }],
        },
      ],
      {
        runId: 'run-errors',
        continueOnError: true,
        adapter: {
          async run() {
            throw new Error('sandbox exited')
          },
        },
      },
    )

    expect(run.cases[0].error).toBe('sandbox exited')
    expect(run.score.aggregate.matched).toBe(0)
    expect(run.score.aggregate.total).toBe(1)
  })

  it('round-trips run records through jsonl storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reference-replay-'))
    try {
      const store = jsonlReferenceReplayStore<string>(join(dir, 'runs.jsonl'))
      const run = await runReferenceReplay(
        [
          {
            id: 'case-1',
            split: 'dev',
            input: 'audit repo',
            references: [{ id: 'r1', title: 'reentrancy in callback' }],
          },
        ],
        {
          runId: 'jsonl-run',
          store,
          adapter: {
            async run() {
              return [{ id: 'c1', title: 'callback reentrancy' }]
            },
          },
        },
      )

      expect(await store.list()).toEqual([run])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts function adapters for simple runners', async () => {
    const run = await runReferenceReplay(
      [
        {
          id: 'case-1',
          split: 'dev',
          input: 'audit repo',
          references: [{ id: 'r1', title: 'reentrancy in callback' }],
        },
      ],
      {
        runId: 'function-adapter',
        adapter: async () => [{ id: 'c1', title: 'callback reentrancy' }],
      },
    )

    expect(run.score.aggregate.matched).toBe(1)
  })

  it('does not convert aborts into scored misses', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop replay'))

    await expect(
      runReferenceReplay(
        [
          {
            id: 'case-1',
            split: 'dev',
            input: 'audit repo',
            references: [{ id: 'r1', title: 'reentrancy in callback' }],
          },
        ],
        {
          runId: 'aborted',
          continueOnError: true,
          abortSignal: controller.signal,
          adapter: async () => [{ id: 'c1', title: 'callback reentrancy' }],
        },
      ),
    ).rejects.toThrow('stop replay')
  })

  it('compares stored runs for promotion decisions', async () => {
    const baseline = await runReferenceReplay(
      [replayCase('dev-1', 'dev', false), replayCase('holdout-1', 'holdout', true)],
      {
        runId: 'baseline',
        includeHoldout: true,
        adapter: adapterFromMatchedFlag(),
      },
    )
    const candidate = await runReferenceReplay(
      [replayCase('dev-1', 'dev', true), replayCase('holdout-1', 'holdout', false)],
      {
        runId: 'candidate',
        includeHoldout: true,
        adapter: adapterFromMatchedFlag(),
      },
    )

    const decision = decideReferenceReplayRunPromotion(baseline, candidate, {
      requiredSplits: ['dev'],
      requireHoldoutNonRegression: true,
    })
    expect(decision.promote).toBe(false)
    expect(decision.reason).toBe('Regression in holdout')
  })

  it('maps reference replay runs into steering rows for variant selection', async () => {
    const run = await runReferenceReplay(
      [replayCase('dev-1', 'dev', true), replayCase('dev-2', 'dev', false)],
      {
        runId: 'variant-run',
        variantId: 'variant-a',
        adapter: adapterFromMatchedFlag(),
      },
    )

    const rows = referenceReplayRunsToSteeringRows([run])

    expect(rows).toHaveLength(2)
    expect(rows[0].variantId).toBe('variant-a')
    expect(rows[0].bundle.id).toBe('variant-a')
    expect(rows[0].metadata).toMatchObject({
      runId: 'variant-run',
      split: 'dev',
      matched: 1,
      total: 1,
      f1: 1,
    })
    expect(rows[0].score.success).toBe(1)
    expect(rows[1].score.success).toBe(0)
  })

  it('converts reference replay scenario scores into run scores with precision and recall retained', () => {
    const runScore = referenceReplayScenarioToRunScore(
      {
        scenarioId: 'case-1',
        split: 'dev',
        matched: 1,
        total: 2,
        falsePositives: 1,
        matchedWeight: 1,
        totalWeight: 2,
        precision: 0.5,
        recall: 0.5,
        f1: 0.5,
        matches: [],
      },
      1234,
    )

    expect(runScore.success).toBe(0.5)
    expect(runScore.goalProgress).toBe(0.5)
    expect(runScore.repoGroundedness).toBe(0.5)
    expect(runScore.wallSeconds).toBeCloseTo(1.234)
  })
})

function scenario(
  id: string,
  split: ReferenceReplayScenario['split'],
  matched: boolean,
): ReferenceReplayScenario {
  return {
    id,
    split,
    references: [
      { id: 'r1', title: 'admin can drain funds through unchecked transfer', tags: ['auth'] },
    ],
    candidates: matched
      ? [{ id: 'c1', title: 'unchecked transfer lets admin drain funds', tags: ['auth'] }]
      : [{ id: 'c1', title: 'button label alignment issue', tags: ['ui'] }],
  }
}

function replayCase(
  id: string,
  split: ReferenceReplayCase<{ matched: boolean }>['split'],
  matched: boolean,
): ReferenceReplayCase<{ matched: boolean }> {
  return {
    id,
    split,
    input: { matched },
    references: [
      { id: 'r1', title: 'admin can drain funds through unchecked transfer', tags: ['auth'] },
    ],
  }
}

function adapterFromMatchedFlag() {
  return {
    async run(testCase: { input: { matched: boolean } }) {
      return testCase.input.matched
        ? [{ id: 'c1', title: 'unchecked transfer lets admin drain funds', tags: ['auth'] }]
        : [{ id: 'c1', title: 'button label alignment issue', tags: ['ui'] }]
    },
  }
}

function ambiguousMatchingScenario(): ReferenceReplayScenario {
  return {
    id: 'ambiguous',
    split: 'dev',
    references: [
      { id: 'r1', title: 'reference one' },
      { id: 'r2', title: 'reference two' },
    ],
    candidates: [
      { id: 'c1', title: 'candidate one' },
      { id: 'c2', title: 'candidate two' },
    ],
  }
}

const ambiguousMatcher: ReferenceReplayMatcher = (reference, candidate) => {
  const scores: Record<string, number> = {
    'r1:c1': 0.7,
    'r1:c2': 0.6,
    'r2:c1': 0.95,
    'r2:c2': 0.1,
  }
  return { score: scores[`${reference.id}:${candidate.id}`] ?? 0 }
}

function fixedClock(values: number[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}
