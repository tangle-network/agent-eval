import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CompareOptimizationMethodsOptions,
  compareOptimizationMethods,
  type OptimizationMethod,
} from '../../src/campaign/presets/compare-optimization-methods'
import type { JudgeConfig } from '../../src/campaign/types'
import { CostLedger } from '../../src/cost-ledger'
import {
  type TestArtifact as A,
  completeCost,
  fixedMethod,
  incompleteCostMethod,
  solveJudge as judge,
  PARTITIONS,
  paidDispatch,
  type TestScenario as S,
  SELECTION,
  TEST,
  TRAIN,
} from './optimization-method-test-fixtures'

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'compare-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

describe('compareOptimizationMethods', () => {
  it('ranks methods by final-test lift and scores every winner uniformly', async () => {
    // Baseline solves nothing. The strong method solves all 4; the weak method solves 1.
    const result = await compareOptimizationMethods<S, A>({
      methods: [
        fixedMethod('weak', 'SOLVE_h1', 0.5),
        fixedMethod('strong', 'SOLVE_h1 SOLVE_h2 SOLVE_h3 SOLVE_h4', 2.0),
      ],
      baselineSurface: 'nothing-solved',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      seed: 7,
      expectUsage: 'off',
    })

    // Strong wins; ranks assigned by lift.
    expect(result.best.name).toBe('strong')
    expect(result.scores.map((s) => s.name)).toEqual(['strong', 'weak'])
    expect(result.scores[0]!.rank).toBe(1)
    expect(result.scores[1]!.rank).toBe(2)

    // Baseline is identical for every method.
    expect(result.scores[0]!.baselineComposite).toBe(0)
    expect(result.scores[1]!.baselineComposite).toBe(0)

    // Strong solves 4/4 → mean composite 1.0, lift 1.0; weak solves 1/4 → 0.25.
    const strong = result.scores.find((s) => s.name === 'strong')!
    const weak = result.scores.find((s) => s.name === 'weak')!
    expect(strong.winnerComposite).toBe(1)
    expect(strong.lift).toBeCloseTo(1, 5)
    expect(weak.winnerComposite).toBeCloseTo(0.25, 5)
    expect(weak.lift).toBeCloseTo(0.25, 5)
    // Costs are carried through.
    expect(strong.optimizationCost.totalCostUsd).toBe(2.0)
    expect(result.optimizationCost.totalCostUsd).toBe(2.5)
    expect(result.testCost.totalCostUsd).toBe(0)
    expect(result.totalCost.totalCostUsd).toBe(2.5)
    expect(result.confidence).toBe(0.95)
    expect(result.comparisonCount).toBe(3)
    expect(result.intervalConfidence).toBeCloseTo(1 - 0.05 / 3)
    expect(result.seed).toBe(7)
    expect(result.resamples).toBe(2000)
    expect(result.reps).toBe(1)

    // Pairwise: strong (best) vs weak — delta 0.75, favored strong.
    expect(result.pairwise).toHaveLength(1)
    const pw = result.pairwise[0]!
    expect(pw.a).toBe('strong')
    expect(pw.b).toBe('weak')
    expect(pw.deltaMean).toBeCloseTo(0.75, 5)
    expect(pw.favored).toBe('strong')
    expect(pw.low).toBeGreaterThan(0) // CI clears zero → a real difference
    expect(result.testScenarioIds).toEqual(['h1', 'h2', 'h3', 'h4'])
    expect(strong.scenarioScores).toEqual(
      TEST.map((scenario) => ({
        scenarioId: scenario.id,
        baselineComposite: 0,
        winnerComposite: 1,
        lift: 1,
      })),
    )
  })

  it('reports a tie when two methods solve the same scenarios', async () => {
    const result = await compareOptimizationMethods<S, A>({
      methods: [fixedMethod('a', 'SOLVE_h1 SOLVE_h2', 1), fixedMethod('b', 'SOLVE_h1 SOLVE_h2', 1)],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      seed: 7,
      expectUsage: 'off',
    })
    expect(result.pairwise[0]!.deltaMean).toBeCloseTo(0, 5)
    expect(result.pairwise[0]!.favored).toBe('tie')
  })

  it('a cheaper method wins a lift tie when both costs are complete', async () => {
    const result = await compareOptimizationMethods<S, A>({
      methods: [
        fixedMethod('expensive', 'SOLVE_h1 SOLVE_h2', 9),
        fixedMethod('cheap', 'SOLVE_h1 SOLVE_h2', 1),
      ],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      seed: 7,
      expectUsage: 'off',
    })
    expect(result.best.name).toBe('cheap')
  })

  it('does not let an incomplete zero-dollar report win a cost tie-break', async () => {
    const result = await compareOptimizationMethods<S, A>({
      methods: [
        fixedMethod('known-cost', 'SOLVE_h1 SOLVE_h2', 1),
        incompleteCostMethod('unknown-cost', 'SOLVE_h1 SOLVE_h2', 'provider omitted price'),
      ],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      expectUsage: 'off',
    })

    expect(result.best.name).toBe('known-cost')
    expect(result.optimizationCost.accountingComplete).toBe(false)
    expect(result.totalCost.accountingComplete).toBe(false)
    expect(result.optimizationCost.incompleteReasons).toEqual([
      "method 'unknown-cost': provider omitted price",
    ])
  })

  it('preserves declaration order for a lift tie when any cost is incomplete', async () => {
    const result = await compareOptimizationMethods<S, A>({
      methods: [
        fixedMethod('known-expensive', 'SOLVE_h1 SOLVE_h2', 9),
        incompleteCostMethod('unknown', 'SOLVE_h1 SOLVE_h2', 'provider omitted price'),
        fixedMethod('known-cheap', 'SOLVE_h1 SOLVE_h2', 1),
      ],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      expectUsage: 'off',
    })

    expect(result.scores.map((score) => score.name)).toEqual([
      'known-expensive',
      'unknown',
      'known-cheap',
    ])
  })

  it('reports optimization, final-test, and total cost separately', async () => {
    const result = await compareOptimizationMethods<S, A>({
      methods: [fixedMethod('method', 'SOLVE_h1', 0.5)],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: paidDispatch(),
      judges: [judge],
      runDir,
      maxConcurrency: 1,
      expectUsage: 'assert',
    })

    expect(result.optimizationCost.totalCostUsd).toBe(0.5)
    expect(result.testCost.totalCostUsd).toBeCloseTo(0.08)
    expect(result.totalCost.totalCostUsd).toBeCloseTo(0.58)
  })

  it('reports cumulative final cost when compatible cells resume from cache', async () => {
    let paidCalls = 0
    const options = {
      methods: [fixedMethod('same-as-baseline', 'same', 0)],
      baselineSurface: 'same',
      ...PARTITIONS,
      dispatchWithSurface: paidDispatch(() => {
        paidCalls += 1
      }),
      judges: [judge],
      runDir,
      costCeiling: 0.1,
      maxConcurrency: 1,
      expectUsage: 'assert' as const,
    }

    const first = await compareOptimizationMethods<S, A>(options)
    expect(paidCalls).toBe(4)
    const resumed = await compareOptimizationMethods<S, A>(options)

    expect(paidCalls).toBe(4)
    expect(first.testCost).toEqual({
      totalCostUsd: 0.04,
      accountingComplete: true,
      incompleteReasons: [],
    })
    expect(resumed.testCost).toEqual(first.testCost)
    expect(resumed.totalCost).toEqual(first.totalCost)
  })

  it('excludes unrelated receipts from a caller-provided final-test cost ledger', async () => {
    const costLedger = new CostLedger()
    await costLedger.runPaidCall({
      channel: 'agent',
      phase: 'unrelated-run',
      actor: 'prior-worker',
      model: 'unpriced-prior-model',
      execute: async () => undefined,
      receipt: () => ({
        model: 'unpriced-prior-model',
        inputTokens: 1,
        outputTokens: 1,
        costUnknown: true,
      }),
    })

    const result = await compareOptimizationMethods<S, A>({
      methods: [fixedMethod('method', 'SOLVE_h1', 0.5)],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: paidDispatch(),
      judges: [judge],
      runDir,
      costLedger,
      maxConcurrency: 1,
      expectUsage: 'assert',
    })

    expect(costLedger.summary().accountingComplete).toBe(false)
    expect(result.testCost.totalCostUsd).toBeCloseTo(0.08)
    expect(result.testCost.accountingComplete).toBe(true)
    expect(result.testCost.incompleteReasons).toEqual([])
  })

  it('applies one cost ceiling across baseline and winner test scoring', async () => {
    let paidCalls = 0
    await expect(
      compareOptimizationMethods<S, A>({
        methods: [fixedMethod('method', 'SOLVE_h1', 0)],
        baselineSurface: 'nothing',
        ...PARTITIONS,
        dispatchWithSurface: paidDispatch(() => {
          paidCalls += 1
        }),
        judges: [judge],
        runDir,
        maxConcurrency: 1,
        costCeiling: 0.05,
        expectUsage: 'assert',
      }),
    ).rejects.toThrow(/produced no test score/)
    expect(paidCalls).toBe(5)
  })

  it('applies costCeiling to optimization before final scoring starts', async () => {
    let optimizerExecutions = 0
    let finalDispatches = 0
    const spendingMethod = (name: string, costUsd: number): OptimizationMethod<S, A> => ({
      name,
      async optimize(input) {
        const paid = await input.costLedger.runPaidCall({
          channel: 'optimizer',
          phase: `${name}.search`,
          actor: name,
          model: 'optimizer-model',
          maximumCharge: { externallyEnforcedMaximumUsd: costUsd },
          execute: async () => {
            optimizerExecutions += 1
          },
          receipt: () => ({
            model: 'optimizer-model',
            inputTokens: 1,
            outputTokens: 1,
            actualCostUsd: costUsd,
          }),
        })
        if (!paid.succeeded) throw paid.error
        return { winnerSurface: name, cost: completeCost(costUsd) }
      },
    })

    await expect(
      compareOptimizationMethods<S, A>({
        methods: [spendingMethod('first-method', 0.04), spendingMethod('second-method', 0.02)],
        baselineSurface: 'baseline',
        ...PARTITIONS,
        dispatchWithSurface: async (surface) => {
          finalDispatches += 1
          return { text: String(surface) }
        },
        judges: [judge],
        runDir,
        costCeiling: 0.05,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/would exceed ceiling 0\.05/)
    expect(optimizerExecutions).toBe(1)
    expect(finalDispatches).toBe(0)
  })

  it('FAILS LOUD when a surface is missing a test scenario score (no fabricated 0)', async () => {
    // A judge that errors on h3 → that cell has no score → the baseline score
    // vector omits h3. compareOptimizationMethods must refuse to fabricate a 0 for the
    // missing scenario (which would corrupt the lift CI) and throw, naming h3.
    const flakeyJudge: JudgeConfig<A, S> = {
      name: 'flakey',
      dimensions: [{ key: 'solved', description: 'solved' }],
      score: ({ scenario }) => {
        if (scenario.id === 'h3') throw new Error('judge unavailable for h3')
        return { dimensions: { solved: 1 }, composite: 1, notes: '' }
      },
    }
    await expect(
      compareOptimizationMethods<S, A>({
        methods: [fixedMethod('d', 'whatever', 1)],
        baselineSurface: 'b',
        ...PARTITIONS,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [flakeyJudge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/h3/)
  })

  it('throws on an empty method list', async () => {
    await expect(
      compareOptimizationMethods<S, A>({
        methods: [],
        baselineSurface: 'x',
        ...PARTITIONS,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        runDir,
      }),
    ).rejects.toThrow(/no methods/)
  })

  it.each([
    [
      'duplicate names',
      [fixedMethod('same', 'a', 0), fixedMethod('same', 'b', 0)],
      /duplicate method name/,
    ],
    [
      'colliding run paths',
      [fixedMethod('alpha beta', 'a', 0), fixedMethod('alpha-beta', 'b', 0)],
      /same run path/,
    ],
    ['untrimmed names', [fixedMethod(' padded ', 'a', 0)], /trimmed and non-empty/],
  ])('rejects %s before optimization', async (_label, methods, expected) => {
    await expect(
      compareOptimizationMethods<S, A>({
        methods,
        baselineSurface: 'x',
        ...PARTITIONS,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(expected)
  })

  it.each([
    ['cost', { winnerSurface: 'x', cost: completeCost(Number.NaN) }],
    ['durationMs', { winnerSurface: 'x', cost: completeCost(0), durationMs: -1 }],
  ])('rejects an invalid optimizer %s before test scoring', async (_field, result) => {
    let testDispatches = 0
    await expect(
      compareOptimizationMethods<S, A>({
        methods: [{ name: 'invalid-output', optimize: async () => result }],
        baselineSurface: 'x',
        ...PARTITIONS,
        dispatchWithSurface: async (surface) => {
          testDispatches += 1
          return { text: String(surface) }
        },
        judges: [judge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/returned an invalid/)
    expect(testDispatches).toBe(0)
  })

  it('uses compareOptimizationMethods in downstream validation errors', async () => {
    const flakeyJudge: JudgeConfig<A, S> = {
      name: 'flakey',
      dimensions: [{ key: 'solved', description: 'solved' }],
      score: ({ scenario }) => {
        if (scenario.id === 'h3') throw new Error('judge unavailable for h3')
        return { dimensions: { solved: 1 }, composite: 1, notes: '' }
      },
    }

    await expect(
      compareOptimizationMethods<S, A>({
        methods: [fixedMethod('d', 'whatever', 1)],
        baselineSurface: 'b',
        ...PARTITIONS,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [flakeyJudge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/compareOptimizationMethods: baseline produced no test score.*h3/)
  })

  const invalidControls: Array<[string, Partial<CompareOptimizationMethodsOptions<S, A>>, RegExp]> =
    [
      ['empty judges', { judges: [] }, /at least one judge/],
      ['blank runDir', { runDir: ' ' }, /runDir must be a non-empty string/],
      ['blank dispatchRef', { dispatchRef: ' ' }, /dispatchRef must be trimmed and non-empty/],
      ['fractional seed', { seed: 1.5 }, /seed must be a safe integer/],
      ['zero resamples', { resamples: 0 }, /resamples must be a positive safe integer/],
      ['too few resamples', { resamples: 10 }, /resamples must be at least 40/],
      ['NaN confidence', { confidence: Number.NaN }, /confidence must be a finite number/],
      ['unit confidence', { confidence: 1 }, /confidence must be a finite number/],
      ['zero reps', { reps: 0 }, /reps to be a positive safe integer/],
      [
        'zero optimization concurrency',
        { optimizationConcurrency: 0 },
        /optimizationConcurrency must be a positive/,
      ],
      ['zero concurrency', { maxConcurrency: 0 }, /maxConcurrency must be a positive/],
      ['negative timeout', { dispatchTimeoutMs: -1 }, /dispatchTimeoutMs must be a non-negative/],
      ['negative cost ceiling', { costCeiling: -1 }, /costCeiling must be a finite number/],
      [
        'removed per-method cost ceiling',
        { optimizationRunOptions: { costCeiling: 1 } as never },
        /optimizationRunOptions\.costCeiling is not supported/,
      ],
    ]

  it.each(invalidControls)('rejects %s before optimization', async (_label, invalid, expected) => {
    let optimizeCalls = 0
    await expect(
      compareOptimizationMethods<S, A>({
        methods: [
          {
            name: 'never-called',
            async optimize() {
              optimizeCalls += 1
              return { winnerSurface: 'x', cost: completeCost(0) }
            },
          },
        ],
        baselineSurface: 'x',
        ...PARTITIONS,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        runDir,
        expectUsage: 'off',
        ...invalid,
      }),
    ).rejects.toThrow(expected)
    expect(optimizeCalls).toBe(0)
  })

  it('passes shared method inputs without exposing test data', async () => {
    let seen: unknown
    const method: OptimizationMethod<S, A> = {
      name: 'spy',
      async optimize(input) {
        seen = input
        expect('testScenarios' in input).toBe(false)
        expect(input.baselineSurface).toBe('nothing')
        expect(input.trainScenarios).toEqual(TRAIN)
        expect(input.selectionScenarios).toEqual(SELECTION)
        expect(input.trainScenarios).not.toBe(TRAIN)
        expect(input.selectionScenarios).not.toBe(SELECTION)
        expect(input.judges).toHaveLength(1)
        expect(input.runDir).toContain('/optimization/spy')
        return { winnerSurface: 'SOLVE_h1', cost: completeCost(0) }
      },
    }
    await compareOptimizationMethods<S, A>({
      methods: [method],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      expectUsage: 'off',
    })
    expect(seen).toBeDefined()
  })

  it('passes the owning signal to optimization methods', async () => {
    const owner = new AbortController()
    let receivedSignal: AbortSignal | undefined
    await compareOptimizationMethods<S, A>({
      methods: [
        {
          name: 'signal-spy',
          optimize: async (input) => {
            receivedSignal = input.runOptions.signal
            return { winnerSurface: 'nothing', cost: completeCost(0) }
          },
        },
      ],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      signal: owner.signal,
      expectUsage: 'off',
    })
    expect(receivedSignal).toBe(owner.signal)
  })

  it('isolates scenario values between methods and from caller-owned data', async () => {
    interface MutableScenario extends Scenario {
      payload: { value: number }
    }
    const train: MutableScenario[] = [{ id: 'train', kind: 'q', payload: { value: 1 } }]
    const selection: MutableScenario[] = [{ id: 'selection', kind: 'q', payload: { value: 2 } }]
    const test: MutableScenario[] = [
      { id: 'test-1', kind: 'q', payload: { value: 3 } },
      { id: 'test-2', kind: 'q', payload: { value: 4 } },
    ]
    let secondMethodValue = 0
    const mutating: OptimizationMethod<MutableScenario, A> = {
      name: 'mutating',
      async optimize(input) {
        const payload = input.trainScenarios[0]!.payload as { value: number }
        payload.value = 99
        return { winnerSurface: 'nothing', cost: completeCost(0) }
      },
    }
    const observing: OptimizationMethod<MutableScenario, A> = {
      name: 'observing',
      async optimize(input) {
        secondMethodValue = input.trainScenarios[0]!.payload.value
        return { winnerSurface: 'nothing', cost: completeCost(0) }
      },
    }
    const alwaysZero: JudgeConfig<A, MutableScenario> = {
      name: 'zero',
      dimensions: [{ key: 'value', description: 'fixed zero' }],
      score: () => ({ dimensions: { value: 0 }, composite: 0, notes: '' }),
    }

    await compareOptimizationMethods<MutableScenario, A>({
      methods: [mutating, observing],
      baselineSurface: 'nothing',
      trainScenarios: train,
      selectionScenarios: selection,
      testScenarios: test,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [alwaysZero],
      runDir,
      expectUsage: 'off',
    })

    expect(secondMethodValue).toBe(1)
    expect(train[0]!.payload.value).toBe(1)
  })

  it('isolates final-test scenario values between measured surfaces and from caller data', async () => {
    interface MutableScenario extends Scenario {
      payload: { value: number }
    }
    const train: MutableScenario[] = [{ id: 'train', kind: 'q', payload: { value: 1 } }]
    const selection: MutableScenario[] = [{ id: 'selection', kind: 'q', payload: { value: 2 } }]
    const test: MutableScenario[] = [
      { id: 'test-1', kind: 'q', payload: { value: 3 } },
      { id: 'test-2', kind: 'q', payload: { value: 4 } },
    ]
    const observedWinnerValues: number[] = []
    const alwaysZero: JudgeConfig<A, MutableScenario> = {
      name: 'zero',
      dimensions: [{ key: 'value', description: 'fixed zero' }],
      score: () => ({ dimensions: { value: 0 }, composite: 0, notes: '' }),
    }

    await compareOptimizationMethods<MutableScenario, A>({
      methods: [
        {
          name: 'candidate',
          optimize: async () => ({ winnerSurface: 'winner', cost: completeCost(0) }),
        },
      ],
      baselineSurface: 'baseline',
      trainScenarios: train,
      selectionScenarios: selection,
      testScenarios: test,
      dispatchWithSurface: async (surface, scenario) => {
        if (surface === 'baseline') scenario.payload.value = 99
        else observedWinnerValues.push(scenario.payload.value)
        return { text: String(surface) }
      },
      judges: [alwaysZero],
      runDir,
      expectUsage: 'off',
    })

    expect(observedWinnerValues).toEqual([3, 4])
    expect(test.map((scenario) => scenario.payload.value)).toEqual([3, 4])
  })

  it('scores and returns immutable candidate snapshots with a fresh value per dispatch', async () => {
    const baseline = {
      kind: 'components' as const,
      components: { policy: 'baseline' },
    }
    const selected = {
      kind: 'components' as const,
      components: { policy: 'winner' },
    }
    const received: object[] = []
    const values: string[] = []
    const snapshotJudge: JudgeConfig<A, S> = {
      name: 'snapshot',
      dimensions: [{ key: 'winner', description: 'candidate is the selected snapshot' }],
      score: ({ artifact }) => {
        const value = artifact.text === 'winner' ? 1 : 0
        return { dimensions: { winner: value }, composite: value, notes: '' }
      },
    }

    const result = await compareOptimizationMethods<S, A>({
      methods: [
        {
          name: 'object-candidate',
          optimize: async () => ({ winnerSurface: selected, cost: completeCost(0) }),
        },
      ],
      baselineSurface: baseline,
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => {
        if (typeof surface === 'string' || surface.kind !== 'components') {
          throw new Error('expected a component surface')
        }
        received.push(surface)
        const value = surface.components.policy!
        values.push(value)
        ;(surface.components as Record<string, string>).policy = 'mutated-by-dispatch'
        return { text: value }
      },
      judges: [snapshotJudge],
      runDir,
      maxConcurrency: 2,
      expectUsage: 'off',
    })

    expect(values.filter((value) => value === 'baseline')).toHaveLength(TEST.length)
    expect(values.filter((value) => value === 'winner')).toHaveLength(TEST.length)
    expect(new Set(received).size).toBe(TEST.length * 2)
    expect(baseline.components.policy).toBe('baseline')
    expect(selected.components.policy).toBe('winner')
    expect(result.best.winnerComposite).toBe(1)
    expect(result.best.winnerSurface).toEqual({
      kind: 'components',
      components: { policy: 'winner' },
    })

    for (const surface of received) {
      ;(surface as { components: Record<string, string> }).components.policy = 'mutated-later'
    }
    expect(result.best.winnerSurface).toEqual({
      kind: 'components',
      components: { policy: 'winner' },
    })
  })

  it('finishes every optimization before the first test dispatch', async () => {
    const events: string[] = []
    const method = (name: string): OptimizationMethod<S, A> => ({
      name,
      async optimize() {
        events.push(`optimize:${name}`)
        return { winnerSurface: 'nothing', cost: completeCost(0) }
      },
    })

    await compareOptimizationMethods<S, A>({
      methods: [method('a'), method('b')],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface, scenario) => {
        events.push(`test:${scenario.id}`)
        return { text: String(surface) }
      },
      judges: [judge],
      runDir,
      expectUsage: 'off',
    })

    expect(events.slice(0, 2)).toEqual(['optimize:a', 'optimize:b'])
    expect(events.slice(2).every((event) => event.startsWith('test:'))).toBe(true)
  })

  it('runs independent optimizations concurrently when requested, then opens test', async () => {
    let active = 0
    let maxActive = 0
    let completed = 0
    const method = (name: string): OptimizationMethod<S, A> => ({
      name,
      async optimize() {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        completed += 1
        return { winnerSurface: 'nothing', cost: completeCost(0) }
      },
    })

    await compareOptimizationMethods<S, A>({
      methods: [method('a'), method('b'), method('c')],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => {
        expect(completed).toBe(3)
        return { text: String(surface) }
      },
      judges: [judge],
      runDir,
      optimizationConcurrency: 2,
      expectUsage: 'off',
    })

    expect(maxActive).toBe(2)
  })

  it('scores identical selected surfaces once', async () => {
    let testDispatches = 0
    const result = await compareOptimizationMethods<S, A>({
      methods: [fixedMethod('first', 'SOLVE_h1', 1), fixedMethod('second', 'SOLVE_h1', 2)],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => {
        testDispatches += 1
        return { text: String(surface) }
      },
      judges: [judge],
      runDir,
      expectUsage: 'off',
    })

    expect(testDispatches).toBe(TEST.length * 2)
    expect(result.scores[0]?.winnerComposite).toBe(result.scores[1]?.winnerComposite)
  })

  it('keeps baseline and a method named baseline in separate run directories', async () => {
    const result = await compareOptimizationMethods<S, A>({
      methods: [fixedMethod('baseline', 'SOLVE_h1 SOLVE_h2', 0)],
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      expectUsage: 'off',
    })

    expect(result.best.winnerComposite).toBe(0.5)
    expect(result.best.lift).toBe(0.5)
  })

  it('raises the default resample count when many contrasts need finer tails', async () => {
    const methods = Array.from({ length: 10 }, (_, index) =>
      fixedMethod(`method-${index}`, 'nothing', 0),
    )
    const result = await compareOptimizationMethods<S, A>({
      methods,
      baselineSurface: 'nothing',
      ...PARTITIONS,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      expectUsage: 'off',
    })

    expect(result.comparisonCount).toBe(55)
    expect(result.resamples).toBe(2200)
  })

  it.each([
    ['train/selection', { ...PARTITIONS, trainScenarios: [...TRAIN, SELECTION[0]!] }],
    ['train/test', { ...PARTITIONS, trainScenarios: [...TRAIN, TEST[0]!] }],
    ['selection/test', { ...PARTITIONS, selectionScenarios: [...SELECTION, TEST[0]!] }],
  ])('rejects %s overlap before any scoring', async (_label, partitions) => {
    await expect(
      compareOptimizationMethods<S, A>({
        methods: [fixedMethod('d', 'whatever', 1)],
        baselineSurface: 'b',
        ...partitions,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/must be pairwise disjoint/)
  })

  it.each([
    'trainScenarios',
    'selectionScenarios',
    'testScenarios',
  ] as const)('rejects an empty %s partition', async (partition) => {
    await expect(
      compareOptimizationMethods<S, A>({
        methods: [fixedMethod('d', 'whatever', 1)],
        baselineSurface: 'b',
        ...PARTITIONS,
        [partition]: [],
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(new RegExp(`${partition} is empty`))
  })

  it('rejects a one-scenario test partition before optimization', async () => {
    let optimizeCalls = 0
    await expect(
      compareOptimizationMethods<S, A>({
        methods: [
          {
            name: 'never-called',
            async optimize() {
              optimizeCalls += 1
              return { winnerSurface: 'x', cost: completeCost(0) }
            },
          },
        ],
        baselineSurface: 'x',
        ...PARTITIONS,
        testScenarios: [TEST[0]!],
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/at least 2 scenarios/)
    expect(optimizeCalls).toBe(0)
  })

  it('rejects duplicate scenario IDs within a partition', async () => {
    await expect(
      compareOptimizationMethods<S, A>({
        methods: [fixedMethod('d', 'whatever', 1)],
        baselineSurface: 'b',
        ...PARTITIONS,
        testScenarios: [...TEST, TEST[0]!],
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/testScenarios contains duplicate scenario id/)
  })

  it('fails closed on the ambiguous legacy holdoutScenarios contract', async () => {
    const legacy = {
      methods: [fixedMethod('d', 'whatever', 1)],
      baselineSurface: 'b',
      holdoutScenarios: TEST,
      dispatchWithSurface: async (surface: string) => ({ text: surface }),
      judges: [judge],
      runDir,
      expectUsage: 'off',
    } as unknown as CompareOptimizationMethodsOptions<S, A>
    await expect(compareOptimizationMethods(legacy)).rejects.toThrow(
      /holdoutScenarios is ambiguous/,
    )
  })
})
