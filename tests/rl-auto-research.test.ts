import { describe, expect, it } from 'vitest'
import type { GenerationReport, PromptEvolutionResult, TrialResult } from '../src/prompt-evolution'
import { analyzeOptimizationResult } from '../src/rl/auto-research'

function syntheticEvolution(): PromptEvolutionResult {
  const trials: TrialResult[] = []
  // 2 variants × 5 scenarios × 2 reps × 2 generations = 40 trials.
  for (let g = 0; g < 2; g++) {
    for (const variantId of ['baseline', 'cand']) {
      for (let s = 0; s < 5; s++) {
        for (let r = 0; r < 2; r++) {
          trials.push({
            variantId,
            scenarioId: `scenario-${s}`,
            rep: r,
            ok: true,
            score: variantId === 'cand' ? 0.7 + (s + g) * 0.001 : 0.5 + (s + g) * 0.001,
            cost: 0.001,
            durationMs: 100,
            metrics: { tool_recovery: variantId === 'cand' ? 0.9 : 0.5 },
          })
        }
      }
    }
  }
  const generations: GenerationReport[] = [
    {
      runId: 'gen-0',
      generation: 0,
      populationSize: 2,
      trials: trials.slice(0, 20),
      aggregates: [] as never[],
      pareto: { rank0: [] as never[], all: [] as never[] },
      bestVariantId: 'cand',
      bestScore: 0.71,
    },
    {
      runId: 'gen-1',
      generation: 1,
      populationSize: 2,
      trials: trials.slice(20),
      aggregates: [] as never[],
      pareto: { rank0: [] as never[], all: [] as never[] },
      bestVariantId: 'cand',
      bestScore: 0.72,
    },
  ]
  return {
    runId: 'rl-test',
    target: 'prompt',
    generations,
    bestVariantId: 'cand',
    bestScore: 0.72,
    converged: false,
    durationMs: 0,
  } as unknown as PromptEvolutionResult
}

describe('analyzeOptimizationResult', () => {
  it('converts every trial to a RunRecord and runs the full RL bridge', async () => {
    const out = await analyzeOptimizationResult({
      result: syntheticEvolution(),
      ctx: {
        experimentId: 'rl-test',
        model: 'm@2026',
        commitSha: 'abcd',
        promptHash: 'p'.repeat(64),
        configHash: 'c'.repeat(64),
      },
      comparator: 'baseline',
    })
    expect(out.runs.length).toBe(40)
    expect(out.preferences.pairs.length).toBeGreaterThan(0)
    expect(out.rewardHacking.verdict).toBeDefined()
    expect(out.interimConfidence).not.toBeNull()
    expect(out.summary).toMatch(/40 runs analysed/)
  })

  it('populates trainerRows.dpo when a DPO lookup is supplied', async () => {
    const out = await analyzeOptimizationResult({
      result: syntheticEvolution(),
      ctx: {
        experimentId: 'rl-test',
        model: 'm@2026',
        commitSha: 'abcd',
        promptHash: 'p'.repeat(64),
        configHash: 'c'.repeat(64),
      },
      comparator: 'baseline',
      trainerExport: {
        dpo: {
          promptOf: (id) => `prompt-${id}`,
          completionOf: (id) => `out-${id}`,
        },
      },
    })
    expect(out.trainerRows.dpo).toBeDefined()
    expect(out.trainerRows.dpo!.length).toBeGreaterThan(0)
  })

  it('returns interimConfidence=null when no comparator is supplied', async () => {
    const out = await analyzeOptimizationResult({
      result: syntheticEvolution(),
      ctx: {
        experimentId: 'rl-test',
        model: 'm@2026',
        commitSha: 'abcd',
        promptHash: 'p'.repeat(64),
        configHash: 'c'.repeat(64),
      },
    })
    expect(out.interimConfidence).toBeNull()
    expect(out.preferences.pairs.length).toBeGreaterThan(0)
  })

  it('handles MultiShotOptimizationResult shape via the embedded `evolution` field', async () => {
    const wrapper = { evolution: syntheticEvolution() } as Parameters<
      typeof analyzeOptimizationResult
    >[0]['result']
    const out = await analyzeOptimizationResult({
      result: wrapper,
      ctx: {
        experimentId: 'msot',
        model: 'm@2026',
        commitSha: 'abcd',
        promptHash: 'p'.repeat(64),
        configHash: 'c'.repeat(64),
      },
      comparator: 'baseline',
    })
    expect(out.runs.length).toBe(40)
  })
})
