import { describe, it, expect } from 'vitest'
import { PromptOptimizer } from '../src/prompt-optimizer'

/**
 * Deterministic scoreVariant functions — the optimizer must be testable
 * without an LLM in the loop. The test scoreVariant simulates a variant
 * that's consistently better, the others are random around a lower mean.
 */

describe('PromptOptimizer', () => {
  it('picks the clear winner when one variant dominates', async () => {
    const opt = new PromptOptimizer()
    const result = await opt.run({
      variants: [
        { id: 'bad', prompt: 'bad' },
        { id: 'good', prompt: 'good' },
      ],
      scenarioIds: ['s1', 's2', 's3'],
      trialsPerScenario: 10,
      scoreVariant: async ({ variant }) => (variant.id === 'good' ? 0.95 : 0.2),
    })
    expect(result.winner.variantId).toBe('good')
    expect(result.winner.significant).toBe(true)
    expect(result.winner.ciLowerBoundExceedsSecondMean).toBe(true)
  })

  it('flags non-significant lead — regression: declaring a "winner" on noise would push bad prompts to prod', async () => {
    const opt = new PromptOptimizer()
    // Both variants ~ same distribution
    const result = await opt.run({
      variants: [
        { id: 'a', prompt: 'a' },
        { id: 'b', prompt: 'b' },
      ],
      scenarioIds: ['s1', 's2', 's3'],
      trialsPerScenario: 5,
      scoreVariant: async () => 0.5 + (Math.random() - 0.5) * 0.02,
    })
    expect(result.winner.significant).toBe(false)
  })

  it('records per-scenario samples for all variants', async () => {
    const opt = new PromptOptimizer()
    const result = await opt.run({
      variants: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }],
      scenarioIds: ['s1', 's2'],
      trialsPerScenario: 3,
      scoreVariant: async ({ trialIndex }) => trialIndex * 0.1,
    })
    for (const s of result.scores) {
      expect(Object.keys(s.perScenario)).toEqual(['s1', 's2'])
      expect(s.perScenario.s1.samples).toHaveLength(3)
      expect(s.n).toBe(6) // 2 scenarios x 3 trials
    }
  })

  it('fires onScenarioComplete after each scenario — regression: progress UI silently hangs without hooks', async () => {
    const opt = new PromptOptimizer()
    const events: string[] = []
    await opt.run({
      variants: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }],
      scenarioIds: ['s1'],
      trialsPerScenario: 2,
      scoreVariant: async () => 0.5,
      onScenarioComplete: ({ variantId }) => events.push(variantId),
    })
    expect(events).toEqual(['a', 'b'])
  })

  it('rejects <2 variants — regression: single-variant "optimization" is a no-op', async () => {
    const opt = new PromptOptimizer()
    await expect(
      opt.run({
        variants: [{ id: 'a', prompt: 'a' }],
        scenarioIds: ['s1'],
        scoreVariant: async () => 0.5,
      }),
    ).rejects.toThrow(/at least 2 variants/)
  })

  it('rejects empty scenario list', async () => {
    const opt = new PromptOptimizer()
    await expect(
      opt.run({
        variants: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }],
        scenarioIds: [],
        scoreVariant: async () => 0.5,
      }),
    ).rejects.toThrow(/at least 1 scenario/)
  })

  it('rejects NaN scores — regression: NaN contaminates the mean silently', async () => {
    const opt = new PromptOptimizer()
    await expect(
      opt.run({
        variants: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }],
        scenarioIds: ['s1'],
        scoreVariant: async () => NaN,
      }),
    ).rejects.toThrow(/non-finite/)
  })

  it('pairwise comparison count = n*(n-1)/2', async () => {
    const opt = new PromptOptimizer()
    const result = await opt.run({
      variants: [
        { id: 'a', prompt: 'a' },
        { id: 'b', prompt: 'b' },
        { id: 'c', prompt: 'c' },
        { id: 'd', prompt: 'd' },
      ],
      scenarioIds: ['s1'],
      trialsPerScenario: 3,
      scoreVariant: async () => 0.5,
    })
    expect(result.pairwise).toHaveLength(6) // 4C2
  })
})
