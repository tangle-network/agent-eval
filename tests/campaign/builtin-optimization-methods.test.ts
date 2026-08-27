import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type BuiltinOptimizationMethodConfig,
  fapoEscalationMethod,
  gepaParetoMethod,
  gepaReflectionMethod,
  skillOptMethod,
} from '../../src/campaign/presets/builtin-optimization-methods'
import { compareOptimizationMethods } from '../../src/campaign/presets/compare-optimization-methods'
import type { JudgeConfig } from '../../src/campaign/types'
import {
  type TestArtifact as A,
  PARTITIONS,
  type TestScenario as S,
} from './optimization-method-test-fixtures'

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'compare-builtins-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

describe('built-in optimization methods', () => {
  const M1 = 'MARKER_ONE'
  const M2 = 'MARKER_TWO'
  const offlineRunOptions = { expectUsage: 'off' as const }
  const markerJudge: JudgeConfig<A, S> = {
    name: 'markers',
    dimensions: [{ key: 'q', description: 'quality' }],
    score: ({ artifact }) => {
      const value = (artifact.text.includes(M1) ? 0.5 : 0) + (artifact.text.includes(M2) ? 0.5 : 0)
      return { dimensions: { q: value }, composite: value, notes: '' }
    },
  }
  const markerDispatch = async (surface: unknown): Promise<A> => ({ text: String(surface) })

  function tripleFetch(baseline: string): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const system: string =
        body.messages?.find((message: { role: string }) => message.role === 'system')?.content ?? ''
      const content = system.includes('SkillOpt optimizer')
        ? JSON.stringify({
            patches: [
              {
                label: 'add-m1',
                rationale: 'introduce marker one',
                ops: [{ op: 'add', text: M1 }],
              },
            ],
          })
        : JSON.stringify({
            proposals: [
              {
                label: 'rewrite',
                rationale: 'add both markers',
                payload: `${baseline}\n${M1}\n${M2}`,
              },
            ],
          })
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
  }

  it('runs GEPA reflection, GEPA Pareto, and SkillOpt through their complete loops', async () => {
    const baseline = '# Skill\n- base rule'
    const config: BuiltinOptimizationMethodConfig<S, A> = {
      llm: {
        apiKey: 'k',
        baseUrl: 'https://router.test/v1',
        fetch: tripleFetch(baseline),
        customTokenPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      },
      model: 'test-model',
      target: 'a skill document',
      populationSize: 1,
      maxGenerations: 2,
      maxEpochs: 2,
    }

    const result = await compareOptimizationMethods<S, A>({
      methods: [gepaReflectionMethod(config), gepaParetoMethod(config), skillOptMethod(config)],
      baselineSurface: baseline,
      ...PARTITIONS,
      dispatchWithSurface: markerDispatch,
      judges: [markerJudge],
      runDir: join(runDir, 'compare'),
      seed: 7,
      optimizationRunOptions: { ...offlineRunOptions, costCeiling: 1 },
      expectUsage: 'off',
    })

    expect(result.scores).toHaveLength(3)
    expect(result.scores.every((score) => score.baselineComposite === 0)).toBe(true)
    expect(result.scores.map((score) => score.rank).sort()).toEqual([1, 2, 3])

    const gepaReflection = result.scores.find((score) => score.name === 'gepa-reflection')!
    const skillOpt = result.scores.find((score) => score.name === 'skill-opt')!
    expect(gepaReflection.winnerComposite).toBe(1)
    expect(gepaReflection.lift).toBeCloseTo(1, 5)
    expect(String(gepaReflection.winnerSurface)).toContain(M2)
    expect(skillOpt.winnerComposite).toBeCloseTo(0.5, 5)
    expect(String(skillOpt.winnerSurface)).toContain(M1)
    expect(String(skillOpt.winnerSurface)).not.toContain(M2)
    expect(skillOpt.rank).toBe(3)
    expect(result.best.lift).toBeGreaterThan(skillOpt.lift)
    expect(result.optimizationCost.accountingComplete).toBe(true)
    expect(result.pairwise).toHaveLength(2)
  })

  it('passes findings to GEPA candidate generation', async () => {
    const baseline = '# Skill\n- base rule'
    const prompts: string[] = []
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      prompts.push(
        body.messages?.find((message: { role: string }) => message.role === 'user')?.content ?? '',
      )
      const content = JSON.stringify({
        proposals: [
          { label: 'rewrite', rationale: 'add markers', payload: `${baseline}\n${M1}\n${M2}` },
        ],
      })
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const config: BuiltinOptimizationMethodConfig<S, A> = {
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: capturingFetch },
      model: 'test-model',
      target: 'a skill document',
      populationSize: 1,
      maxGenerations: 1,
      findings: [
        {
          severity: 'high',
          area: 'markers',
          claim: 'the surface omits MARKER_TWO on every training scenario',
          recommended_action: 'append MARKER_TWO to the skill document',
        },
      ],
    }

    await compareOptimizationMethods<S, A>({
      methods: [gepaReflectionMethod(config)],
      baselineSurface: baseline,
      ...PARTITIONS,
      dispatchWithSurface: markerDispatch,
      judges: [markerJudge],
      runDir: join(runDir, 'findings-compare'),
      seed: 7,
      optimizationRunOptions: offlineRunOptions,
      expectUsage: 'off',
    })

    const joined = prompts.join('\n---\n')
    expect(joined).toContain('Diagnosed findings')
    expect(joined).toContain('omits MARKER_TWO')
    expect(joined).toContain('append MARKER_TWO to the skill document')
  })

  it('runs FAPO through the complete loop', async () => {
    const baseline = '# Skill\n- base rule'
    const prompts: string[] = []
    const fapoFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      prompts.push(
        body.messages?.find((message: { role: string }) => message.role === 'user')?.content ?? '',
      )
      const content = JSON.stringify({
        proposals: [
          {
            label: 'prompt-fix',
            rationale: 'prompt-level fix',
            payload: `${baseline}\n${M1}\n${M2}`,
          },
        ],
      })
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const config: BuiltinOptimizationMethodConfig<S, A> = {
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: fapoFetch },
      model: 'test-model',
      target: 'a skill document',
      populationSize: 1,
      maxGenerations: 1,
    }

    const result = await compareOptimizationMethods<S, A>({
      methods: [fapoEscalationMethod(config)],
      baselineSurface: baseline,
      ...PARTITIONS,
      dispatchWithSurface: markerDispatch,
      judges: [markerJudge],
      runDir: join(runDir, 'fapo-compare'),
      seed: 7,
      optimizationRunOptions: offlineRunOptions,
      expectUsage: 'off',
    })

    expect(result.best.name).toBe('fapo-escalation')
    expect(result.best.winnerComposite).toBe(1)
    expect(String(result.best.winnerSurface)).toContain(M2)
    expect(prompts.join('\n')).toContain('Current variant')
  })

  it('requires every built-in winner to clear selection before final scoring', async () => {
    const baseline = '# baseline'
    const candidate = `${baseline}\nTEST_ONLY_WIN`
    const selectionJudge: JudgeConfig<A, S> = {
      name: 'selection-firewall',
      dimensions: [{ key: 'q', description: 'quality' }],
      score: ({ artifact, scenario }) => {
        const score = scenario.id.startsWith('s')
          ? 0
          : artifact.text.includes('TEST_ONLY_WIN')
            ? 1
            : 0
        return { dimensions: { q: score }, composite: score, notes: '' }
      },
    }
    const fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const system: string =
        body.messages?.find((message: { role: string }) => message.role === 'system')?.content ?? ''
      const content = system.includes('SkillOpt optimizer')
        ? JSON.stringify({
            patches: [
              {
                label: 'test-only',
                rationale: 'would win only on test',
                ops: [{ op: 'add', text: 'TEST_ONLY_WIN' }],
              },
            ],
          })
        : JSON.stringify({
            proposals: [{ label: 'test-only', rationale: 'test-only', payload: candidate }],
          })
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch
    const config: BuiltinOptimizationMethodConfig<S, A> = {
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch },
      model: 'test-model',
      target: 'a skill document',
      populationSize: 1,
      maxGenerations: 1,
      maxEpochs: 1,
    }

    const result = await compareOptimizationMethods<S, A>({
      methods: [gepaReflectionMethod(config), skillOptMethod(config), fapoEscalationMethod(config)],
      baselineSurface: baseline,
      ...PARTITIONS,
      dispatchWithSurface: markerDispatch,
      judges: [selectionJudge],
      runDir: join(runDir, 'selection-firewall-compare'),
      seed: 7,
      optimizationRunOptions: offlineRunOptions,
      expectUsage: 'off',
    })

    expect(result.scores.map((score) => score.winnerSurface)).toEqual([
      baseline,
      baseline,
      baseline,
    ])
    expect(result.scores.every((score) => score.winnerComposite === 0)).toBe(true)
  })
})
