import { describe, expect, it } from 'vitest'
import type { Scenario } from '../types'
import { type RunImprovementLoopOptions, runImprovementLoop } from './run-improvement-loop'

// Regression: a scenario present in BOTH the training pool (`scenarios`, which
// runOptimization adapts to) and `holdoutScenarios` (the gate's acceptance axis)
// leaks held-out data into optimization — the gate then reports lift measured on
// data the optimizer already saw (memorization read as generalization). The
// pre-flight guard must reject this BEFORE any rollout, not silently inflate.
const sc = (id: string): Scenario => ({ id, kind: 'unit' })

// Minimal opts that reach the disjointness guard: autoOnPromote='none' skips the
// gh-owner check; no driver/tracing avoids the tracing guard. Downstream fields
// are never read — the guard throws first — so a cast is sound here.
function optsWith(scenarios: Scenario[], holdoutScenarios: Scenario[]) {
  return {
    autoOnPromote: 'none',
    scenarios,
    holdoutScenarios,
  } as unknown as RunImprovementLoopOptions<Scenario, unknown>
}

describe('runImprovementLoop train/holdout disjointness guard', () => {
  it('throws before any rollout when a scenario appears in both train and holdout', async () => {
    await expect(
      runImprovementLoop(optsWith([sc('train-1'), sc('shared')], [sc('shared'), sc('hold-1')])),
    ).rejects.toThrow(/training scenarios and holdoutScenarios must be disjoint/)
  })

  it('names exactly the leaked ids — not the legitimately-disjoint ones', async () => {
    await expect(
      runImprovementLoop(
        optsWith(
          [sc('a'), sc('b'), sc('leak-1'), sc('leak-2')],
          [sc('leak-1'), sc('leak-2'), sc('c')],
        ),
      ),
    ).rejects.toThrow(/overlap: \[leak-1, leak-2\]/)
  })

  it('does NOT trip the disjointness guard when train and holdout are disjoint', async () => {
    // Disjoint inputs pass the guard and proceed into runOptimization, which
    // fails for unrelated missing deps. The point: the failure is NOT the
    // disjointness error — the guard let a valid split through.
    await expect(runImprovementLoop(optsWith([sc('train-1')], [sc('hold-1')]))).rejects.not.toThrow(
      /must be disjoint/,
    )
  })
})
