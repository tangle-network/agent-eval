import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { Gate, JudgeConfig, Scenario, SurfaceProposer } from '../campaign/types'
import { canonicalJson } from '../verdict-cache'
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

function fixtureResult() {
  return selfImprove({
    agent: paidAgent,
    scenarios,
    judge,
    baselineSurface: 'BASELINE',
    proposer,
    gate: promotion,
    budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5 },
  })
}

type FixtureResult = Awaited<ReturnType<typeof fixtureResult>>

function measuredComparison(result: FixtureResult) {
  return measuredComparisonFromSelfImproveResult({
    result,
    benchmark: {
      name: 'comparison-fixture',
      version: '1',
      splitDigest: `sha256:${'1'.repeat(64)}`,
    },
    baselineProfileDigest: `sha256:${'2'.repeat(64)}`,
    candidateBundleDigest: `sha256:${'3'.repeat(64)}`,
    baselineSurface: 'BASELINE',
  })
}

describe('measuredComparisonFromSelfImproveResult', () => {
  it('preserves paired quality, cost, latency, power, decision, and provenance', async () => {
    const result = await fixtureResult()
    const comparison = measuredComparison(result)

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
    expect(comparison.provenance.baselineContentHash).toBe(
      `sha256:${createHash('sha256').update('BASELINE').digest('hex')}`,
    )
    expect(comparison.provenance.candidateContentHash).toBe(
      `sha256:${createHash('sha256').update('BETTER').digest('hex')}`,
    )
    expect(comparison.provenance.recordDigest).toBe(
      `sha256:${createHash('sha256')
        .update(canonicalJson(JSON.parse(JSON.stringify(result.provenance))))
        .digest('hex')}`,
    )
  })

  it('rejects an unpaired heldout result instead of silently dropping a cell', async () => {
    const result = await fixtureResult()
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

    expect(() => measuredComparison(unpaired)).toThrow(/same non-empty paired heldout cells/)
  })

  it('rejects matched errored cells instead of publishing only surviving pairs', async () => {
    const result = await fixtureResult()
    const errored = {
      ...result,
      raw: {
        ...result.raw,
        baselineOnHoldout: {
          ...result.raw.baselineOnHoldout,
          cells: result.raw.baselineOnHoldout.cells.map((cell, index) =>
            index === 0 ? { ...cell, error: 'baseline failed' } : cell,
          ),
        },
        winnerOnHoldout: {
          ...result.raw.winnerOnHoldout,
          cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
            index === 0 ? { ...cell, error: 'candidate failed' } : cell,
          ),
        },
      },
    }

    expect(() => measuredComparison(errored)).toThrow(/cannot publish 2 errored heldout cells/)
  })

  it.each([
    {
      name: 'baseline holdout composite',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, baselineHoldoutComposite: 999 },
      }),
      message: /provenance heldout baseline does not agree/,
    },
    {
      name: 'winner holdout composite',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, winnerHoldoutComposite: 999 },
      }),
      message: /provenance heldout candidate does not agree/,
    },
    {
      name: 'baseline content hash',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: {
          ...result.provenance,
          baselineContentHash: `sha256:${'a'.repeat(64)}`,
        },
      }),
      message: /baseline surface does not agree/,
    },
    {
      name: 'winner content hash',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: {
          ...result.provenance,
          winnerContentHash: `sha256:${'b'.repeat(64)}`,
        },
      }),
      message: /winner surface does not agree/,
    },
    {
      name: 'decision',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: {
          ...result.provenance,
          gate: { ...result.provenance.gate, decision: 'hold' as const },
        },
      }),
      message: /provenance decision does not agree/,
    },
    {
      name: 'decision reasons',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: {
          ...result.provenance,
          gate: { ...result.provenance.gate, reasons: ['contradictory reason'] },
        },
      }),
      message: /gate evidence does not agree/,
    },
    {
      name: 'decision checks',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: {
          ...result.provenance,
          gate: { ...result.provenance.gate, contributingGates: [] },
        },
      }),
      message: /gate evidence does not agree/,
    },
    {
      name: 'decision delta',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: {
          ...result.provenance,
          gate: { ...result.provenance.gate, delta: 999 },
        },
      }),
      message: /gate evidence does not agree/,
    },
    {
      name: 'diff',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, diff: 'contradictory diff' },
      }),
      message: /provenance diff does not agree/,
    },
    {
      name: 'total cost',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, totalCostUsd: result.totalCostUsd + 1 },
      }),
      message: /provenance total cost does not agree/,
    },
    {
      name: 'total duration',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, totalDurationMs: result.durationMs + 1 },
      }),
      message: /provenance total duration does not agree/,
    },
  ])('rejects contradictory $name provenance', async ({ mutate, message }) => {
    const result = await fixtureResult()
    expect(() => measuredComparison(mutate(result))).toThrow(message)
  })

  it('rejects duplicate, missing-score, and non-finite heldout cells', async () => {
    const result = await fixtureResult()
    const baselineCell = result.raw.baselineOnHoldout.cells[0]
    const winnerCell = result.raw.winnerOnHoldout.cells[0]
    if (!baselineCell || !winnerCell) throw new Error('expected heldout fixture cells')
    const cases = [
      {
        name: 'duplicate rep',
        result: {
          ...result,
          raw: {
            ...result.raw,
            baselineOnHoldout: {
              ...result.raw.baselineOnHoldout,
              cells: [baselineCell, ...result.raw.baselineOnHoldout.cells],
            },
          },
        },
        message: /duplicate repKey/,
      },
      {
        name: 'missing score',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0 ? { ...cell, judgeScores: {} } : cell,
              ),
            },
          },
        },
        message: /has no successful composite score/,
      },
      {
        name: 'non-finite latency',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0 ? { ...cell, durationMs: Number.NaN } : cell,
              ),
            },
          },
        },
        message: /latency:latency.*not finite/,
      },
    ]

    for (const testCase of cases) {
      expect(() => measuredComparison(testCase.result), testCase.name).toThrow(testCase.message)
    }
  })
})
