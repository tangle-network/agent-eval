import { join } from 'node:path'
import { combineComparisonCosts } from './optimization-cost'
import { executeOptimizationMethod } from './optimization-method'
import type {
  OptimizationMethod,
  OptimizationMethodComposition,
} from './presets/compare-optimization-methods'
import { fsCampaignStorage } from './storage'
import { surfaceContentHash } from './surface-identity'
import type { MutableSurface, Scenario } from './types'

/** Optimize a projection while evaluating every proposal in the complete candidate. */
export function scopedOptimizationMethod<S extends Scenario, A>(options: {
  name: string
  method: OptimizationMethod<S, A>
  project: (surface: MutableSurface) => MutableSurface
  merge: (baseline: MutableSurface, selected: MutableSurface) => MutableSurface
}): OptimizationMethod<S, A> {
  return {
    name: options.name,
    async optimize(input) {
      const baseline = structuredClone(input.baselineSurface)
      const projected = options.project(structuredClone(baseline))
      const merge = (surface: MutableSurface) =>
        options.merge(structuredClone(baseline), structuredClone(surface))
      const baselineSurfaceHash = surfaceContentHash(baseline)
      if (surfaceContentHash(merge(projected)) !== baselineSurfaceHash)
        throw new Error('scoped optimization project/merge must preserve the baseline')
      const { selected, cost } = await executeOptimizationMethod({
        method: options.method,
        input: {
          ...input,
          baselineSurface: projected,
          surfaceToRoot: (surface) => {
            const merged = merge(surface)
            return input.surfaceToRoot ? input.surfaceToRoot(merged) : merged
          },
          runDir: join(input.runDir, `scope-${baselineSurfaceHash.slice('sha256:'.length)}`),
          runOptions: {
            ...input.runOptions,
            dispatchRef: JSON.stringify([
              input.runOptions.dispatchRef ?? null,
              options.name,
              baselineSurfaceHash,
            ]),
          },
          dispatchWithSurface: (surface, scenario, ctx) =>
            input.dispatchWithSurface(merge(surface), scenario, ctx),
        },
        storage: input.runOptions.storage ?? fsCampaignStorage(),
      })
      return {
        winnerSurface: merge(selected.winnerSurface),
        cost,
        ...(selected.durationMs === undefined ? {} : { durationMs: selected.durationMs }),
        composition: {
          kind: 'scoped',
          baselineSurfaceHash,
          stages: [
            {
              name: options.method.name,
              baselineSurfaceHash: surfaceContentHash(projected),
              result: { ...selected, cost },
            },
          ],
        },
      }
    },
  }
}

/** Each stage starts from the previous selected candidate, without an intervening release gate. */
export function sequentialOptimizationMethod<S extends Scenario, A>(options: {
  name: string
  methods: readonly OptimizationMethod<S, A>[]
}): OptimizationMethod<S, A> {
  if (!options.methods.length)
    throw new Error('sequential optimization requires at least one method')
  const methods = [...options.methods]
  return {
    name: options.name,
    async optimize(input) {
      const started = Date.now()
      const stages: OptimizationMethodComposition['stages'] = []
      let winnerSurface = structuredClone(input.baselineSurface)
      for (const [index, method] of methods.entries()) {
        input.runOptions.signal?.throwIfAborted()
        const baselineSurfaceHash = surfaceContentHash(winnerSurface)
        const { selected, cost } = await executeOptimizationMethod({
          method,
          input: {
            ...input,
            baselineSurface: winnerSurface,
            runDir: join(input.runDir, `stage-${index}`),
          },
          storage: input.runOptions.storage ?? fsCampaignStorage(),
        })
        stages.push({ name: method.name, baselineSurfaceHash, result: { ...selected, cost } })
        winnerSurface = structuredClone(selected.winnerSurface)
      }
      return {
        winnerSurface,
        cost: combineComparisonCosts(
          stages.map((stage) => ({ label: stage.name, cost: stage.result.cost })),
        ),
        durationMs: Date.now() - started,
        composition: {
          kind: 'sequential',
          baselineSurfaceHash: surfaceContentHash(input.baselineSurface),
          stages,
        },
      }
    },
  }
}
