import { describe, expect, it } from 'vitest'
import { inMemoryCampaignStorage, runProfileMatrix } from '../src/campaign'
import { createEvaluator } from '../src/evaluation'

// The real campaign cell meter owns admission, run attribution and receipts.
// A generic evaluator should not need a second full CostLedger to consume it.
describe('evaluators inside existing campaign accounts', () => {
  it('compares decision configurations on independent labels using the campaign account', async () => {
    const seen: string[] = []
    const evaluate = createEvaluator({
      execute: async (input: string) => {
        seen.push(input)
        return input === 'evidence' ? 'inspect' : 'finish'
      },
      receipt: () => ({
        model: 'fixture@2026-09-20',
        inputTokens: 8,
        outputTokens: 1,
        actualCostUsd: 0.01,
      }),
      maximumCharge: { externallyEnforcedMaximumUsd: 0.01 },
    })
    const result = await runProfileMatrix({
      profiles: [
        {
          name: 'evidence-aware',
          model: { default: 'fixture@2026-09-20' },
          prompt: { systemPrompt: 'evidence' },
        },
        {
          name: 'claim-only',
          model: { default: 'fixture@2026-09-20' },
          prompt: { systemPrompt: 'claim' },
        },
      ],
      scenarios: [{ id: 'missing-receipt', kind: 'completion', expected: 'inspect' }],
      dispatch: async (profile, _scenario, context) => {
        const result = await evaluate(profile.prompt!.systemPrompt!, {
          costLedger: context.cost,
          channel: 'agent',
          signal: context.signal,
          callId: `${context.runAttemptId}/${context.cellId}`,
        })
        await context.artifacts.writeJson('decision.json', result)
        return result.value
      },
      judges: [
        {
          name: 'independent-outcome',
          dimensions: [{ key: 'correct', description: 'Expected action' }],
          score: ({ artifact, scenario }) => ({
            dimensions: { correct: +(artifact === scenario.expected) },
            composite: +(artifact === scenario.expected),
            notes: '',
          }),
        },
      ],
      runDir: 'decision-comparison',
      commitSha: 'fixture@2026-09-20',
      storage: inMemoryCampaignStorage(),
      integrity: 'off', // Explicit injected classifier, not live model evidence.
      costCeiling: 0.02,
      labeledStore: 'off',
    })
    expect(seen).toEqual(['evidence', 'claim'])
    const summaries = Object.values(result.byProfile)
    expect(summaries.map((row) => row.meanComposite).sort()).toEqual([0, 1])
    expect(summaries.every((row) => row.totalCostUsd === 0.01)).toBe(true)
    expect(result.records).toHaveLength(2)
  })
})
