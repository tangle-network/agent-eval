import { describe, expect, it } from 'vitest'
import { snapshotAnalystRun, snapshotExactAnalystRunReceipt } from '../feedback-trajectory-review'
import type { ExactAnalystRunResult, ExactCapableAnalyst } from './exact-types'
import {
  AnalystRegistry,
  ExactAnalystRunExecutionError,
  type ExactRegistryRunOpts,
} from './registry'
import type { AnalystContext, AnalystFinding, AnalystRunInputs, AnalystUsageReceipt } from './types'

function exactOptions(overrides: Partial<ExactRegistryRunOpts> = {}): ExactRegistryRunOpts {
  return {
    analystIds: ['a'],
    budget: null,
    totalTimeoutMs: null,
    signal: null,
    costLedger: null,
    costLedgerIdentity: null,
    costPhase: null,
    tags: null,
    priorFindings: null,
    chainFindings: false,
    missingInputMode: 'skip',
    applyRegistryHooks: false,
    useRegistryChat: false,
    ...overrides,
  }
}

function recordingAnalyst(
  id: string,
  calls: Array<{ id: string; context: AnalystContext }>,
  analyze?: (context: AnalystContext) => Promise<AnalystFinding[]>,
): ExactCapableAnalyst {
  return {
    id,
    description: id,
    inputKind: 'custom',
    cost: { kind: 'deterministic' },
    version: '1',
    executionConfig: { kind: 'recording', id },
    async analyze(_input, context): Promise<AnalystFinding[]> {
      calls.push({ id, context })
      return analyze?.(context) ?? []
    },
  }
}

function twoAnalystRegistry(): {
  registry: AnalystRegistry
  calls: Array<{ id: string; context: AnalystContext }>
} {
  const calls: Array<{ id: string; context: AnalystContext }> = []
  const registry = new AnalystRegistry()
  registry.register(recordingAnalyst('a', calls))
  registry.register(recordingAnalyst('b', calls))
  return { registry, calls }
}

describe('AnalystRegistry exact run policy', () => {
  it.each([
    ['undefined', undefined],
    ['empty', {}],
    ['partial', { analystIds: ['a'] }],
    ['empty analyst ids', exactOptions({ analystIds: [] })],
    ['missing budget', { ...exactOptions(), budget: undefined }],
  ])('refuses %s policy before any analyst executes', async (_label, policy) => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    const registry = new AnalystRegistry()
    registry.register(recordingAnalyst('a', calls))

    await expect(
      registry.runExact('invalid', { custom: { a: 1 } }, policy as ExactRegistryRunOpts),
    ).rejects.toThrow(/ExactRegistryRunOpts/)
    expect(calls).toEqual([])
  })

  it('rejects an invalid run id before any analyst executes', async () => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    const registry = new AnalystRegistry()
    registry.register(recordingAnalyst('a', calls))

    await expect(registry.runExact('', { custom: { a: 1 } }, exactOptions())).rejects.toThrow(
      /runId must be a non-empty string/,
    )
    expect(calls).toEqual([])
  })

  it('runs exactly the declared analysts in order without inheriting registry defaults', async () => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    const registry = new AnalystRegistry({ defaultBudget: { totalUsd: 99 } })
    registry.register(recordingAnalyst('a', calls))
    registry.register(recordingAnalyst('b', calls))
    registry.register(recordingAnalyst('c', calls))

    const result = await registry.runExact(
      'ordered',
      { custom: { a: 1, b: 2, c: 3 } },
      exactOptions({ analystIds: ['c', 'a'] }),
    )

    expect(calls.map((call) => call.id)).toEqual(['c', 'a'])
    expect(calls.map((call) => call.context.budgetUsd)).toEqual([undefined, undefined])
    expect(result.per_analyst.map((summary) => summary.analyst_id)).toEqual(['c', 'a'])
    expect(result.execution_plan.policy.budget).toEqual({ kind: 'none' })
    expect(() => snapshotAnalystRun(result)).not.toThrow()
  })

  it('rejects mutation of plan-bound context by onBeforeAnalyze', async () => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    const registry = new AnalystRegistry({
      hooks: {
        onBeforeAnalyze({ ctx }) {
          ctx.budgetUsd = 99
        },
      },
      hooksIdentity: { id: 'hooks', version: '1', config: {} },
    })
    registry.register(recordingAnalyst('a', calls))

    const error = await registry
      .runExact('frozen-context', { custom: { a: 1 } }, exactOptions({ applyRegistryHooks: true }))
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ExactAnalystRunExecutionError)
    expect(calls).toEqual([])
    expect((error as ExactAnalystRunExecutionError).result.completion.status).toBe('failed')
  })

  it('records and executes the same equal allocations from one canonical plan', async () => {
    const { registry, calls } = twoAnalystRegistry()

    const result = await registry.runExact(
      'equal',
      { custom: { a: 1, b: 2 } },
      exactOptions({
        analystIds: ['a', 'b'],
        budget: { kind: 'equal', totalUsd: 2 },
      }),
    )

    expect(calls.map((call) => call.context.budgetUsd)).toEqual([1, 1])
    expect(result.execution_plan.policy.budget).toEqual({
      kind: 'equal',
      total_usd: 2,
      allocations_usd: { a: 1, b: 1 },
    })
    expect(result.per_analyst.map((summary) => summary.allocated_budget_usd)).toEqual([1, 1])
  })

  it('detaches and freezes every streamed exact record from terminal accounting', async () => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    const registry = new AnalystRegistry()
    registry.register(recordingAnalyst('a', calls))
    const stream = registry.runExactStream('immutable', { custom: { a: 1 } }, exactOptions())

    const runStarted = await stream.next()
    const analystStarted = await stream.next()
    const analystCompleted = await stream.next()
    expect(runStarted.value?.type).toBe('run-started')
    expect(analystStarted.value?.type).toBe('analyst-started')
    expect(analystCompleted.value?.type).toBe('analyst-completed')
    if (analystCompleted.value?.type !== 'analyst-completed') {
      throw new Error('expected analyst-completed event')
    }
    expect(Object.isFrozen(analystCompleted.value)).toBe(true)
    expect(Object.isFrozen(analystCompleted.value.summary.usage.cost)).toBe(true)
    expect(Reflect.set(analystCompleted.value.summary.usage.cost, 'usd', 99)).toBe(false)

    const completed = await stream.next()
    if (completed.value?.type !== 'run-completed') {
      throw new Error('expected run-completed event')
    }
    expect(completed.value.result.total_cost_usd).toBe(0)
    expect(completed.value.result.per_analyst[0]?.usage.cost).toEqual({
      kind: 'observed',
      usd: 0,
    })
    expect(completed.value.result.per_analyst[0]).not.toBe(analystCompleted.value.summary)
    expect(Object.isFrozen(completed.value.result)).toBe(true)
    expect(Object.isFrozen(completed.value.result.per_analyst[0])).toBe(true)
  })

  it.each([
    {
      label: 'equal',
      budget: { kind: 'equal', totalUsd: 2 } as const,
      forged: [2, 2],
    },
    {
      label: 'weighted',
      budget: { kind: 'weighted', totalUsd: 4, weights: { a: 1, b: 3 } } as const,
      forged: [4, 4],
    },
  ])(
    'rejects $label archived allocations that exceed the canonical plan',
    async ({ budget, forged }) => {
      const { registry } = twoAnalystRegistry()
      const result = await registry.runExact(
        'archive-budget',
        { custom: { a: 1, b: 2 } },
        exactOptions({ analystIds: ['a', 'b'], budget }),
      )
      const tampered = structuredClone(result)
      tampered.per_analyst[0]!.allocated_budget_usd = forged[0]
      tampered.per_analyst[1]!.allocated_budget_usd = forged[1]

      expect(() => snapshotAnalystRun(tampered)).toThrow(/allocation|budget/)
    },
  )

  it('rejects a registered analyst whose live id changed before exact normalization', async () => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    const analyst = recordingAnalyst('a', calls)
    const registry = new AnalystRegistry()
    registry.register(analyst)
    ;(analyst as { id: string }).id = 'b'

    await expect(
      registry.runExact('changed-id', { custom: { a: 1 } }, exactOptions()),
    ).rejects.toThrow(/changed id/)
    expect(calls).toEqual([])
  })

  it('routes each selected input once and executes the captured value', async () => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    const registry = new AnalystRegistry()
    registry.register(recordingAnalyst('a', calls))
    let customReads = 0
    let valueReads = 0
    const inputs = {
      get custom(): Record<string, unknown> | undefined {
        customReads += 1
        if (customReads > 1) return undefined
        return {
          get a(): unknown {
            valueReads += 1
            return 1
          },
        }
      },
    }

    const result = await registry.runExact(
      'single-route',
      inputs,
      exactOptions({ missingInputMode: 'abort' }),
    )

    expect(customReads).toBe(1)
    expect(valueReads).toBe(1)
    expect(calls).toHaveLength(1)
    expect(result.per_analyst[0]?.status).toBe('ok')
  })

  it('captures each shared input channel once for every selected analyst', async () => {
    const seen: unknown[] = []
    const registry = new AnalystRegistry()
    for (const id of ['a', 'b']) {
      const analyst: ExactCapableAnalyst = {
        id,
        description: id,
        inputKind: 'trace-store',
        cost: { kind: 'deterministic' },
        version: '1',
        executionConfig: { kind: 'shared-input', id },
        async analyze(input) {
          seen.push(input)
          return []
        },
      }
      registry.register(analyst)
    }
    const first = { source: 'first' }
    const second = { source: 'second' }
    let traceStoreReads = 0
    const inputs = {
      get traceStore() {
        traceStoreReads += 1
        return traceStoreReads === 1 ? first : second
      },
    } as unknown as AnalystRunInputs

    await registry.runExact('shared-input', inputs, exactOptions({ analystIds: ['a', 'b'] }))

    expect(traceStoreReads).toBe(1)
    expect(seen).toEqual([first, first])
  })

  it('rejects unknown nested budget fields before execution', async () => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    const registry = new AnalystRegistry()
    registry.register(recordingAnalyst('a', calls))
    const budget = {
      kind: 'equal',
      totalUsd: 1,
      weights: { a: 999 },
    } as unknown as ExactRegistryRunOpts['budget']

    await expect(
      registry.runExact('strict-budget', { custom: { a: 1 } }, exactOptions({ budget })),
    ).rejects.toThrow(/exactly kind, totalUsd/)
    expect(calls).toEqual([])
  })

  it('never returns success when cancellation prevents declared hooks from completing', async () => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    let after = 0
    let complete = 0
    const registry = new AnalystRegistry({
      hooks: {
        onAfterAnalyze() {
          after += 1
        },
        onComplete() {
          complete += 1
        },
      },
      hooksIdentity: { id: 'hooks', version: '1', config: {} },
    })
    registry.register(
      recordingAnalyst('a', calls, async () => new Promise<AnalystFinding[]>(() => {})),
    )

    let caught: unknown
    try {
      await registry.runExact(
        'cancelled-hooks',
        { custom: { a: 1 } },
        exactOptions({
          totalTimeoutMs: 10,
          applyRegistryHooks: true,
        }),
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ExactAnalystRunExecutionError)
    const exactError = caught as ExactAnalystRunExecutionError
    expect(exactError.result.execution_plan.policy.registry_hooks).not.toBeNull()
    expect(exactError.result.per_analyst).toHaveLength(1)
    expect(after).toBe(0)
    expect(complete).toBe(0)
  })

  it('round-trips weighted output through the archive validator', async () => {
    const { registry } = twoAnalystRegistry()
    const result = await registry.runExact(
      'round-trip',
      { custom: { a: 1, b: 2 } },
      exactOptions({
        analystIds: ['a', 'b'],
        budget: { kind: 'weighted', totalUsd: 4, weights: { a: 1, b: 3 } },
      }),
    )

    const archived = snapshotAnalystRun(result) as ExactAnalystRunResult
    expect(archived.execution_plan.policy.budget).toEqual({
      kind: 'weighted',
      total_usd: 4,
      weights: { a: 1, b: 3 },
      allocations_usd: { a: 1, b: 3 },
    })
    expect(archived).toEqual(result)
  })

  it('rejects an incomplete successful exact receipt', async () => {
    const { registry } = twoAnalystRegistry()
    const result = await registry.runExact(
      'truncated-success',
      { custom: { a: 1, b: 2 } },
      exactOptions({ analystIds: ['a', 'b'] }),
    )
    const truncated = structuredClone(result)
    truncated.per_analyst.pop()

    expect(() => snapshotExactAnalystRunReceipt(truncated)).toThrow(
      /complete receipt must contain every execution_plan analyst/,
    )
  })

  it('snapshots usage before validating it', async () => {
    let callsReads = 0
    const registry = new AnalystRegistry()
    registry.register(
      recordingAnalyst('a', [], async (context) => {
        const receipt = {
          get calls() {
            callsReads += 1
            return callsReads === 1 ? 0 : Number.MAX_SAFE_INTEGER + 1
          },
          tokens: { input: 0, output: 0 },
          cost: { kind: 'observed', usd: 0 },
        } as unknown as AnalystUsageReceipt
        context.recordUsage?.(receipt)
        return []
      }),
    )

    const result = await registry.runExact('read-once-usage', { custom: { a: 1 } }, exactOptions())

    expect(callsReads).toBe(1)
    expect(result.per_analyst[0]?.usage.calls).toBe(0)
  })

  it('always attaches a valid frozen failed receipt to exact execution errors', async () => {
    const registry = new AnalystRegistry()
    registry.register(
      recordingAnalyst('a', [], async (context) => {
        const receipt: AnalystUsageReceipt = {
          calls: Number.MAX_SAFE_INTEGER,
          tokens: { input: 0, output: 0 },
          cost: { kind: 'observed', usd: 0 },
        }
        context.recordUsage?.(receipt)
        context.recordUsage?.(receipt)
        return []
      }),
    )

    const error = await registry
      .runExact('overflow', { custom: { a: 1 } }, exactOptions())
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ExactAnalystRunExecutionError)
    const result = (error as ExactAnalystRunExecutionError).result
    expect(result.completion).toMatchObject({
      status: 'failed',
      error: { class: 'RangeError' },
    })
    expect(result.per_analyst).toEqual([])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.completion)).toBe(true)
    expect(Reflect.set(result, 'total_cost_usd', 7)).toBe(false)
    expect(() => snapshotExactAnalystRunReceipt(result)).not.toThrow()
  })

  it('rejects archived usage whose reasoning tokens exceed output tokens', async () => {
    const calls: Array<{ id: string; context: AnalystContext }> = []
    const registry = new AnalystRegistry()
    registry.register(recordingAnalyst('a', calls))
    const result = await registry.runExact('invalid-usage', { custom: { a: 1 } }, exactOptions())
    const tampered = structuredClone(result)
    const tokens = tampered.per_analyst[0]?.usage.tokens
    if (!tokens) throw new Error('expected deterministic token receipt')
    tokens.reasoning = tokens.output + 1

    expect(() => snapshotAnalystRun(tampered)).toThrow(/reasoning must not exceed tokens.output/)
  })
})
