import { describe, expect, it } from 'vitest'

import type { Gate, JudgeConfig, Scenario, SurfaceProposer } from '../campaign/types'
import type { DispatchContext } from './index'
import { measuredComparisonFromSelfImproveResult } from './measured-comparison'
import { selfImprove } from './self-improve'

const scenarios: Scenario[] = Array.from({ length: 8 }, (_, index) => ({
  id: `comparison-${index}`,
  kind: 'fixture',
}))

const judge: JudgeConfig<{ text: string }, Scenario> = {
  name: 'quality',
  dimensions: [{ key: 'correctness', description: 'fixture quality' }],
  score: ({ artifact, scenario }) => {
    const base = Number.parseInt(scenario.id.split('-')[1] ?? '0', 10) % 2 === 0 ? 0.25 : 0.5
    const score = artifact.text === 'BETTER' ? base + 0.25 : base
    return { composite: score, dimensions: { correctness: score }, notes: '' }
  },
}

const proposer: SurfaceProposer = {
  kind: 'comparison-fixture',
  propose: async () => ['BETTER'],
}

const promotion: Gate<{ text: string }, Scenario> = {
  name: 'comparison-fixture',
  decide: async () => ({
    decision: 'ship',
    reasons: ['candidate improved on paired heldout cells'],
    contributingGates: [{ name: 'paired-heldout', passed: true, detail: { delta: 0.25 } }],
  }),
}

async function paidAgent(
  surface: unknown,
  _scenario: Scenario,
  context: DispatchContext,
): Promise<{ text: string }> {
  const paid = await context.cost.runPaidCall({
    actor: 'comparison-fixture',
    model: 'fixture',
    execute: async () => ({ text: String(surface) }),
    receipt: () => ({
      model: 'fixture',
      inputTokens: 1,
      outputTokens: 1,
      actualCostUsd: 0.001,
    }),
  })
  if (!paid.succeeded) throw paid.error
  return paid.value
}

describe('measuredComparisonFromSelfImproveResult', () => {
  it('preserves paired quality, cost, latency, power, decision, and provenance', async () => {
    const result = await selfImprove({
      agent: paidAgent,
      scenarios,
      judge,
      baselineSurface: 'BASELINE',
      proposer,
      gate: promotion,
      budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5 },
    })

    const comparison = measuredComparisonFromSelfImproveResult({
      result,
      benchmark: {
        name: 'comparison-fixture',
        version: '1',
        splitDigest: `sha256:${'1'.repeat(64)}`,
      },
      baselineProfileDigest: `sha256:${'2'.repeat(64)}`,
      candidateBundleDigest: `sha256:${'3'.repeat(64)}`,
    })

    expect(comparison.overall).toMatchObject({
      baseline: 0.375,
      candidate: 0.625,
      delta: 0.25,
      n: 4,
    })
    expect(comparison.objectives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'objective', name: 'quality', availability: 'measured' }),
        expect.objectContaining({
          kind: 'dimension',
          objective: 'quality',
          name: 'correctness',
          availability: 'measured',
        }),
        expect.objectContaining({ kind: 'cost', availability: 'measured' }),
        expect.objectContaining({ kind: 'latency', availability: 'measured' }),
      ]),
    )
    expect(comparison.decision).toEqual({
      outcome: 'ship',
      reasons: ['candidate improved on paired heldout cells'],
      contributingChecks: [{ name: 'paired-heldout', passed: true }],
    })
    expect(comparison.power.n).toBe(4)
    expect(comparison.provenance.recordDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('rejects an unpaired heldout result instead of silently dropping a cell', async () => {
    const result = await selfImprove({
      agent: paidAgent,
      scenarios,
      judge,
      baselineSurface: 'BASELINE',
      proposer,
      gate: promotion,
      budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5 },
    })
    const unpaired = {
      ...result,
      raw: {
        ...result.raw,
        winnerOnHoldout: {
          ...result.raw.winnerOnHoldout,
          cells: result.raw.winnerOnHoldout.cells.slice(1),
        },
      },
    }

    expect(() =>
      measuredComparisonFromSelfImproveResult({
        result: unpaired,
        benchmark: {
          name: 'comparison-fixture',
          version: '1',
          splitDigest: `sha256:${'1'.repeat(64)}`,
        },
        baselineProfileDigest: `sha256:${'2'.repeat(64)}`,
        candidateBundleDigest: `sha256:${'3'.repeat(64)}`,
      }),
    ).toThrow(/same non-empty paired heldout cells/)
  })
})
