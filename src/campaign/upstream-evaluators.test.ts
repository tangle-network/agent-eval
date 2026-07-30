import { createEvaluator } from '@arizeai/phoenix-evals'
import { ExactMatch } from 'autoevals'
import { describe, expect, it } from 'vitest'
import type { Scenario } from './types'
import { autoevalsScorerJudge, phoenixEvaluatorJudge } from './upstream-evaluators'

interface ExpectedScenario extends Scenario {
  expected: string
}

const scenario: ExpectedScenario = { id: 'case-1', kind: 'text', expected: 'answer' }
const signal = new AbortController().signal

describe('phoenixEvaluatorJudge', () => {
  it('runs the installed Phoenix evaluator contract', async () => {
    const evaluator = createEvaluator<{ output: string; expected: string }>(
      ({ output, expected }) => ({
        score: output === expected ? 1 : 0,
        label: output === expected ? 'match' : 'mismatch',
      }),
      { name: 'exact-match', kind: 'CODE', telemetry: { isEnabled: false } },
    )
    const judge = phoenixEvaluatorJudge(evaluator, {
      mapInput: ({
        artifact,
        scenario: inputScenario,
      }: {
        artifact: string
        scenario: ExpectedScenario
      }) => ({ output: artifact, expected: inputScenario.expected }),
    })

    await expect(judge.score({ artifact: 'answer', scenario, signal })).resolves.toMatchObject({
      dimensions: { 'exact-match': 1 },
      composite: 1,
      notes: 'match',
    })
  })

  it('runs an upstream Phoenix evaluator and preserves its native dimension', async () => {
    const judge = phoenixEvaluatorJudge(
      {
        name: 'correctness',
        kind: 'LLM',
        optimizationDirection: 'MAXIMIZE',
        async evaluate(record) {
          return {
            score: record.output === record.expected ? 1 : 0,
            label: 'correct',
            explanation: 'The values match.',
          }
        },
      },
      {
        mapInput: ({
          artifact,
          scenario: inputScenario,
        }: {
          artifact: string
          scenario: ExpectedScenario
        }) => ({
          output: artifact,
          expected: inputScenario.expected,
        }),
      },
    )
    const result = await judge.score({
      artifact: 'answer',
      scenario,
      signal,
    })
    expect(result).toEqual({
      dimensions: { correctness: 1 },
      composite: 1,
      notes: 'correct: The values match.',
    })
  })

  it.each(['MINIMIZE', 'NEUTRAL'] as const)(
    'requires an explicit conversion for %s metrics',
    (optimizationDirection) => {
      expect(() =>
        phoenixEvaluatorJudge(
          {
            name: 'distance',
            kind: 'CODE',
            optimizationDirection,
            async evaluate() {
              return { score: 2 }
            },
          },
          { mapInput: () => ({}) },
        ),
      ).toThrow(new RegExp(`requires toComposite for a ${optimizationDirection} evaluator`))
    },
  )

  it('rejects a non-finite Phoenix conversion result', async () => {
    const judge = phoenixEvaluatorJudge(
      {
        name: 'distance',
        kind: 'CODE',
        optimizationDirection: 'MINIMIZE',
        async evaluate() {
          return { score: 2 }
        },
      },
      {
        mapInput: () => ({}),
        toComposite: () => Number.NaN,
      },
    )

    await expect(judge.score({ artifact: null, scenario, signal })).rejects.toThrow(
      /toComposite returned a non-finite score/,
    )
  })

  it('uses a finite conversion only for the composite score', async () => {
    const judge = phoenixEvaluatorJudge(
      {
        name: 'distance',
        kind: 'CODE',
        optimizationDirection: 'NEUTRAL',
        async evaluate() {
          return { score: 2 }
        },
      },
      {
        mapInput: () => ({}),
        toComposite: (score) => 1 / (1 + score),
      },
    )

    await expect(judge.score({ artifact: null, scenario, signal })).resolves.toMatchObject({
      dimensions: { distance: 2 },
      composite: 1 / 3,
    })
  })
})

describe('autoevalsScorerJudge', () => {
  it('runs the installed Autoevals scorer contract', async () => {
    const judge = autoevalsScorerJudge(ExactMatch, {
      name: 'exact-match',
      mapInput: ({
        artifact,
        scenario: inputScenario,
      }: {
        artifact: string
        scenario: ExpectedScenario
      }) => ({ output: artifact, expected: inputScenario.expected }),
    })

    await expect(judge.score({ artifact: 'answer', scenario, signal })).resolves.toMatchObject({
      dimensions: { 'exact-match': 1 },
      composite: 1,
      notes: 'ExactMatch',
    })
  })

  it('runs an upstream Autoevals scorer without copying its implementation', async () => {
    const judge = autoevalsScorerJudge(
      async ({ output, expected }) => ({
        name: 'ExactMatch',
        score: output === expected ? 1 : 0,
        metadata: { implementation: 'autoevals' },
      }),
      {
        name: 'exact-match',
        mapInput: ({
          artifact,
          scenario: inputScenario,
        }: {
          artifact: string
          scenario: ExpectedScenario
        }) => ({
          output: artifact,
          expected: inputScenario.expected,
        }),
      },
    )
    const result = await judge.score({
      artifact: 'answer',
      scenario,
      signal,
    })
    expect(result.dimensions).toEqual({ 'exact-match': 1 })
    expect(result.composite).toBe(1)
    expect(result.notes).toBe('{"implementation":"autoevals"}')
  })

  it('fails on missing scores instead of treating missing capture as success', async () => {
    const judge = autoevalsScorerJudge(async () => ({ name: 'missing', score: null }), {
      name: 'missing',
      mapInput: () => ({}),
    })
    await expect(judge.score({ artifact: null, scenario, signal })).rejects.toThrow(
      /returned no finite score/,
    )
  })
})
