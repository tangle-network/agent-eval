import { describe, expect, it } from 'vitest'
import { compareOptimizationMethods } from '../src/campaign/presets/compare-optimization-methods'
import { runOptimization } from '../src/campaign/presets/run-optimization'
import { runCampaign } from '../src/campaign/run-campaign'
import { createRunCostLedger, inMemoryCampaignStorage } from '../src/campaign/storage'
import { surfaceDispatchRef, surfaceHash } from '../src/campaign/surface-identity'
import type { Gate, JudgeConfig, Scenario } from '../src/campaign/types'
import { selfImprove } from '../src/contract'

interface Artifact {
  quality: number
}
const scenarios = ['t1', 't2', 't3', 's1', 'h1', 'h2'].map((id) => ({ id, kind: 'fixture' }))
const judge: JudgeConfig<Artifact, Scenario> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'task quality' }],
  score: ({ artifact }) => ({
    composite: artifact.quality,
    dimensions: { quality: artifact.quality },
    notes: '',
  }),
}
const gate: Gate<Artifact, Scenario> = {
  name: 'fixture',
  decide: async () => ({ decision: 'ship', reasons: [], contributingGates: [] }),
}
const freeCost = {
  totalCostUsd: 0,
  costProvenance: { kind: 'observed' as const, usd: 0 },
  accountingComplete: true,
  incompleteReasons: [],
}
const common = () => ({
  scenarios,
  baselineSurface: 'BASE',
  judge,
  gate,
  model: 'deterministic@2026-07-25',
  expectUsage: 'off' as const,
  storage: inMemoryCampaignStorage(),
  runDir: 'mem://method-integrity',
  budget: { holdoutScenarios: scenarios.slice(4) },
})

describe('complete method measurement integrity', () => {
  it('accepts an unchanged selected baseline without inventing candidate history', async () => {
    const executed: string[] = []
    const result = await selfImprove({
      ...common(),
      agent: async (_surface, scenario) => {
        executed.push(scenario.id)
        return { quality: 0.5 }
      },
      method: {
        name: 'unchanged',
        optimize: async (input) => ({ winnerSurface: input.baselineSurface, cost: freeCost }),
      },
    })
    expect(result.mode).toBe('method')
    expect(result.winner.surface).toBe('BASE')
    expect(result.gateDecision).toBe('hold')
    expect(result.lift).toBe(0)
    expect(executed.sort()).toEqual(['h1', 'h2'])
    expect(result.raw.winnerOnHoldout).toBe(result.raw.baselineOnHoldout)
    expect(result.raw).not.toHaveProperty('generations')
    expect(result.provenance).not.toHaveProperty('baselineSearchComposite')
    expect(result.provenance.schema).toBe('tangle.method-improvement')
  })

  it.each(['method', 'proposer'] as const)(
    'counts a shared unchanged campaign once in %s insight',
    async (mode) => {
      const options = common()
      const result = await selfImprove({
        ...options,
        budget: { ...options.budget, ...(mode === 'proposer' ? { generations: 1 } : {}) },
        agent: async (surface, _scenario, context) => {
          const paid = await context.cost.runPaidCall({
            actor: 'worker',
            model: 'fixture@2026-07-25',
            execute: async () => ({ quality: surface === 'BASE' ? 1 : 0 }),
            receipt: () => ({
              model: 'fixture@2026-07-25',
              inputTokens: 10,
              outputTokens: 5,
              actualCostUsd: 1,
            }),
          })
          if (!paid.succeeded) throw paid.error
          return paid.value
        },
        ...(mode === 'method'
          ? {
              method: {
                name: 'unchanged',
                optimize: async () => ({ winnerSurface: 'BASE', cost: freeCost }),
              },
            }
          : { proposer: { kind: 'fixed', propose: async () => ['BAD'] } }),
      })
      expect(result.raw.winnerOnHoldout).toBe(result.raw.baselineOnHoldout)
      expect(result.raw.baselineOnHoldout.cells).toHaveLength(2)
      expect(result.insight?.n).toBe(2)
      expect(result.insight?.costQuality.provenance?.observed).toEqual({ n: 2, totalUsd: 2 })
      expect(result.insight?.execution.tokenUsage.totals.input).toBe(20)
      expect(result.insight?.lift).toBeUndefined()
      expect(result.lift).toBe(0)
      expect(result.gateDecision).toBe('hold')
    },
  )

  it('tests the method-selected winner directly without re-ranking on training cases', async () => {
    const executed: Array<{ surface: string; id: string }> = []
    const result = await selfImprove({
      ...common(),
      selectionScenarios: [scenarios[3]!],
      agent: async (surface, scenario) => {
        executed.push({ surface: String(surface), id: scenario.id })
        return { quality: surface === 'BASE' ? 0.6 : scenario.id.startsWith('t') ? 0 : 1 }
      },
      method: {
        name: 'selection-winner',
        optimize: async (input) => {
          expect(input.trainScenarios.map((scenario) => scenario.id)).toEqual(['t1', 't2', 't3'])
          expect(input.selectionScenarios.map((scenario) => scenario.id)).toEqual(['s1'])
          return { winnerSurface: 'WIN', cost: freeCost }
        },
      },
    })
    expect(result.winner.surface).toBe('WIN')
    expect(result.lift).toBeCloseTo(0.4)
    expect(result.gateDecision).toBe('ship')
    expect(executed).toHaveLength(4)
    expect(executed.every((cell) => cell.id.startsWith('h'))).toBe(true)
    expect(result.raw.method.winnerSurface).toBe('WIN')
  })

  it('retains external method spend and incomplete accounting in the total', async () => {
    const result = await selfImprove({
      ...common(),
      agent: async (surface) => ({ quality: surface === 'BASE' ? 0 : 1 }),
      method: {
        name: 'external',
        optimize: async () => ({
          winnerSurface: 'WIN',
          cost: {
            totalCostUsd: 17,
            costProvenance: { kind: 'estimated', usd: 17 },
            accountingComplete: false,
            incompleteReasons: ['optimizer calls were not captured'],
          },
        }),
      },
    })
    expect(result.totalCostUsd).toBe(17)
    expect(result.cost.accountingComplete).toBe(false)
    expect(result.cost.incompleteReasons.join(' ')).toContain('optimizer calls were not captured')
    expect(result.provenance.totalCostUsd).toBe(17)
    expect(result.ledgerCost.totalCostUsd).toBe(0)
  })

  it('counts metered method and final spending exactly once', async () => {
    const result = await selfImprove({
      ...common(),
      agent: async (surface, _scenario, context) => {
        const paid = await context.cost.runPaidCall({
          actor: 'worker',
          model: 'fixture@2026-07-25',
          execute: async () => ({ quality: surface === 'BASE' ? 0 : 1 }),
          receipt: () => ({
            model: 'fixture@2026-07-25',
            inputTokens: 10,
            outputTokens: 5,
            actualCostUsd: 1,
          }),
        })
        if (!paid.succeeded) throw paid.error
        return paid.value
      },
      method: {
        name: 'metered',
        optimize: async (input) => {
          const paid = await input.costLedger.runPaidCall({
            actor: 'optimizer',
            model: 'fixture',
            phase: 'method-search',
            channel: 'driver',
            execute: async () => 'WIN',
            receipt: () => ({
              model: 'fixture',
              inputTokens: 20,
              outputTokens: 10,
              actualCostUsd: 3,
            }),
          })
          if (!paid.succeeded) throw paid.error
          return {
            winnerSurface: paid.value,
            cost: {
              ...freeCost,
              totalCostUsd: 3,
              costProvenance: { kind: 'observed', usd: 3 },
            },
          }
        },
      },
    })
    expect(result.totalCostUsd).toBe(7)
    expect(result.ledgerCost.totalCostUsd).toBe(7)
    expect(result.cost.accountingComplete).toBe(true)
    expect(result.receipts).toHaveLength(5)
  })

  it.each([false, true])(
    'retains newly metered spend when a method reports zero (unknown usage: %s)',
    async (usageUnknown) => {
      const options = common()
      const priorLedger = createRunCostLedger({ storage: options.storage, runDir: options.runDir })
      const prior = await priorLedger.runPaidCall({
        actor: 'prior-work',
        model: 'fixture',
        phase: 'prior',
        channel: 'driver',
        execute: async () => undefined,
        receipt: () => ({ model: 'fixture', inputTokens: 1, outputTokens: 1, actualCostUsd: 11 }),
      })
      if (!prior.succeeded) throw prior.error
      const result = await selfImprove({
        ...options,
        agent: async (surface) => ({ quality: surface === 'BASE' ? 0 : 1 }),
        method: {
          name: 'underreported',
          optimize: async (input) => {
            const paid = await input.costLedger.runPaidCall({
              actor: 'optimizer',
              model: 'fixture',
              phase: 'method-search',
              channel: 'driver',
              execute: async () => 'WIN',
              receipt: () => ({
                model: 'fixture',
                inputTokens: 20,
                outputTokens: 10,
                actualCostUsd: 3,
                usageUnknown,
              }),
            })
            if (!paid.succeeded) throw paid.error
            return { winnerSurface: paid.value, cost: freeCost }
          },
        },
      })
      expect(result.totalCostUsd).toBe(3)
      expect(result.ledgerCost.totalCostUsd).toBe(14)
      expect(result.raw.method.cost.totalCostUsd).toBe(0)
      expect(result.cost.accountingComplete).toBe(false)
      expect(result.cost.incompleteReasons.join(' ')).toContain(
        'reported 0 USD below recorded 3 USD',
      )
      if (usageUnknown) {
        expect(result.cost.incompleteReasons.join(' ')).toContain('token usage unknown')
      }
    },
  )

  it('does not mark equivalent floating-point cost sums as underreported', async () => {
    const result = await selfImprove({
      ...common(),
      agent: async (surface) => ({ quality: surface === 'BASE' ? 0 : 1 }),
      method: {
        name: 'rounded-sum',
        optimize: async (input) => {
          for (const usd of [0.1, 0.2, 0.3]) {
            const paid = await input.costLedger.runPaidCall({
              actor: 'optimizer',
              model: 'fixture',
              phase: 'search',
              channel: 'driver',
              execute: async () => undefined,
              receipt: () => ({
                model: 'fixture',
                inputTokens: 1,
                outputTokens: 1,
                actualCostUsd: usd,
              }),
            })
            if (!paid.succeeded) throw paid.error
          }
          return {
            winnerSurface: 'WIN',
            cost: {
              ...freeCost,
              totalCostUsd: 0.6,
              costProvenance: { kind: 'observed', usd: 0.6 },
            },
          }
        },
      },
    })
    expect(result.totalCostUsd).toBeCloseTo(0.6)
    expect(result.cost.accountingComplete).toBe(true)
    expect(result.cost.incompleteReasons).toEqual([])
  })

  it('keeps deferred final measurements absent without executing search again', async () => {
    let executions = 0
    const result = await selfImprove({
      ...common(),
      budget: { holdout: 'deferred' },
      agent: async () => {
        executions++
        return { quality: 1 }
      },
      method: {
        name: 'selected',
        optimize: async () => ({ winnerSurface: 'WIN', cost: freeCost }),
      },
    })
    expect(executions).toBe(0)
    expect(result.baseline).toBeNull()
    expect(result.winner.compositeMean).toBeNull()
    expect(result.winner.surface).toBe('WIN')
    expect(result.lift).toBeUndefined()
    expect(result.gateDecision).toBe('hold')
    expect(result.provenance.heldOutLift).toBeUndefined()
  })

  it('rejects a final comparison that loses one replica of each candidate case', async () => {
    let failedCells = 0
    await expect(
      compareOptimizationMethods({
        methods: [
          { name: 'partial', optimize: async () => ({ winnerSurface: 'WIN', cost: freeCost }) },
        ],
        baselineSurface: 'BASE',
        trainScenarios: scenarios.slice(0, 3),
        selectionScenarios: [scenarios[3]!],
        testScenarios: scenarios.slice(4),
        judges: [judge],
        reps: 2,
        expectUsage: 'off',
        storage: inMemoryCampaignStorage(),
        runDir: 'mem://partial-replicas',
        dispatchWithSurface: async (surface, _scenario, context) => {
          if (surface === 'WIN' && context.rep === 1) {
            failedCells++
            throw new Error('dispatch failed')
          }
          return { quality: surface === 'WIN' ? 1 : 0.5 }
        },
      }),
    ).rejects.toThrow(/final comparison is incomplete \(2\/4 designed cells scorable\)/)
    expect(failedCells).toBe(2)
  })

  it('cannot ship a new native candidate using a previous candidate cache', async () => {
    const options = common()
    let executions = 0
    const agent = async (surface: unknown) => {
      executions++
      return { quality: surface === 'GOOD' ? 1 : 0 }
    }
    const first = await selfImprove({
      ...options,
      agent,
      budget: { ...options.budget, generations: 1 },
      proposer: { kind: 'fixed', propose: async () => ['GOOD'] },
    })
    const beforeSecond = executions
    const second = await selfImprove({
      ...options,
      agent,
      budget: { ...options.budget, generations: 1 },
      proposer: { kind: 'fixed', propose: async () => ['BAD'] },
    })
    expect(first.winner.surface).toBe('GOOD')
    expect(second.winner.surface).toBe('BASE')
    expect(second.gateDecision).toBe('hold')
    expect(second.lift).toBe(0)
    expect(executions - beforeSecond).toBe(4)
    expect(
      second.raw.generations[0]!.surfaces[0]!.campaign.cells.every((cell) => cell.cached === false),
    ).toBe(true)
  })

  it('rejects a premeasured baseline from a different judge revision', async () => {
    const train = scenarios.slice(0, 3)
    const oldBaseline = await runCampaign({
      scenarios: train,
      dispatch: async () => ({ quality: 1 }),
      dispatchRef: surfaceDispatchRef('BASE'),
      judges: [
        {
          ...judge,
          judgeVersion: 'old',
          score: () => ({ composite: 0, dimensions: { quality: 0 }, notes: '' }),
        },
      ],
      expectUsage: 'off',
      storage: inMemoryCampaignStorage(),
      runDir: 'mem://old-judge',
    })
    let executions = 0
    await expect(
      runOptimization({
        scenarios: train,
        baselineSurface: 'BASE',
        premeasuredBaseline: { surfaceHash: surfaceHash('BASE'), campaign: oldBaseline },
        judges: [{ ...judge, judgeVersion: 'new' }],
        proposer: { kind: 'fixed', propose: async () => ['WIN'] },
        dispatchWithSurface: async () => {
          executions++
          return { quality: 0.5 }
        },
        populationSize: 1,
        maxGenerations: 1,
        expectUsage: 'off',
        storage: inMemoryCampaignStorage(),
        runDir: 'mem://new-judge',
      }),
    ).rejects.toThrow(/premeasured baseline evaluator identity does not match/)
    expect(executions).toBe(0)
  })

  it('does not label a native candidate mean as an estimated confidence interval', async () => {
    const options = common()
    const records: Array<{ composite: number | null; ci95: [number, number] | null }> = []
    const result = await selfImprove({
      ...options,
      budget: { ...options.budget, generations: 2 },
      agent: async (surface, scenario) => ({
        quality: surface === 'BASE' ? 0 : scenario.id === 't1' ? 1 : 0,
      }),
      proposer: {
        kind: 'fixed',
        propose: async () => ['WIN'],
        decide: ({ history }) => {
          for (const generation of history) records.push(...generation.candidates)
          return { stop: history.length > 0 }
        },
      },
    })
    expect(result.raw.generations).toHaveLength(1)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ composite: 0.25, ci95: null })
  })
})
