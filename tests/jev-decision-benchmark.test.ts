import { describe, expect, it } from 'vitest'
import { compareDecisions, type DecisionConfiguration } from '../examples/jev-decision-benchmark'
import { CostLedger } from '../src/cost-ledger'
import { jevEvaluator } from '../src/jev'

const configs: DecisionConfiguration[] = [
  {
    id: 'always-route',
    version: 'v1',
    model: 'fixture',
    questions: {
      next: {
        type: 'choice',
        instructions: 'Choose only from the evidence.',
        criteria: { inspect: null, finish: null },
      },
    },
    decide: (r) => (r.answers.next!.type === 'choice' ? r.answers.next!.choice : null),
  },
  {
    id: 'abstain',
    version: 'v1',
    model: 'fixture',
    questions: {
      next: {
        type: 'choice',
        instructions: 'Choose only from the evidence.',
        criteria: { inspect: null, finish: null },
      },
    },
    decide: (r) =>
      r.answers.next!.type === 'choice' &&
      r.answers.next!.probabilities[r.answers.next!.choice]! >= 0.8
        ? r.answers.next!.choice
        : null,
  },
]

describe('decision configuration comparisons', () => {
  it('compares actual policies on the same inputs without showing held-out labels to inference', async () => {
    const seen: unknown[] = []
    const ledger = new CostLedger()
    const evaluate = jevEvaluator({
      evaluate: async (request) => {
        seen.push(request)
        return {
          model: 'fixture',
          answers: {
            next: {
              type: 'choice',
              choice: 'finish',
              confidence: 0.1,
              probabilities: { inspect: 0.45, finish: 0.55 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 2 },
        }
      },
      receipt: () => ({ actualCostUsd: 0.01, inputTokens: 10, outputTokens: 2, model: 'fixture' }),
    })
    const observations: unknown[] = []
    const result = await compareDecisions({
      cases: [
        {
          id: 'case-1',
          sourceUnit: 'incident-1',
          input: { evidence: 'receipt missing' },
          expected: null,
        },
      ],
      configurations: configs,
      evaluate,
      context: { costLedger: ledger },
      onObservation: (row) => {
        observations.push(row)
      },
    })
    expect(result.byAxis.configuration!['always-route@v1']!.passRate).toBe(0)
    expect(result.byAxis.configuration!['abstain@v1']!.passRate).toBe(1)
    expect(result.summary.totalCostUsd).toBeCloseTo(0.02)
    expect(ledger.summary().totalCalls).toBe(2)
    expect(observations).toHaveLength(2)
    expect(JSON.stringify(seen)).not.toContain('expected')
    expect(JSON.stringify(seen)).not.toContain('incident-1')
  })

  it('keeps versions of one policy separate, including identities with @', async () => {
    const evaluate = jevEvaluator({
      evaluate: async () => ({
        model: 'fixture',
        answers: {
          next: {
            type: 'choice',
            choice: 'finish',
            confidence: 1,
            probabilities: { inspect: 0, finish: 1 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      receipt: () => ({ model: 'fixture', actualCostUsd: 0, inputTokens: 10, outputTokens: 2 }),
    })
    const result = await compareDecisions({
      cases: [
        { id: 'case', sourceUnit: 'incident', input: { evidence: 'route' }, expected: 'finish' },
      ],
      configurations: [
        { ...configs[0]!, id: 'a@b', version: 'c' },
        { ...configs[0]!, id: 'a', version: 'b@c', decide: () => null },
      ],
      evaluate,
    })
    expect(result.byAxis.configuration!['a%40b@c']!.passRate).toBe(1)
    expect(result.byAxis.configuration!['a@b%40c']!.passRate).toBe(0)
  })

  it('rejects duplicate configuration versions before running the evaluator', async () => {
    const evaluate = jevEvaluator({
      evaluate: async () => {
        throw new Error('should not run')
      },
      receipt: () => ({ model: 'fixture', actualCostUsd: 0 }),
    })
    await expect(
      compareDecisions({
        cases: [{ id: 'case', sourceUnit: 'incident', input: 'incident', expected: 'finish' }],
        configurations: [configs[0]!, configs[0]!],
        evaluate,
      }),
    ).rejects.toThrow('configuration id and version pairs must be unique')
  })

  it('keeps paid costs when a policy/observation callback fails instead of rewarding that configuration', async () => {
    const evaluate = jevEvaluator({
      evaluate: async () => ({
        model: 'fixture',
        answers: {
          next: {
            type: 'choice',
            choice: 'finish',
            confidence: 1,
            probabilities: { inspect: 0, finish: 1 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      receipt: () => ({ model: 'fixture', actualCostUsd: 0.1, inputTokens: 10, outputTokens: 2 }),
    })
    const result = await compareDecisions({
      cases: [{ id: 'a', sourceUnit: 'a', input: 'incident', expected: 'finish' }],
      configurations: [configs[0]!],
      evaluate,
      onObservation: () => {
        throw new Error('storage unavailable')
      },
    })
    expect(result.summary.overallPassRate).toBe(0)
    expect(result.summary.totalCostUsd).toBeCloseTo(0.1)
    expect(result.cells[0]!.runs[0]!.error).toBeDefined()
  })
})
