/**
 * selfImprove() power-analysis wiring proof — offline, deterministic.
 *
 * Drives the REAL loop (baseline-only, no LLM) with a variance-bearing judge and
 * asserts the result carries the minimum-detectable-lift analysis and that the
 * `power.estimated` progress event fires. The MDE math itself is unit-tested in
 * campaign/gates/power-preflight.test.ts; this guards the composition.
 */

import { describe, expect, it } from 'vitest'
import type { JudgeConfig } from '../campaign/types'
import type { DispatchContext, Scenario } from './index'
import { type SelfImproveProgressEvent, selfImprove } from './self-improve'

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
  ctx.cost.observe(0.0001, 'stub-agent')
  ctx.cost.observeTokens({ input: 1, output: 1 })
  return { text: String(surface) }
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
