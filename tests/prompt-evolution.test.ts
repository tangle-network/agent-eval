import { describe, it, expect } from 'vitest'
import {
  runPromptEvolution,
  InMemoryTrialCache,
} from '../src/index'
import type {
  EvolvableVariant,
  ScoreAdapter,
  MutateAdapter,
  PromptTrialResult,
  VariantAggregate,
} from '../src/index'
import type { Objective } from '../src/pareto'

interface Payload {
  weight: number
}

function seed(weight: number, label: string): EvolvableVariant<Payload> {
  return { id: `seed-${weight}`, payload: { weight }, generation: 0, label }
}

const objectives: Objective<VariantAggregate>[] = [
  { name: 'score', direction: 'maximize', value: (a) => a.meanScore },
  { name: 'cost', direction: 'minimize', value: (a) => a.meanCost },
]

describe('runPromptEvolution', () => {
  it('runs a complete generation, scores, and reports', async () => {
    const adapter: ScoreAdapter<Payload> = {
      async score({ variant, scenarioId, rep }) {
        // Smaller weight scores higher; cost is constant
        return {
          variantId: variant.id,
          scenarioId,
          rep,
          ok: true,
          score: 1 - variant.payload.weight,
          cost: 100,
          durationMs: 10,
          metrics: {},
        } satisfies PromptTrialResult
      },
    }
    const mutator: MutateAdapter<Payload> = {
      async mutate({ parent, childCount, generation }) {
        return Array.from({ length: childCount }, (_, i) => ({
          id: `${parent.id}-child-${generation}-${i}`,
          payload: { weight: parent.payload.weight * 0.5 },
          generation,
          parentId: parent.id,
          label: `mutation ${i}`,
        }))
      },
    }

    const result = await runPromptEvolution<Payload>({
      runId: 'r1',
      target: 'weight',
      seedVariants: [seed(0.9, 'high'), seed(0.5, 'mid')],
      scenarioIds: ['s1', 's2'],
      reps: 1,
      generations: 2,
      populationSize: 2,
      scoreConcurrency: 4,
      scoreAdapter: adapter,
      mutateAdapter: mutator,
      objectives,
    })

    expect(result.generations).toHaveLength(2)
    expect(result.bestVariant).toBeTruthy()
    expect(result.bestAggregate.meanScore).toBeGreaterThan(0)
  })

  it('cache short-circuits repeat scoring of (variant, scenario, rep)', async () => {
    let calls = 0
    const adapter: ScoreAdapter<Payload> = {
      async score({ variant, scenarioId, rep }) {
        calls++
        return {
          variantId: variant.id,
          scenarioId,
          rep,
          ok: true,
          score: 0.5,
          cost: 1,
        } satisfies PromptTrialResult
      },
    }
    // Mutator that returns no children — survivors carry forward unchanged so
    // a cache-equipped run should reuse trials across generations.
    const mutator: MutateAdapter<Payload> = {
      async mutate() { return [] },
    }
    const cache = new InMemoryTrialCache()

    await runPromptEvolution<Payload>({
      runId: 'r2',
      target: 'cached',
      seedVariants: [seed(0.5, 'only')],
      scenarioIds: ['s1'],
      reps: 2,
      generations: 3,
      populationSize: 1,
      scoreConcurrency: 1,
      scoreAdapter: adapter,
      mutateAdapter: mutator,
      objectives,
      cache,
      earlyStopOnNoImprovement: false,
    })
    // 1 variant × 1 scenario × 2 reps = 2 trials in gen 0; gens 1-2 hit cache
    expect(calls).toBe(2)
    expect(cache.size()).toBe(2)
  })

  it('emits onProgress events for each phase', async () => {
    const events: string[] = []
    const adapter: ScoreAdapter<Payload> = {
      async score({ variant, scenarioId, rep }) {
        return { variantId: variant.id, scenarioId, rep, ok: true, score: 0.5, cost: 1 }
      },
    }
    const mutator: MutateAdapter<Payload> = { async mutate() { return [] } }
    await runPromptEvolution<Payload>({
      runId: 'r3',
      target: 't',
      seedVariants: [seed(0.5, 'a')],
      scenarioIds: ['s1'],
      reps: 1,
      generations: 1,
      populationSize: 1,
      scoreConcurrency: 1,
      scoreAdapter: adapter,
      mutateAdapter: mutator,
      objectives,
      onProgress: (e) => events.push(e.type),
    })
    expect(events).toContain('generation-start')
    expect(events).toContain('trial-complete')
    expect(events).toContain('generation-complete')
  })

  it('respects scoreConcurrency limit', async () => {
    let inflight = 0
    let peak = 0
    const adapter: ScoreAdapter<Payload> = {
      async score({ variant, scenarioId, rep }) {
        inflight++
        peak = Math.max(peak, inflight)
        await new Promise((r) => setTimeout(r, 5))
        inflight--
        return { variantId: variant.id, scenarioId, rep, ok: true, score: 0.5, cost: 1 }
      },
    }
    const mutator: MutateAdapter<Payload> = { async mutate() { return [] } }
    await runPromptEvolution<Payload>({
      runId: 'rc',
      target: 't',
      seedVariants: Array.from({ length: 4 }, (_, i) => seed(0.1 * (i + 1), `v${i}`)),
      scenarioIds: ['s1', 's2'],
      reps: 2,
      generations: 1,
      populationSize: 4,
      scoreConcurrency: 2,
      scoreAdapter: adapter,
      mutateAdapter: mutator,
      objectives,
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('aggregates meanScore over all graded trials, not just ok=true (regression)', async () => {
    // Pre-fix bug: meanScore filtered to okTrials only. A scenario where every
    // trial scored 0.6 but ok=false (below quality_bar) would yield meanScore=0
    // because mean([]) returns 0 — torpedoing the variant aggregate even though
    // 0.6 is real signal.
    const adapter: ScoreAdapter<Payload> = {
      async score({ variant, scenarioId, rep }) {
        return {
          variantId: variant.id,
          scenarioId,
          rep,
          ok: false,           // failed quality_bar
          score: 0.6,          // but the score is real
          cost: 1,
          durationMs: 1,
        }
      },
    }
    const mutator: MutateAdapter<Payload> = { async mutate() { return [] } }
    const result = await runPromptEvolution<Payload>({
      runId: 'graded-but-failed',
      target: 't',
      seedVariants: [seed(0.5, 'a')],
      scenarioIds: ['s1'],
      reps: 2,
      generations: 1,
      populationSize: 1,
      scoreConcurrency: 1,
      scoreAdapter: adapter,
      mutateAdapter: mutator,
      objectives,
    })
    expect(result.bestAggregate.meanScore).toBeCloseTo(0.6, 5)
    expect(result.bestAggregate.okRate).toBe(0)
    // Error trials still excluded — covered by the original score signal.
  })

  it('error trials are excluded from meanScore but counted in okRate', async () => {
    let n = 0
    const adapter: ScoreAdapter<Payload> = {
      async score({ variant, scenarioId, rep }) {
        n++
        // First trial errors, second scores 0.8 and passes.
        if (n === 1) {
          return {
            variantId: variant.id, scenarioId, rep,
            ok: false, score: 0, error: 'agent crashed',
          }
        }
        return { variantId: variant.id, scenarioId, rep, ok: true, score: 0.8 }
      },
    }
    const mutator: MutateAdapter<Payload> = { async mutate() { return [] } }
    const result = await runPromptEvolution<Payload>({
      runId: 'mixed',
      target: 't',
      seedVariants: [seed(0.5, 'a')],
      scenarioIds: ['s1'],
      reps: 2,
      generations: 1,
      populationSize: 1,
      scoreConcurrency: 1,
      scoreAdapter: adapter,
      mutateAdapter: mutator,
      objectives,
    })
    // meanScore should be 0.8 (the one valid trial), not 0.4 (mean of [0, 0.8]).
    expect(result.bestAggregate.meanScore).toBeCloseTo(0.8, 5)
    expect(result.bestAggregate.okRate).toBe(0.5)
  })

  it('early-stops on no improvement', async () => {
    const adapter: ScoreAdapter<Payload> = {
      async score({ variant, scenarioId, rep }) {
        return { variantId: variant.id, scenarioId, rep, ok: true, score: 0.5, cost: 1 }
      },
    }
    const mutator: MutateAdapter<Payload> = { async mutate() { return [] } }
    const events: string[] = []
    const result = await runPromptEvolution<Payload>({
      runId: 'rs',
      target: 't',
      seedVariants: [seed(0.5, 'a')],
      scenarioIds: ['s1'],
      reps: 1,
      generations: 5,
      populationSize: 1,
      scoreConcurrency: 1,
      scoreAdapter: adapter,
      mutateAdapter: mutator,
      objectives,
      onProgress: (e) => events.push(e.type),
    })
    expect(events).toContain('converged')
    expect(result.generations.length).toBeLessThan(5)
  })
})
