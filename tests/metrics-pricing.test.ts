import { describe, expect, it } from 'vitest'
import { estimateCost, isModelPriced, resolveModelPricing } from '../src/metrics'

// Regression: real model ids used through the Tangle router + cli-bridge
// harnesses priced to a silent $0 (MODEL_PRICING only had 6 legacy keys +
// estimateCost returned 0 on miss), blanking every cost/Pareto axis in
// analyzeRuns. Each id below MUST resolve to non-zero pricing.
describe('estimateCost — real harness/router model ids price non-zero', () => {
  const realIds = [
    'claude-code/sonnet',
    'claude-code/sonnet@canonical-eval-5152e6c',
    'anthropic/claude-sonnet-4-6',
    'opencode/zai-coding-plan/glm-5.1',
    'opencode/zai-coding-plan/glm-5-turbo',
    'kimi-code/kimi-k2.6',
    'moonshotai/kimi-k2',
    'deepseek-v4-pro',
    'deepseek/deepseek-chat',
    'glm-5.1',
    'google/gemini-2.5-flash-lite',
  ]
  for (const id of realIds) {
    it(`prices ${id}`, () => {
      expect(isModelPriced(id)).toBe(true)
      expect(estimateCost(1000, 1000, id)).toBeGreaterThan(0)
    })
  }

  it('still prices the exact legacy table entries', () => {
    expect(estimateCost(1000, 1000, 'gpt-4o')).toBeCloseTo(0.0125, 6)
  })

  it('uses the exact router-observed glm-5.3 rates', () => {
    expect(resolveModelPricing('glm-5.3')).toEqual({ input: 0.00168, output: 0.00528 })
    expect(estimateCost(1000, 1000, 'glm-5.3')).toBeCloseTo(0.00696, 8)
  })

  it('uses an exact served-model row through harness prefixes and snapshot suffixes', () => {
    expect(resolveModelPricing('opencode/zai-coding-plan/glm-5.3')).toEqual({
      input: 0.00168,
      output: 0.00528,
    })
    expect(resolveModelPricing('opencode/zai-coding-plan/glm-5.3@router-snapshot')).toEqual({
      input: 0.00168,
      output: 0.00528,
    })
  })

  it('keeps the coarse glm family fallback for other versions', () => {
    expect(resolveModelPricing('opencode/zai-coding-plan/glm-5.1')).toEqual({
      input: 0.0006,
      output: 0.0022,
    })
  })

  it('opus costs more than haiku (family ordering is correct)', () => {
    expect(estimateCost(1000, 1000, 'claude-code/opus')).toBeGreaterThan(
      estimateCost(1000, 1000, 'claude-haiku-4-5'),
    )
  })

  it('snapshot suffix does not change pricing', () => {
    expect(estimateCost(1000, 1000, 'deepseek-v4-pro@2026-05-28')).toBe(
      estimateCost(1000, 1000, 'deepseek-v4-pro'),
    )
  })

  it('truly unknown model is detectable (not a silent-priced 0)', () => {
    expect(isModelPriced('totally-made-up-model-xyz')).toBe(false)
    expect(resolveModelPricing('totally-made-up-model-xyz')).toBeNull()
    expect(estimateCost(1000, 1000, 'totally-made-up-model-xyz')).toBe(0)
  })
})
