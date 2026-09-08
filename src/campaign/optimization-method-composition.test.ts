import { describe, expect, it } from 'vitest'
import { CostLedger } from '../cost-ledger'
import { scopedOptimizationMethod, sequentialOptimizationMethod } from './index'
import { assertOptimizationResult, executeOptimizationMethod } from './optimization-method'
import type {
  OptimizationMethod,
  OptimizationMethodInput,
} from './presets/compare-optimization-methods'
import { compareOptimizationMethods } from './presets/compare-optimization-methods'
import { inMemoryCampaignStorage } from './storage'
import { surfaceContentHash } from './surface-identity'
import type { ComponentSurface, MutableSurface, Scenario } from './types'

const cost = (usd: number) => ({
  totalCostUsd: usd,
  costProvenance: { kind: 'observed' as const, usd },
  accountingComplete: true,
  incompleteReasons: [],
})
const baseline: ComponentSurface = {
  kind: 'components',
  components: {
    learner: JSON.stringify({ instructions: 'initial learner', tools: ['trace'] }),
    specialist: JSON.stringify({ instructions: 'initial specialist', tools: ['shell'] }),
    workingEvaluation: 'sha256:working-eval-v1',
    state: 'sha256:state-v1',
  },
}
function components(surface: MutableSurface): ComponentSurface {
  if (typeof surface === 'string' || surface.kind !== 'components')
    throw new Error('expected components')
  return surface
}
function input(): OptimizationMethodInput<Scenario, string> {
  return {
    baselineSurface: baseline,
    trainScenarios: [{ id: 'train', kind: 'fixture' }],
    selectionScenarios: [{ id: 'selection', kind: 'fixture' }],
    dispatchWithSurface: async (surface) => JSON.stringify(surface),
    judges: [],
    runDir: 'mem://sequence',
    seed: 7,
    runOptions: { storage: inMemoryCampaignStorage() },
    costLedger: new CostLedger(),
  }
}
function paidMethod(
  name: string,
  winner: string,
  usd: number,
): OptimizationMethod<Scenario, string> {
  return {
    name,
    async optimize(ctx) {
      const paid = await ctx.costLedger.runPaidCall({
        channel: 'optimizer',
        phase: 'search',
        actor: name,
        model: 'fixture/model',
        execute: async () => winner,
        receipt: () => ({
          model: 'fixture/model',
          inputTokens: 11,
          outputTokens: 7,
          actualCostUsd: usd,
        }),
      })
      if (!paid.succeeded) throw paid.error
      return {
        winnerSurface: winner,
        cost: cost(usd),
        provenance: {
          source: { kind: 'package', evidence: 'declared', package: 'gepa', version: 'fixture' },
          runId: name,
          artifactDir: ctx.runDir,
          resumed: false,
          evaluationCount: 1,
          tokenUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, calls: 1 },
        },
      }
    },
  }
}
function scope(key: string, method: OptimizationMethod<Scenario, string>) {
  return scopedOptimizationMethod({
    name: `${key}-scope`,
    method,
    project: (surface) => components(surface).components[key]!,
    merge: (surface, selected) => ({
      kind: 'components',
      components: { ...components(surface).components, [key]: String(selected) },
    }),
  })
}

describe('optimization method composition', () => {
  it('invokes active methods with nested projections mapped to the current complete candidate', async () => {
    const ctx = input()
    const seen: Array<{ name: string; root: MutableSurface }> = []
    const leaf = paidMethod('instructions', 'updated learner', 0.01)
    const nested = scope(
      'learner',
      scopedOptimizationMethod({
        name: 'instructions-scope',
        method: leaf,
        project: (surface) => JSON.parse(String(surface)).instructions,
        merge: (surface, selected) =>
          JSON.stringify({ ...JSON.parse(String(surface)), instructions: selected }),
      }),
    )
    const method = sequentialOptimizationMethod({
      name: 'pipeline',
      methods: [nested, scope('specialist', paidMethod('specialist', 'updated specialist', 0.02))],
    })
    const invokeMethod: NonNullable<typeof ctx.invokeMethod> = async (active, local) => {
      expect(Object.isFrozen(local)).toBe(true)
      expect(local).not.toHaveProperty('testScenarios')
      const map = local.surfaceToRoot ?? structuredClone
      seen.push({ name: active.name, root: map(local.baselineSurface) })
      return active.optimize(local)
    }
    const result = await executeOptimizationMethod({
      method,
      input: { ...ctx, invokeMethod },
      storage: ctx.runOptions.storage!,
    })
    expect(seen.map((entry) => entry.name)).toEqual([
      'pipeline',
      'learner-scope',
      'instructions-scope',
      'instructions',
      'specialist-scope',
      'specialist',
    ])
    expect(seen.find((entry) => entry.name === 'instructions')?.root).toEqual(baseline)
    const specialistRoot = components(seen.find((entry) => entry.name === 'specialist')!.root)
    expect(JSON.parse(specialistRoot.components.learner!).instructions).toBe('updated learner')
    expect(specialistRoot.components.state).toBe(baseline.components.state)
    expect(components(result.selected.winnerSurface).components.specialist).toBe(
      'updated specialist',
    )
    expect(result.cost.totalCostUsd).toBeCloseTo(0.03)
  })

  it('lets an active child guard reject its mapped baseline before paid execution', async () => {
    const ctx = input()
    const method = sequentialOptimizationMethod({
      name: 'guarded-pipeline',
      methods: [scope('learner', paidMethod('private-leaf', 'forbidden', 0.01))],
    })
    const guardedInput: OptimizationMethodInput<Scenario, string> = {
      ...ctx,
      invokeMethod: async (active, local) => {
        if (active.name === 'private-leaf') {
          expect(local.surfaceToRoot?.(local.baselineSurface)).toEqual(baseline)
          throw new Error('exact child baseline is not authorized')
        }
        return active.optimize(local)
      },
    }
    await expect(
      executeOptimizationMethod({ method, input: guardedInput, storage: ctx.runOptions.storage! }),
    ).rejects.toThrow('exact child baseline is not authorized')
    expect(ctx.costLedger.summary().totalCalls).toBe(0)
  })

  it('continues joint -> learner -> specialist through a worse intermediate and retains exact state and all usage', async () => {
    const ctx = input()
    const joint: OptimizationMethod<Scenario, string> = {
      name: 'joint',
      async optimize(arg) {
        expect(Object.keys(arg)).not.toContain('testScenarios')
        return {
          winnerSurface: {
            ...baseline,
            components: { ...baseline.components, state: 'sha256:state-v2' },
          },
          cost: cost(0),
        }
      },
    }
    const learner = scope('learner', paidMethod('learner', 'temporarily worse learner', 0.01))
    const specialist = scope('specialist', {
      name: 'specialist',
      async optimize(arg) {
        const seen = await arg.dispatchWithSurface('probe', arg.selectionScenarios[0]!, {} as never)
        expect(JSON.parse(seen).components).toMatchObject({
          learner: 'temporarily worse learner',
          state: 'sha256:state-v2',
          specialist: 'probe',
        })
        return paidMethod('specialist', 'jointly improved specialist', 0.02).optimize(arg)
      },
    })
    const method = sequentialOptimizationMethod({
      name: 'learning',
      methods: [joint, learner, specialist],
    })
    const result = await executeOptimizationMethod({
      method,
      input: ctx,
      storage: ctx.runOptions.storage!,
    })
    expect(result.selected.winnerSurface).toEqual({
      ...baseline,
      components: {
        ...baseline.components,
        learner: 'temporarily worse learner',
        specialist: 'jointly improved specialist',
        state: 'sha256:state-v2',
      },
    })
    expect(result.cost).toEqual(cost(0.03))
    expect(ctx.costLedger.summary()).toMatchObject({
      totalCalls: 2,
      totalCostUsd: 0.03,
      inputTokens: 22,
      outputTokens: 14,
    })
    const stages = result.selected.composition!.stages
    expect(stages.map((stage) => stage.name)).toEqual([
      'joint',
      'learner-scope',
      'specialist-scope',
    ])
    expect(stages[1]!.baselineSurfaceHash).toBe(surfaceContentHash(stages[0]!.result.winnerSurface))
    expect(stages[2]!.baselineSurfaceHash).toBe(surfaceContentHash(stages[1]!.result.winnerSurface))
    expect(
      stages[1]!.result.composition!.stages[0]!.result.provenance!.tokenUsage!.totalTokens,
    ).toBe(18)
    expect(
      stages[2]!.result.composition!.stages[0]!.result.provenance!.tokenUsage!.totalTokens,
    ).toBe(18)
    expect(baseline.components.state).toBe('sha256:state-v1')
  })

  it('reconciles each nested bill without double charging or concealing underreporting', async () => {
    const ctx = input()
    const underreported: OptimizationMethod<Scenario, string> = {
      name: 'underreported',
      async optimize(arg) {
        const out = await paidMethod('paid', 'candidate', 0.02).optimize(arg)
        return { ...out, cost: cost(0) }
      },
    }
    const method = sequentialOptimizationMethod({
      name: 'nested',
      methods: [scope('learner', underreported)],
    })
    const result = await executeOptimizationMethod({
      method,
      input: ctx,
      storage: ctx.runOptions.storage!,
    })
    expect(result.cost.totalCostUsd).toBe(0.02)
    expect(result.cost.accountingComplete).toBe(false)
    expect(result.cost.incompleteReasons.join()).toContain('below recorded')
    expect(ctx.costLedger.summary().totalCalls).toBe(1)
  })

  it('refuses missing inner history before final cases and keeps final data out of every child', async () => {
    const child: OptimizationMethod<Scenario, string> = {
      name: 'child',
      async optimize(arg) {
        expect(arg.trainScenarios.map((row) => row.id)).toEqual(['train'])
        expect(arg.selectionScenarios.map((row) => row.id)).toEqual(['selection'])
        expect(arg).not.toHaveProperty('testScenarios')
        return { winnerSurface: 'candidate', cost: cost(0) }
      },
    }
    let calls = 0
    await expect(
      compareOptimizationMethods({
        methods: [sequentialOptimizationMethod({ name: 'sequence', methods: [child] })],
        baselineSurface: 'baseline',
        trainScenarios: [{ id: 'train', kind: 'fixture' }],
        selectionScenarios: [{ id: 'selection', kind: 'fixture' }],
        testScenarios: [
          { id: 'final', kind: 'fixture' },
          { id: 'final-2', kind: 'fixture' },
        ],
        dispatchWithSurface: async () => {
          calls++
          return 'unused'
        },
        judges: [
          {
            name: 'quality',
            dimensions: [{ key: 'quality', description: 'quality' }],
            score: () => ({ dimensions: { quality: 1 }, composite: 1, notes: '' }),
          },
        ],
        runDir: 'mem://history',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
        searchHistoryPolicy: 'require-complete',
      }),
    ).rejects.toThrow('child')
    expect(calls).toBe(0)
  })

  it('rejects a scope that changes the baseline before invoking the child', async () => {
    let started = false
    const method = scopedOptimizationMethod({
      name: 'invalid-scope',
      method: {
        name: 'child',
        async optimize() {
          started = true
          return { winnerSurface: 'x', cost: cost(0) }
        },
      },
      project: () => 'projection',
      merge: () => 'different baseline',
    })
    await expect(method.optimize(input())).rejects.toThrow('preserve the baseline')
    expect(started).toBe(false)
  })

  it('does not start another stage after cancellation', async () => {
    const controller = new AbortController()
    let secondStarted = false
    const method = sequentialOptimizationMethod<Scenario, string>({
      name: 'cancel',
      methods: [
        {
          name: 'first',
          async optimize() {
            controller.abort()
            return { winnerSurface: baseline, cost: cost(0) }
          },
        },
        {
          name: 'second',
          async optimize() {
            secondStarted = true
            return { winnerSurface: baseline, cost: cost(0) }
          },
        },
      ],
    })
    const ctx = input()
    await expect(
      method.optimize({ ...ctx, runOptions: { ...ctx.runOptions, signal: controller.signal } }),
    ).rejects.toThrow()
    expect(secondStarted).toBe(false)
  })

  it('detaches child inputs and isolates scope caches by the complete parent identity', async () => {
    const ctx = input()
    const directories: string[] = []
    const dispatchRefs: Array<string | undefined> = []
    const child: OptimizationMethod<Scenario, string> = {
      name: 'capture',
      async optimize(arg) {
        directories.push(arg.runDir)
        dispatchRefs.push(arg.runOptions.dispatchRef)
        return { winnerSurface: arg.baselineSurface, cost: cost(0) }
      },
    }
    const method = scope('learner', child)
    await method.optimize(ctx)
    await method.optimize({
      ...ctx,
      baselineSurface: {
        ...baseline,
        components: { ...baseline.components, state: 'other-state' },
      },
    })
    expect(directories[0]).not.toBe(directories[1])
    expect(dispatchRefs[0]).not.toBe(dispatchRefs[1])
    const mutator: OptimizationMethod<Scenario, string> = {
      name: 'mutator',
      async optimize(arg) {
        Object.assign(components(arg.baselineSurface).components, { state: 'mutated child' })
        return { winnerSurface: arg.baselineSurface, cost: cost(0) }
      },
    }
    await sequentialOptimizationMethod({ name: 'detached', methods: [mutator] }).optimize(ctx)
    expect(baseline.components.state).toBe('sha256:state-v1')
  })

  it('rejects cyclic composition instead of recursing indefinitely', () => {
    const result = {
      winnerSurface: baseline,
      cost: cost(0),
      composition: {
        kind: 'sequential' as const,
        baselineSurfaceHash: surfaceContentHash(baseline),
        stages: [] as Array<{
          name: string
          baselineSurfaceHash: string
          result: import('./presets/compare-optimization-methods').OptimizationMethodResult
        }>,
      },
    }
    result.composition.stages.push({
      name: 'cycle',
      baselineSurfaceHash: surfaceContentHash(baseline),
      result,
    })
    expect(() => assertOptimizationResult('cycle', result)).toThrow('cyclic')
  })

  it('rejects empty sequences', () => {
    expect(() => sequentialOptimizationMethod({ name: 'empty', methods: [] })).toThrow(
      'at least one',
    )
  })
})
