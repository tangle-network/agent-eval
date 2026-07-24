/**
 * selfImprove() power-analysis wiring proof — offline, deterministic.
 *
 * Drives the REAL loop (baseline-only, no LLM) with a variance-bearing judge and
 * asserts the result carries the minimum-detectable-lift analysis and that the
 * `power.estimated` progress event fires. The MDE math itself is unit-tested in
 * campaign/gates/power-preflight.test.ts; this guards the composition.
 */

import { describe, expect, it } from 'vitest'
import type { OptimizationMethod } from '../campaign/presets/compare-optimization-methods'
import { runCampaign } from '../campaign/run-campaign'
import { inMemoryCampaignStorage } from '../campaign/storage'
import { surfaceHash } from '../campaign/surface-identity'
import type { CodeSurface, Gate, JudgeConfig, SurfaceProposer } from '../campaign/types'
import { CostLedger, type CostLedgerHandle } from '../cost-ledger'
import type { DispatchContext, Scenario } from './index'
import { type SelfImproveProgressEvent, SelfImproveRunError, selfImprove } from './self-improve'

const scenarios: Scenario[] = Array.from({ length: 8 }, (_, i) => ({
  id: `s${i}`,
  kind: 'fixture',
}))

// Alternating 0/1 composites: real variance for the power estimate.
const judge: JudgeConfig<{ text: string }, Scenario> = {
  name: 'variance-judge',
  dimensions: [{ key: 'q', description: 'fixture quality' }],
  score: ({ scenario }) => {
    const flip = Number.parseInt(scenario.id.slice(1), 10) % 2
    return { dimensions: { q: flip }, composite: flip, notes: '' }
  },
}

async function stubAgent(
  surface: unknown,
  _scenario: Scenario,
  ctx: DispatchContext,
): Promise<{ text: string }> {
  const paid = await ctx.cost.runPaidCall({
    actor: 'stub-agent',
    model: 'stub-model',
    execute: async () => ({ text: String(surface) }),
    receipt: () => ({
      model: 'stub-model',
      inputTokens: 1,
      outputTokens: 1,
      actualCostUsd: 0.0001,
    }),
  })
  if (!paid.succeeded) throw paid.error
  return paid.value
}

function codeSurface(worktreeRef: string): CodeSurface {
  return {
    kind: 'code',
    worktreeRef,
    baseRef: 'main',
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    candidateCommit: '3'.repeat(40),
    candidateTree: '4'.repeat(40),
    patch: {
      format: 'git-diff-binary',
      sha256: `sha256:${'5'.repeat(64)}`,
      byteLength: 1,
    },
  }
}

describe('selfImprove — power analysis wiring', () => {
  it('attaches the MDE analysis to the result and emits power.estimated', async () => {
    const events: SelfImproveProgressEvent[] = []
    const result = await selfImprove({
      agent: stubAgent,
      scenarios,
      judge,
      baselineSurface: 'be careful',
      budget: { generations: 0, holdoutFraction: 0.5 },
      onProgress: (e) => events.push(e),
    })

    expect(result.power).toBeDefined()
    const power = result.power
    if (!power) throw new Error('unreachable')
    expect(power.n).toBeGreaterThanOrEqual(3)
    expect(power.sd).toBeGreaterThan(0.3) // alternating 0/1 cells
    expect(power.mde).toBeGreaterThan(power.deltaThreshold)
    expect(power.recommendation.length).toBeGreaterThan(20)

    const powerEvents = events.filter((e) => e.kind === 'power.estimated')
    expect(powerEvents).toHaveLength(1)
  })
})

describe('selfImprove — complete optimization methods', () => {
  const methodJudge: JudgeConfig<{ text: string }, Scenario> = {
    name: 'method-quality',
    dimensions: [{ key: 'quality', description: 'candidate quality' }],
    score: ({ artifact }) => {
      const quality = artifact.text === 'BETTER' ? 1 : 0
      return { dimensions: { quality }, composite: quality, notes: '' }
    },
  }
  const shipGate: Gate<{ text: string }, Scenario> = {
    name: 'ship',
    decide: async () => ({ decision: 'ship', reasons: [], contributingGates: [] }),
  }

  it('gives a method only train and selection cases, shares spend, and retains source identity', async () => {
    const all = Array.from({ length: 8 }, (_, index) => ({
      id: `method-${index}`,
      kind: 'fixture',
    }))
    const finalCases = all.slice(6)
    const selectionCases = all.slice(4, 6)
    let seenTrain: string[] = []
    let seenSelection: string[] = []
    const method: OptimizationMethod<Scenario, { text: string }> = {
      name: 'official:test',
      optimize: async (input) => {
        seenTrain = input.trainScenarios.map((scenario) => scenario.id)
        seenSelection = input.selectionScenarios.map((scenario) => scenario.id)
        const paid = await input.costLedger.runPaidCall({
          channel: 'optimizer',
          phase: 'official.test',
          actor: 'official:test',
          model: 'test-model',
          maximumCharge: { externallyEnforcedMaximumUsd: 0.02 },
          execute: async () => 'BETTER',
          receipt: () => ({
            model: 'test-model',
            inputTokens: 10,
            outputTokens: 5,
            actualCostUsd: 0.02,
          }),
        })
        if (!paid.succeeded) throw paid.error
        return {
          winnerSurface: paid.value,
          cost: {
            totalCostUsd: 0.02,
            accountingComplete: true,
            incompleteReasons: [],
          },
          durationMs: 3,
          provenance: {
            source: {
              kind: 'package',
              evidence: 'observed',
              package: 'official-test',
              version: '1.0.0',
              sourceUrl: 'https://example.test/official-test',
              revision: 'abc123',
            },
            optimizerModel: 'test-model@2026-07-24',
            runId: 'official-run',
            resumed: false,
            evaluationCount: 6,
            artifactDir: '/tmp/official-test',
            tokenUsage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 5,
              reasoningTokens: 0,
              totalTokens: 15,
              calls: 1,
            },
          },
        }
      },
    }

    const result = await selfImprove({
      agent: async (surface) => ({ text: String(surface) }),
      scenarios: all,
      selectionScenarios: selectionCases,
      judge: methodJudge,
      baselineSurface: 'BASE',
      method,
      gate: shipGate,
      runDir: 'mem://self-improve-method',
      storage: inMemoryCampaignStorage(),
      expectUsage: 'off',
      budget: {
        generations: 1,
        populationSize: 1,
        holdoutScenarios: finalCases,
      },
    })

    expect(seenTrain).toEqual(all.slice(0, 4).map((scenario) => scenario.id))
    expect(seenSelection).toEqual(selectionCases.map((scenario) => scenario.id))
    expect([...seenTrain, ...seenSelection]).not.toContain(finalCases[0]!.id)
    expect([...seenTrain, ...seenSelection]).not.toContain(finalCases[1]!.id)
    expect(result.winner.surface).toBe('BETTER')
    expect(result.totalCostUsd).toBe(0.02)
    expect(result.optimization).toEqual({
      name: 'official:test',
      cost: {
        totalCostUsd: 0.02,
        accountingComplete: true,
        incompleteReasons: [],
      },
      durationMs: 3,
      provenance: expect.objectContaining({
        source: expect.objectContaining({
          package: 'official-test',
          revision: 'abc123',
        }),
        optimizerModel: 'test-model@2026-07-24',
        runId: 'official-run',
      }),
    })
    expect(result.provenance.optimizationMethod).toEqual(result.optimization)
    expect(result.provenance.optimizationMethod?.provenance?.optimizerModel).toBe(
      'test-model@2026-07-24',
    )
    expect(result.receipts).toEqual([
      expect.objectContaining({
        channel: 'optimizer',
        phase: 'official.test',
        costUsd: 0.02,
      }),
    ])
  })

  it('rejects ambiguous local-loop controls in method mode', async () => {
    const method: OptimizationMethod<Scenario, { text: string }> = {
      name: 'official:test',
      optimize: async () => ({
        winnerSurface: 'BETTER',
        cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
      }),
    }
    await expect(
      selfImprove({
        agent: async (surface) => ({ text: String(surface) }),
        scenarios,
        judge: methodJudge,
        baselineSurface: 'BASE',
        method,
        proposer: { kind: 'also-set', propose: async () => ['OTHER'] },
        expectUsage: 'off',
      }),
    ).rejects.toThrow('method and proposer are mutually exclusive')

    await expect(
      selfImprove({
        agent: async (surface) => ({ text: String(surface) }),
        scenarios,
        judge: methodJudge,
        baselineSurface: 'BASE',
        method,
        expectUsage: 'off',
        budget: { generations: 2 },
      }),
    ).rejects.toThrow('method owns its rounds')
  })
})

describe('selfImprove — hosted code-surface identity', () => {
  it('uses the content identity in snapshots instead of the mutable worktree path', async () => {
    const baseline = codeSurface('/tmp/candidate-a')
    const sameBytesElsewhere = codeSurface('/tmp/candidate-b')
    const payloads: Array<{
      events?: Array<{
        baseline?: { surfaceHash: string }
        generations: Array<{ surfaceHash: string }>
      }>
    }> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (typeof init?.body === 'string') payloads.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ accepted: 1, rejected: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const proposer: SurfaceProposer = {
      kind: 'code-candidate',
      propose: async () => [sameBytesElsewhere],
    }

    await selfImprove({
      agent: stubAgent,
      scenarios,
      judge,
      baselineSurface: baseline,
      proposer,
      budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5 },
      hostedTenant: {
        endpoint: 'https://ingest.example',
        apiKey: 'test-key',
        tenantId: 'test-tenant',
        fetchImpl,
      },
    })

    const expected = surfaceHash(baseline)
    const event = payloads
      .flatMap((payload) => payload.events ?? [])
      .find((candidate) => candidate.baseline?.surfaceHash === expected)
    expect(event).toBeDefined()
    expect(event?.generations[0]?.surfaceHash).toBe(expected)
    expect(surfaceHash(sameBytesElsewhere)).toBe(expected)
  })
})

describe('selfImprove — neutralize (placebo arm) passthrough', () => {
  it('forwards `neutralize`: runs the placebo arm and hands its scores to the gate', async () => {
    let neutralizeCalled = false
    let gateSawNeutralized = false

    // Rewards only the surface containing "better", so the proposed candidate
    // beats the baseline → the loop promotes a winner ≠ baseline → the placebo
    // arm runs (it is skipped when winner == baseline).
    const winJudge: JudgeConfig<{ text: string }, Scenario> = {
      name: 'win-judge',
      dimensions: [{ key: 'q', description: 'fixture quality' }],
      score: ({ artifact }) => {
        const good = artifact.text.includes('better') ? 1 : 0
        return { dimensions: { q: good }, composite: good, notes: '' }
      },
    }
    const proposer: SurfaceProposer = { kind: 'stub', propose: async () => ['better'] }
    const captureGate: Gate<{ text: string }, Scenario> = {
      name: 'capture',
      async decide(ctx) {
        gateSawNeutralized = (ctx.neutralizedJudgeScores?.size ?? 0) > 0
        return { decision: 'hold', reasons: [], contributingGates: [] }
      },
    }

    await selfImprove({
      agent: stubAgent,
      scenarios,
      judge: winJudge,
      baselineSurface: 'base',
      proposer,
      gate: captureGate,
      budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5 },
      neutralize: (winner) => {
        neutralizeCalled = true
        // footprint-matched-ish blank: same length, zero content
        return '#'.repeat(String(winner).length)
      },
    })

    expect(neutralizeCalled).toBe(true)
    expect(gateSawNeutralized).toBe(true)
  })
})

describe('selfImprove — run-wide spend account', () => {
  const spendScenarios: Scenario[] = Array.from({ length: 3 }, (_, i) => ({
    id: `cost-${i}`,
    kind: 'fixture',
  }))
  const spendJudge: JudgeConfig<{ text: string }, Scenario> = {
    name: 'surface-quality',
    dimensions: [{ key: 'quality', description: 'candidate quality' }],
    score: ({ artifact }) => {
      const quality = artifact.text === 'BETTER' ? 1 : 0
      return { dimensions: { quality }, composite: quality, notes: '' }
    },
  }
  const spendProposer: SurfaceProposer = {
    kind: 'cost-proof',
    propose: async () => ['BETTER'],
  }
  const spendGate: Gate<{ text: string }, Scenario> = {
    name: 'cost-proof',
    decide: async () => ({ decision: 'ship', reasons: [], contributingGates: [] }),
  }
  const spendBase = {
    scenarios: spendScenarios,
    judge: spendJudge,
    baselineSurface: 'BASE',
    proposer: spendProposer,
    gate: spendGate,
    budget: { generations: 1, populationSize: 1, maxConcurrency: 1 },
  }

  it('wraps a frozen provider error without losing its cause or receipt', async () => {
    const ledger = new CostLedger()
    const frozen = Object.freeze(new Error('frozen provider failure'))
    const paid = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search.baseline',
      actor: 'worker',
      model: 'provider-receipt',
      execute: async () => {
        throw frozen
      },
      receipt: () => ({ model: 'provider-receipt', inputTokens: 0, outputTokens: 0 }),
      receiptFromError: () => ({
        model: 'provider-receipt',
        inputTokens: 10,
        outputTokens: 5,
        actualCostUsd: 0.4,
      }),
    })
    if (paid.succeeded) throw new Error('expected paid call to fail')

    const wrapped = new SelfImproveRunError(paid.error, ledger)
    expect(wrapped.cause).toBe(frozen)
    expect(wrapped.cost.totalCostUsd).toBe(0.4)
    expect(wrapped.receipts).toEqual([
      expect.objectContaining({ actor: 'worker', error: 'frozen provider failure' }),
    ])
  })

  function paidAgent(amount: number, onCall?: () => void) {
    return async (surface: unknown, _scenario: Scenario, ctx: DispatchContext) => {
      const paid = await ctx.cost.runPaidCall({
        actor: 'worker',
        model: 'provider-receipt',
        maximumCharge: { externallyEnforcedMaximumUsd: amount },
        execute: async () => {
          onCall?.()
          return { text: String(surface) }
        },
        receipt: () => ({
          model: 'provider-receipt',
          inputTokens: 10,
          outputTokens: 5,
          actualCostUsd: amount,
        }),
      })
      if (!paid.succeeded) throw paid.error
      return paid.value
    }
  }

  it('reports all six measured $0.60 dispatches across search and holdout', async () => {
    let calls = 0
    const result = await selfImprove({
      ...spendBase,
      agent: paidAgent(0.6, () => calls++),
    })

    expect(calls).toBe(6)
    expect(result.totalCostUsd).toBeCloseTo(3.6, 9)
    expect(result.receipts).toHaveLength(6)
    expect(result.receipts.map((entry) => entry.phase)).toEqual([
      'search.baseline',
      'search.baseline',
      'search.candidate',
      'search.candidate',
      'holdout.baseline',
      'holdout.winner',
    ])
    expect(result.receipts.every((entry) => entry.actor === 'worker')).toBe(true)
  })

  it('shares the same account with paid proposal, analysis, and promotion work', async () => {
    const seenLedgers = new Set<unknown>()
    const charge = async (
      context: { costLedger?: CostLedgerHandle; costPhase?: string },
      amount: number,
      channel: 'driver' | 'judge' | 'analyst' | 'verifier',
      actor: string,
    ): Promise<void> => {
      if (!context.costLedger || !context.costPhase) throw new Error('missing cost account')
      seenLedgers.add(context.costLedger)
      const paid = await context.costLedger.runPaidCall({
        channel,
        phase: context.costPhase,
        actor,
        model: 'provider-receipt',
        execute: async () => undefined,
        receipt: () => ({
          model: 'provider-receipt',
          inputTokens: 0,
          outputTokens: 0,
          actualCostUsd: amount,
        }),
      })
      if (!paid.succeeded) throw paid.error
    }
    const paidProposer: SurfaceProposer = {
      kind: 'paid-proposer',
      propose: async (ctx) => {
        await charge(ctx, 0.1, 'driver', 'proposer')
        return ['BETTER']
      },
    }
    const paidGate: Gate<{ text: string }, Scenario> = {
      name: 'paid-gate',
      decide: async (ctx) => {
        await charge(ctx, 0.3, 'verifier', 'promoter')
        return { decision: 'ship', reasons: [], contributingGates: [] }
      },
    }

    const result = await selfImprove({
      ...spendBase,
      agent: paidAgent(0.1),
      judge: {
        ...spendJudge,
        score: async (ctx) => {
          await charge(ctx, 0.05, 'judge', 'paid-judge')
          return await spendJudge.score(ctx)
        },
      },
      proposer: paidProposer,
      gate: paidGate,
      analyzeGeneration: async (ctx) => {
        await charge(ctx, 0.2, 'analyst', 'analyst')
        return []
      },
    })

    expect(seenLedgers.size).toBe(1)
    expect(result.totalCostUsd).toBeCloseTo(1.5, 9)
    expect(result.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'search.proposal', actor: 'proposer' }),
        expect.objectContaining({ phase: 'analysis.baseline', actor: 'analyst' }),
        expect.objectContaining({ phase: 'promotion.gate', actor: 'promoter' }),
      ]),
    )
  })

  it('refuses a paid dispatch whose reservation would exceed the run cap', async () => {
    let calls = 0
    let thrown: unknown
    try {
      await selfImprove({
        ...spendBase,
        agent: paidAgent(0.6, () => calls++),
        budget: { ...spendBase.budget, dollars: 1 },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(calls).toBe(1)
    const accounted = thrown as SelfImproveRunError
    expect(accounted.cost.totalCostUsd).toBeCloseTo(0.6, 9)
    expect(accounted.cost.totalCostUsd).toBeLessThanOrEqual(1)
    expect(accounted.receipts).toHaveLength(1)
  })

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects invalid dollar budgets before dispatch: %s', async (dollars) => {
    let calls = 0
    await expect(
      selfImprove({
        ...spendBase,
        agent: paidAgent(0, () => calls++),
        budget: { ...spendBase.budget, dollars },
      }),
    ).rejects.toThrow(/costCeilingUsd/)
    expect(calls).toBe(0)
  })
})

describe('selfImprove — premeasured baseline passthrough', () => {
  const premeasuredScenarios: Scenario[] = Array.from({ length: 4 }, (_, i) => ({
    id: `p${i}`,
    kind: 'fixture',
  }))
  const holdoutScenarios = [premeasuredScenarios[3]!]
  const trainScenarios = premeasuredScenarios.slice(0, 3)
  const winJudge: JudgeConfig<{ text: string }, Scenario> = {
    name: 'win-judge',
    dimensions: [{ key: 'q', description: 'fixture quality' }],
    score: ({ artifact }) => {
      const good = artifact.text === 'BETTER' ? 1 : 0
      return { dimensions: { q: good }, composite: good, notes: '' }
    },
  }

  it('forwards premeasuredBaseline and skips the baseline search dispatch', async () => {
    // Premeasure the baseline over the exact TRAIN split (seed 42 = the
    // selfImprove default) with the same judge.
    const premeasured = await runCampaign<Scenario, { text: string }>({
      scenarios: trainScenarios,
      dispatch: (scenario, ctx) => stubAgent('BASE', scenario, ctx),
      dispatchRef: 'test:selfimprove-premeasured',
      judges: [winJudge],
      seed: 42,
      reps: 1,
      resumable: false,
      runDir: '/premeasured/self-improve-source',
      storage: inMemoryCampaignStorage(),
      tracing: 'off',
      expectUsage: 'off',
    })

    const dispatched: Array<{ surface: unknown; scenarioId: string }> = []
    const proposer: SurfaceProposer = { kind: 'stub', propose: async () => ['BETTER'] }
    const result = await selfImprove<Scenario, { text: string }>({
      agent: (surface, scenario, ctx) => {
        dispatched.push({ surface, scenarioId: scenario.id })
        return stubAgent(surface, scenario, ctx)
      },
      scenarios: premeasuredScenarios,
      judge: winJudge,
      baselineSurface: 'BASE',
      premeasuredBaseline: { surfaceHash: surfaceHash('BASE'), campaign: premeasured },
      proposer,
      budget: { generations: 1, populationSize: 1, holdoutScenarios },
    })

    // The baseline surface is NEVER dispatched on the train split — the
    // premeasured campaign replaced that entire arm. It still runs on the
    // holdout arm, which premeasuredBaseline does not cover.
    const baselineDispatches = dispatched.filter((d) => d.surface === 'BASE')
    expect(baselineDispatches.map((d) => d.scenarioId)).toEqual(['p3'])
    // Candidate: train (3 scenarios) + winner holdout (1 scenario).
    expect(dispatched.filter((d) => d.surface === 'BETTER')).toHaveLength(4)
    // The imported campaign is the baseline search measurement, by identity.
    expect(result.raw.baselineCampaign).toBe(premeasured)
    expect(result.winner.surface).toBe('BETTER')
  })
})

describe('selfImprove — maxImprovementShots passthrough', () => {
  it('forwards budget.maxImprovementShots to the proposer ctx', async () => {
    const seen: Array<number | undefined> = []
    const proposer: SurfaceProposer = {
      kind: 'shots-probe',
      propose: async (ctx) => {
        seen.push(ctx.maxImprovementShots)
        return ['BETTER']
      },
    }

    await selfImprove({
      agent: stubAgent,
      scenarios,
      judge,
      baselineSurface: 'base',
      proposer,
      budget: {
        generations: 1,
        populationSize: 1,
        holdoutFraction: 0.5,
        maxImprovementShots: 7,
      },
    })

    expect(seen).toEqual([7])
  })

  it('leaves ctx.maxImprovementShots unset when the budget omits it', async () => {
    const seen: Array<number | undefined> = []
    const proposer: SurfaceProposer = {
      kind: 'shots-probe',
      propose: async (ctx) => {
        seen.push(ctx.maxImprovementShots)
        return ['BETTER']
      },
    }

    await selfImprove({
      agent: stubAgent,
      scenarios,
      judge,
      baselineSurface: 'base',
      proposer,
      budget: { generations: 1, populationSize: 1, holdoutFraction: 0.5 },
    })

    expect(seen).toEqual([undefined])
  })
})

describe('selfImprove — candidate ranking passthrough', () => {
  it('uses selectionRankKey for the loop winner', async () => {
    const rankingJudge: JudgeConfig<{ text: string }, Scenario> = {
      name: 'ranking',
      dimensions: [{ key: 'quality', description: 'fixture quality' }],
      score: ({ artifact }) => {
        const quality =
          artifact.text === 'MEAN-WINNER' ? 1 : artifact.text === 'RANK-WINNER' ? 0.5 : 0
        return { dimensions: { quality }, composite: quality, notes: '' }
      },
    }
    const proposer: SurfaceProposer = {
      kind: 'ranking-probe',
      propose: async () => ['MEAN-WINNER', 'RANK-WINNER'],
    }
    const rankedSurfaces: string[] = []

    const result = await selfImprove({
      agent: stubAgent,
      scenarios,
      judge: rankingJudge,
      baselineSurface: 'BASELINE',
      proposer,
      budget: { generations: 1, populationSize: 2, holdoutFraction: 0.5 },
      selectionRankKey: (campaign) => {
        const surface = campaign.cells[0]?.artifact?.text ?? 'BASELINE'
        rankedSurfaces.push(surface)
        return [surface === 'RANK-WINNER' ? 2 : surface === 'MEAN-WINNER' ? 1 : 0]
      },
    })

    expect(rankedSurfaces).toEqual(
      expect.arrayContaining(['BASELINE', 'MEAN-WINNER', 'RANK-WINNER']),
    )
    expect(result.winner.surface).toBe('RANK-WINNER')
  })
})

describe('selfImprove — candidate concurrency passthrough', () => {
  async function observedCandidateConcurrency(candidateConcurrency?: number): Promise<number> {
    let active = 0
    let maxActive = 0
    const expected = candidateConcurrency ?? 1
    let releaseExpected: () => void = () => undefined
    const expectedActive = new Promise<void>((resolve) => {
      releaseExpected = resolve
    })
    const proposer: SurfaceProposer = {
      kind: 'concurrency-probe',
      propose: async () => ['CANDIDATE-1', 'CANDIDATE-2', 'CANDIDATE-3'],
    }

    await selfImprove({
      agent: async (surface, scenario, ctx) => {
        if (surface === 'BASELINE') return stubAgent(surface, scenario, ctx)
        active += 1
        maxActive = Math.max(maxActive, active)
        if (active === expected) releaseExpected()
        try {
          await expectedActive
          return await stubAgent(surface, scenario, ctx)
        } finally {
          active -= 1
        }
      },
      scenarios,
      judge,
      baselineSurface: 'BASELINE',
      proposer,
      budget: {
        generations: 1,
        populationSize: 3,
        maxConcurrency: 1,
        holdout: 'deferred',
        ...(candidateConcurrency === undefined ? {} : { candidateConcurrency }),
      },
    })

    return maxActive
  }

  it('scores one candidate campaign at a time by default', async () => {
    expect(await observedCandidateConcurrency()).toBe(1)
  })

  it('forwards an explicit concurrent candidate count', async () => {
    expect(await observedCandidateConcurrency(2)).toBe(2)
  })
})

describe('selfImprove — deferred holdout', () => {
  const winJudge: JudgeConfig<{ text: string }, Scenario> = {
    name: 'win-judge',
    dimensions: [{ key: 'q', description: 'fixture quality' }],
    score: ({ artifact }) => {
      const good = artifact.text === 'BETTER' ? 1 : 0
      return { dimensions: { q: good }, composite: good, notes: '' }
    },
  }

  it('dispatches zero holdout cells, forces hold, and omits lift', async () => {
    const dispatched: Array<{ surface: unknown; scenarioId: string }> = []
    const events: SelfImproveProgressEvent[] = []
    const proposer: SurfaceProposer = { kind: 'stub', propose: async () => ['BETTER'] }

    const result = await selfImprove<Scenario, { text: string }>({
      agent: (surface, scenario, ctx) => {
        dispatched.push({ surface, scenarioId: scenario.id })
        return stubAgent(surface, scenario, ctx)
      },
      scenarios,
      judge: winJudge,
      baselineSurface: 'base',
      proposer,
      budget: { generations: 1, populationSize: 1, holdout: 'deferred' },
      onProgress: (event) => events.push(event),
    })

    // ALL scenarios train (no split), and only search campaigns dispatch:
    // baseline (8) + one candidate (8). Zero holdout cells.
    expect(dispatched).toHaveLength(16)
    expect(result.raw.baselineOnHoldout.cells).toHaveLength(0)
    expect(result.raw.winnerOnHoldout.cells).toHaveLength(0)
    expect(result.raw.holdout).toBe('deferred')

    // Forced hold, absent (not zero) lift.
    expect(result.gateDecision).toBe('hold')
    expect(result.raw.gateResult.contributingGates).toEqual([
      { name: 'holdout-deferred', passed: false, detail: { holdout: 'deferred' } },
    ])
    expect('lift' in result).toBe(false)
    expect(result.lift).toBeUndefined()

    // The gate.decided progress event also omits `lift` — the search-split
    // delta must not masquerade as a held-out lift.
    const gateEvents = events.filter((e) => e.kind === 'gate.decided')
    expect(gateEvents).toHaveLength(1)
    expect(gateEvents[0]).toEqual({ kind: 'gate.decided', decision: 'hold' })

    // Provenance records the mode instead of a fabricated 0-lift.
    expect(result.provenance.holdout).toBe('deferred')
    expect(result.provenance.heldOutLift).toBeUndefined()
    expect(result.provenance.baselineHoldoutComposite).toBeUndefined()
    expect(result.provenance.winnerHoldoutComposite).toBeUndefined()

    // Search promotion still ran: summary stats come from the search split.
    expect(result.winner.surface).toBe('BETTER')
    expect(result.winner.compositeMean).toBe(1)
    expect(result.baseline.compositeMean).toBe(0)
    // No holdout cells ⇒ no power analysis.
    expect(result.power).toBeUndefined()
  })

  it('keeps an explicitly reserved holdout set out of training even when deferred', async () => {
    const dispatched: string[] = []
    const proposer: SurfaceProposer = { kind: 'stub', propose: async () => ['BETTER'] }
    const reserved = [scenarios[0]!]

    const result = await selfImprove<Scenario, { text: string }>({
      agent: (surface, scenario, ctx) => {
        dispatched.push(scenario.id)
        return stubAgent(surface, scenario, ctx)
      },
      scenarios,
      judge: winJudge,
      baselineSurface: 'base',
      proposer,
      budget: {
        generations: 1,
        populationSize: 1,
        holdout: 'deferred',
        holdoutScenarios: reserved,
      },
    })

    // The reserved scenario is excluded from training AND never dispatched.
    expect(dispatched).not.toContain('s0')
    expect(dispatched).toHaveLength(14) // baseline (7) + candidate (7)
    expect(result.raw.baselineOnHoldout.cells).toHaveLength(0)
    expect(result.gateDecision).toBe('hold')
  })
})
