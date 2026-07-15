import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'
import { campaignScenarioIdentity, campaignSplitDigestFromIdentities } from '../campaign/coverage'
import { neutralizationGate } from '../campaign/gates/neutralization-gate'
import type {
  Gate,
  JudgeConfig,
  MutableSurface,
  Scenario,
  SurfaceProposer,
} from '../campaign/types'
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

function fixtureResult(gate: Gate<{ text: string }, Scenario> = promotion, reps = 1) {
  return selfImprove({
    agent: paidAgent,
    scenarios,
    judge,
    baselineSurface: 'BASELINE',
    proposer,
    gate,
    budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5, reps },
  })
}

function noOpFixtureResult() {
  return selfImprove({
    agent: paidAgent,
    scenarios,
    judge,
    baselineSurface: 'BASELINE',
    proposer: { kind: 'empty-fixture', propose: async () => [] },
    gate: promotion,
    budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5 },
  })
}

type FixtureResult = Awaited<ReturnType<typeof fixtureResult>>

function measuredComparison(
  result: FixtureResult,
  baselineSurface: MutableSurface = 'BASELINE',
  splitDigest = result.raw.baselineOnHoldout.splitDigest,
) {
  return measuredComparisonFromSelfImproveResult({
    result,
    benchmark: {
      name: 'comparison-fixture',
      version: '1',
      splitDigest,
    },
    baselineProfileDigest: `sha256:${'2'.repeat(64)}`,
    candidateBundleDigest: `sha256:${'3'.repeat(64)}`,
    baselineSurface,
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
    expect(comparison.provenance.recordDigest).toBe(result.provenance.recordDigest)
  })

  it('pairs every scenario replicate explicitly', async () => {
    const result = await fixtureResult(promotion, 2)
    expect(measuredComparison(result).overall.n).toBe(8)
  })

  it('rejects an unpaired heldout result instead of silently dropping a cell', async () => {
    const result = await fixtureResult()
    const omittedScenarioId = result.raw.winnerOnHoldout.cells[0]?.scenarioId
    if (!omittedScenarioId) throw new Error('expected a heldout fixture cell')
    const winnerScenarios = result.raw.winnerOnHoldout.scenarios.filter(
      (scenario) => scenario.id !== omittedScenarioId,
    )
    const unpaired = {
      ...result,
      raw: {
        ...result.raw,
        winnerOnHoldout: {
          ...result.raw.winnerOnHoldout,
          splitDigest: campaignSplitDigestFromIdentities(
            winnerScenarios,
            result.raw.winnerOnHoldout.reps,
          ),
          cells: result.raw.winnerOnHoldout.cells.slice(1),
          scenarios: winnerScenarios,
        },
      },
    }

    expect(() => measuredComparison(unpaired)).toThrow(/same non-empty paired heldout cells/)
  })

  it('rejects a heldout scenario declared without its designed cell', async () => {
    const result = await fixtureResult()
    const omittedScenario = campaignScenarioIdentity({
      id: 'omitted-hard-case',
      kind: 'fixture',
    })
    const expandedScenarios = [...result.raw.baselineOnHoldout.scenarios, omittedScenario]
    const expandedSplitDigest = campaignSplitDigestFromIdentities(
      expandedScenarios,
      result.raw.baselineOnHoldout.reps,
    )
    const incomplete = {
      ...result,
      raw: {
        ...result.raw,
        baselineOnHoldout: {
          ...result.raw.baselineOnHoldout,
          splitDigest: expandedSplitDigest,
          scenarios: expandedScenarios,
        },
        winnerOnHoldout: {
          ...result.raw.winnerOnHoldout,
          splitDigest: expandedSplitDigest,
          scenarios: expandedScenarios,
        },
      },
    }

    expect(() => measuredComparison(incomplete)).toThrow(/heldout baseline is incomplete \(4\/5/)
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

    expect(() => measuredComparison(errored)).toThrow(/heldout baseline is incomplete/)
  })

  it('requires the exact baseline surface, including an empty string', async () => {
    const result = await fixtureResult()
    expect(() => measuredComparison(result, '')).toThrow(/surface diff does not agree/)
  })

  it('rejects a shipped no-op even when every decision field agrees', async () => {
    const result = await noOpFixtureResult()
    const gate = {
      decision: 'ship' as const,
      reasons: ['forged no-op shipment'],
      contributingGates: [{ name: 'forged', passed: true, detail: { winnerIsBaseline: false } }],
      delta: 0,
    }
    const forged = {
      ...result,
      gateDecision: 'ship' as const,
      provenance: { ...result.provenance, gate },
      raw: { ...result.raw, gateResult: gate },
    }

    expect(() => measuredComparison(forged)).toThrow(/record digest/)
  })

  it('normalizes an undefined decision-check detail through the canonical provenance builder', async () => {
    const result = await fixtureResult({
      name: 'undefined-detail-fixture',
      decide: async () => ({
        decision: 'ship',
        reasons: ['candidate improved on paired heldout cells'],
        contributingGates: [{ name: 'paired-heldout', passed: true, detail: undefined }],
      }),
    })

    expect(result.provenance.gate.contributingGates[0]?.detail).toBeNull()
    expect(() => measuredComparison(result)).not.toThrow()
  })

  it('binds the exported benchmark to the exact heldout design', async () => {
    const result = await fixtureResult()
    expect(() => measuredComparison(result, 'BASELINE', `sha256:${'9'.repeat(64)}`)).toThrow(
      /benchmark heldout split does not agree/,
    )
  })

  it('rejects a campaign split detached from its retained task identities', async () => {
    const result = await fixtureResult()
    const forged = {
      ...result,
      raw: {
        ...result.raw,
        baselineOnHoldout: {
          ...result.raw.baselineOnHoldout,
          scenarios: result.raw.baselineOnHoldout.scenarios.map((scenario, index) =>
            index === 0
              ? { ...scenario, scenarioDigest: `sha256:${'9'.repeat(64)}` as const }
              : scenario,
          ),
        },
      },
    }

    expect(() => measuredComparison(forged)).toThrow(/split digest does not match/)
  })

  it('rejects duplicate scenario ids instead of inflating the designed denominator', async () => {
    const result = await fixtureResult()
    const duplicate = result.raw.baselineOnHoldout.scenarios[0]
    if (!duplicate) throw new Error('expected a heldout scenario')
    const forged = {
      ...result,
      raw: {
        ...result.raw,
        baselineOnHoldout: {
          ...result.raw.baselineOnHoldout,
          scenarios: [...result.raw.baselineOnHoldout.scenarios, duplicate],
        },
        winnerOnHoldout: {
          ...result.raw.winnerOnHoldout,
          scenarios: [...result.raw.winnerOnHoldout.scenarios, duplicate],
        },
      },
    }

    expect(() => measuredComparison(forged)).toThrow(/duplicate scenario id/)
  })

  it('requires a successful model receipt for every scored heldout row', async () => {
    const holdout = scenarios.slice(4)
    const holdoutIds = new Set(holdout.map((scenario) => scenario.id))
    const result = await selfImprove({
      agent: async (surface, scenario, context) =>
        holdoutIds.has(scenario.id)
          ? { text: String(surface) }
          : paidAgent(surface, scenario, context),
      scenarios,
      judge,
      baselineSurface: 'BASELINE',
      proposer,
      gate: promotion,
      expectUsage: 'off',
      budget: {
        generations: 1,
        populationSize: 1,
        holdoutScenarios: holdout,
      },
    })

    expect(result.provenance.backend.verdict).toBe('real')
    expect(() => measuredComparison(result)).toThrow(/stub or unconfigured backend/)
  })

  it('rejects a failed agent receipt linked to a scored row', async () => {
    const result = await fixtureResult()
    const callId = result.raw.winnerOnHoldout.cells[0]?.costCallIds?.[0]
    if (!callId) throw new Error('expected a heldout agent receipt')
    const forged = {
      ...result,
      receipts: result.receipts.map((receipt) =>
        receipt.callId === callId ? { ...receipt, error: 'provider failed' } : receipt,
      ),
    }

    expect(() => measuredComparison(forged)).toThrow(/links a failed agent receipt/)
  })

  it('rejects a customer-visible diff not derived from the measured surfaces', async () => {
    const result = await fixtureResult()
    const diff = 'FORGED: deploy an unrelated change'
    const forged = {
      ...result,
      diff,
      provenance: { ...result.provenance, diff },
      raw: { ...result.raw, promotedDiff: diff },
    }

    expect(() => measuredComparison(forged)).toThrow(/record digest/)
  })

  it('rejects altered neutralization evidence after the decision', async () => {
    const holdout = scenarios.slice(4)
    const result = await selfImprove({
      agent: paidAgent,
      scenarios,
      judge,
      baselineSurface: 'BASELINE',
      proposer,
      gate: neutralizationGate<{ text: string }, Scenario>({ scenarios: holdout }),
      neutralize: () => 'NEUTRAL',
      budget: {
        generations: 1,
        populationSize: 1,
        holdoutScenarios: holdout,
      },
    })
    if (!result.raw.neutralizedOnHoldout) {
      throw new Error('expected neutralized holdout evidence')
    }
    const forged = {
      ...result,
      raw: {
        ...result.raw,
        neutralizedSurface: 'FORGED-PLACEBO',
        neutralizedOnHoldout: {
          ...result.raw.neutralizedOnHoldout,
          cells: result.raw.neutralizedOnHoldout.cells.map((cell) => ({
            ...cell,
            judgeScores: Object.fromEntries(
              Object.entries(cell.judgeScores).map(([name, score]) => [
                name,
                { ...score, composite: 0.99, dimensions: { correctness: 0.99 } },
              ]),
            ),
          })),
        },
      },
    }

    expect(() => measuredComparison(forged)).toThrow(/provenance record does not agree/)
  })

  it('rejects a changed run identity or provenance schema', async () => {
    const result = await fixtureResult()
    expect(() =>
      measuredComparison({
        ...result,
        provenance: { ...result.provenance, runId: 'another-customer/run' },
      }),
    ).toThrow(/record digest/)
    expect(() =>
      measuredComparison({
        ...result,
        provenance: { ...result.provenance, schema: 'forged.provenance.v999' as never },
      }),
    ).toThrow(/unsupported schema/)
  })

  it.each([
    {
      name: 'baseline holdout composite',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, baselineHoldoutComposite: 999 },
      }),
      message: /record digest/,
    },
    {
      name: 'winner holdout composite',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, winnerHoldoutComposite: 999 },
      }),
      message: /record digest/,
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
      message: /record digest/,
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
      message: /record digest/,
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
      message: /record digest/,
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
      message: /provenance record|record digest/,
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
      message: /provenance record|record digest/,
    },
    {
      name: 'decision check detail',
      mutate: (result: FixtureResult) => ({
        ...result,
        raw: {
          ...result.raw,
          gateResult: {
            ...result.raw.gateResult,
            contributingGates: result.raw.gateResult.contributingGates.map((check) => ({
              ...check,
              detail: { forged: true },
            })),
          },
        },
      }),
      message: /provenance record|record digest/,
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
      message: /provenance record|record digest/,
    },
    {
      name: 'diff',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, diff: 'contradictory diff' },
      }),
      message: /record digest/,
    },
    {
      name: 'total cost',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, totalCostUsd: result.totalCostUsd + 1 },
      }),
      message: /record digest/,
    },
    {
      name: 'total duration',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, totalDurationMs: result.durationMs + 1 },
      }),
      message: /record digest/,
    },
    {
      name: 'power analysis',
      mutate: (result: FixtureResult) => ({
        ...result,
        power: { ...result.power!, mde: 999, recommendation: 'forged power analysis' },
      }),
      message: /power analysis does not agree/,
    },
    {
      name: 'generation count',
      mutate: (result: FixtureResult) => ({ ...result, generationsExplored: 999 }),
      message: /generation count does not agree/,
    },
    {
      name: 'generation history',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: { ...result.provenance, candidates: [] },
      }),
      message: /record digest/,
    },
    {
      name: 'candidate composite',
      mutate: (result: FixtureResult) => ({
        ...result,
        raw: {
          ...result.raw,
          generations: result.raw.generations.map((generation) => ({
            ...generation,
            record: {
              ...generation.record,
              candidates: generation.record.candidates.map((candidate) => ({
                ...candidate,
                composite: candidate.composite + 0.1,
                ci95: [candidate.composite + 0.1, candidate.composite + 0.1] as [number, number],
                observedDeltaFromParent: (candidate.observedDeltaFromParent ?? 0) + 0.1,
              })),
            },
          })),
        },
        provenance: {
          ...result.provenance,
          candidates: result.provenance.candidates.map((candidate) => ({
            ...candidate,
            composite: candidate.composite + 0.1,
            observedDeltaFromParent: (candidate.observedDeltaFromParent ?? 0) + 0.1,
          })),
        },
      }),
      message: /record digest/,
    },
    {
      name: 'candidate dimensions',
      mutate: (result: FixtureResult) => ({
        ...result,
        raw: {
          ...result.raw,
          generations: result.raw.generations.map((generation) => ({
            ...generation,
            record: {
              ...generation.record,
              candidates: generation.record.candidates.map((candidate) => ({
                ...candidate,
                dimensions: { forged: 1 },
              })),
            },
          })),
        },
      }),
      message: /candidate .* dimensions does not agree/,
    },
    {
      name: 'backend provenance',
      mutate: (result: FixtureResult) => ({
        ...result,
        provenance: {
          ...result.provenance,
          backend: { ...result.provenance.backend, verdict: 'stub' as const },
        },
      }),
      message: /record digest/,
    },
    {
      name: 'candidate coverage',
      mutate: (result: FixtureResult) => ({
        ...result,
        raw: {
          ...result.raw,
          generations: result.raw.generations.map((generation) => ({
            ...generation,
            surfaces: generation.surfaces.map((surface, index) => ({
              ...surface,
              campaign: {
                ...surface.campaign,
                cells: surface.campaign.cells.map((cell, cellIndex) =>
                  index === 0 && cellIndex === 0 ? { ...cell, error: 'search failed' } : cell,
                ),
              },
            })),
          })),
        },
      }),
      message: /candidate .* coverage does not agree/,
    },
    {
      name: 'generation index',
      mutate: (result: FixtureResult) => ({
        ...result,
        raw: {
          ...result.raw,
          generations: result.raw.generations.map((generation) => ({
            ...generation,
            record: { ...generation.record, generationIndex: 1 },
          })),
        },
      }),
      message: /contiguous integers starting at zero/,
    },
    {
      name: 'cost summary',
      mutate: (result: FixtureResult) => ({
        ...result,
        totalCostUsd: result.totalCostUsd + 1,
        provenance: { ...result.provenance, totalCostUsd: result.totalCostUsd + 1 },
      }),
      message: /provenance record|record digest/,
    },
    {
      name: 'cost receipts',
      mutate: (result: FixtureResult) => {
        const totalCostUsd = result.totalCostUsd + 1
        return {
          ...result,
          totalCostUsd,
          cost: { ...result.cost, totalCostUsd },
          provenance: { ...result.provenance, totalCostUsd },
          raw: { ...result.raw, cost: { ...result.raw.cost, totalCostUsd } },
        }
      },
      message: /provenance record|record digest/,
    },
    {
      name: 'winner label',
      mutate: (result: FixtureResult) => ({
        ...result,
        winner: { ...result.winner, label: 'forged label' },
      }),
      message: /raw winner label does not agree/,
    },
    {
      name: 'incomplete cost accounting',
      mutate: (result: FixtureResult) => {
        const cost = {
          ...result.cost,
          accountingComplete: false,
          incompleteReasons: ['provider bill is pending'],
        }
        return { ...result, cost, raw: { ...result.raw, cost } }
      },
      message: /cost accounting is incomplete/,
    },
    {
      name: 'forged cost rollup',
      mutate: (result: FixtureResult) => {
        const cost = { ...result.cost, inputTokens: result.cost.inputTokens + 1 }
        return { ...result, cost, raw: { ...result.raw, cost } }
      },
      message: /cost receipt summary does not agree/,
    },
    {
      name: 'invalid receipt usage',
      mutate: (result: FixtureResult) => ({
        ...result,
        receipts: result.receipts.map((receipt, index) =>
          index === 0 ? { ...receipt, inputTokens: -1 } : receipt,
        ),
      }),
      message: /invalid imported receipt/,
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
    const judgeEntry = Object.entries(winnerCell.judgeScores)[0]
    if (!judgeEntry) throw new Error('expected heldout fixture judge')
    const [judgeName, judgeScore] = judgeEntry
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
        message: /heldout baseline is incomplete/,
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
        message: /heldout candidate is incomplete/,
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
        message: /latency must be non-negative/,
      },
      {
        name: 'negative cost',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0 ? { ...cell, costUsd: -1 } : cell,
              ),
            },
          },
        },
        message: /cost must be non-negative/,
      },
      {
        name: 'cost not backed by receipts',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0 ? { ...cell, costUsd: cell.costUsd + 1 } : cell,
              ),
            },
          },
        },
        message: /cost receipts does not agree/,
      },
      {
        name: 'cost receipt omitted from cell',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0
                  ? { ...cell, costUsd: 0, costCallIds: [], tokenUsage: { input: 0, output: 0 } }
                  : cell,
              ),
            },
          },
        },
        message: /cost receipt IDs does not agree/,
      },
      {
        name: 'token usage not backed by receipts',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0
                  ? {
                      ...cell,
                      tokenUsage: { ...cell.tokenUsage, input: cell.tokenUsage.input + 1 },
                    }
                  : cell,
              ),
            },
          },
        },
        message: /input receipts does not agree/,
      },
      {
        name: 'receipt from another cell',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index, cells) =>
                index === 0 ? { ...cell, costCallIds: cells[1]?.costCallIds } : cell,
              ),
            },
          },
        },
        message: /receipt from another cell/,
      },
      {
        name: 'failed judge',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0
                  ? {
                      ...cell,
                      judgeScores: {
                        ...cell.judgeScores,
                        [judgeName]: { ...judgeScore, failed: true as const },
                      },
                    }
                  : cell,
              ),
            },
          },
        },
        message: /heldout candidate is incomplete/,
      },
      {
        name: 'mismatched cell identity',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0 ? { ...cell, scenarioId: 'different-scenario' } : cell,
              ),
            },
          },
        },
        message: /heldout candidate is incomplete/,
      },
      {
        name: 'negative token count',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0 ? { ...cell, tokenUsage: { ...cell.tokenUsage, input: -1 } } : cell,
              ),
            },
          },
        },
        message: /input tokens must be a non-negative safe integer/,
      },
      {
        name: 'mismatched paired seed',
        result: {
          ...result,
          raw: {
            ...result.raw,
            winnerOnHoldout: {
              ...result.raw.winnerOnHoldout,
              cells: result.raw.winnerOnHoldout.cells.map((cell, index) =>
                index === 0 ? { ...cell, seed: cell.seed + 1 } : cell,
              ),
            },
          },
        },
        message: /does not share one paired seed/,
      },
    ]

    for (const testCase of cases) {
      expect(() => measuredComparison(testCase.result), testCase.name).toThrow(testCase.message)
    }
  })
})
