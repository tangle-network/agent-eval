import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareDrivers,
  compareProposers,
  type DriverEntry,
  fapoEscalationEntry,
  gepaParetoEntry,
  gepaReflectionEntry,
  type OptimizerEntryConfig,
  type ProposerEntry,
  skillOptEntry,
} from '../../src/campaign/presets/compare-drivers'
import type { JudgeConfig, Scenario } from '../../src/campaign/types'

interface S extends Scenario {
  id: string
  kind: string
}
interface A {
  text: string
}

// Held-out scenarios; a surface scores 1 on a scenario iff it contains that
// scenario's marker. So a winner that solves more scenarios scores higher.
const HOLDOUT: S[] = [
  { id: 'h1', kind: 'q' },
  { id: 'h2', kind: 'q' },
  { id: 'h3', kind: 'q' },
  { id: 'h4', kind: 'q' },
]
const judge: JudgeConfig<A, S> = {
  name: 'solves',
  dimensions: [{ key: 'solved', description: 'scenario solved' }],
  score: ({ artifact, scenario }) => {
    const v = artifact.text.includes(`SOLVE_${scenario.id}`) ? 1 : 0
    return { dimensions: { solved: v }, composite: v, notes: '' }
  },
}

/** A driver entry that "promotes" a fixed surface (no LLM) — lets the
 *  benchmark harness be exercised deterministically in CI. */
function fixedEntry(name: string, winnerSurface: string, costUsd: number): DriverEntry {
  return { name, optimize: async () => ({ winnerSurface, costUsd, durationMs: 1 }) }
}

function fixedProposer(name: string, winnerSurface: string, costUsd: number): ProposerEntry {
  return fixedEntry(name, winnerSurface, costUsd)
}

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'compare-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

describe('compareDrivers', () => {
  it('ranks drivers by held-out lift, scores every winner uniformly, computes CIs', async () => {
    // Baseline solves nothing. Strong driver solves all 4; weak solves 1.
    const result = await compareDrivers<S, A>({
      drivers: [
        fixedEntry('weak', 'SOLVE_h1', 0.5),
        fixedEntry('strong', 'SOLVE_h1 SOLVE_h2 SOLVE_h3 SOLVE_h4', 2.0),
      ],
      baselineSurface: 'nothing-solved',
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      seed: 7,
      expectUsage: 'off',
    })

    // Strong wins; ranks assigned by lift.
    expect(result.best.name).toBe('strong')
    expect(result.scores.map((s) => s.name)).toEqual(['strong', 'weak'])
    expect(result.scores[0]!.rank).toBe(1)
    expect(result.scores[1]!.rank).toBe(2)

    // Baseline is identical for every driver (uniform scoring).
    expect(result.scores[0]!.baselineComposite).toBe(0)
    expect(result.scores[1]!.baselineComposite).toBe(0)

    // Strong solves 4/4 → mean composite 1.0, lift 1.0; weak solves 1/4 → 0.25.
    const strong = result.scores.find((s) => s.name === 'strong')!
    const weak = result.scores.find((s) => s.name === 'weak')!
    expect(strong.winnerComposite).toBe(1)
    expect(strong.lift).toBeCloseTo(1, 5)
    expect(weak.winnerComposite).toBeCloseTo(0.25, 5)
    expect(weak.lift).toBeCloseTo(0.25, 5)
    // Costs are carried through.
    expect(strong.costUsd).toBe(2.0)

    // Pairwise: strong (best) vs weak — delta 0.75, favored strong.
    expect(result.pairwise).toHaveLength(1)
    const pw = result.pairwise[0]!
    expect(pw.a).toBe('strong')
    expect(pw.b).toBe('weak')
    expect(pw.deltaMean).toBeCloseTo(0.75, 5)
    expect(pw.favored).toBe('strong')
    expect(pw.low).toBeGreaterThan(0) // CI clears zero → a real difference
    expect(result.holdoutScenarioIds).toEqual(['h1', 'h2', 'h3', 'h4'])
  })

  it('reports a tie (CI straddling 0) when two drivers solve the same scenarios', async () => {
    const result = await compareDrivers<S, A>({
      drivers: [fixedEntry('a', 'SOLVE_h1 SOLVE_h2', 1), fixedEntry('b', 'SOLVE_h1 SOLVE_h2', 1)],
      baselineSurface: 'nothing',
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      seed: 7,
      expectUsage: 'off',
    })
    expect(result.pairwise[0]!.deltaMean).toBeCloseTo(0, 5)
    expect(result.pairwise[0]!.favored).toBe('tie')
  })

  it('a cheaper driver wins a lift tie (cost tie-break)', async () => {
    const result = await compareDrivers<S, A>({
      drivers: [
        fixedEntry('expensive', 'SOLVE_h1 SOLVE_h2', 9),
        fixedEntry('cheap', 'SOLVE_h1 SOLVE_h2', 1),
      ],
      baselineSurface: 'nothing',
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      seed: 7,
      expectUsage: 'off',
    })
    expect(result.best.name).toBe('cheap')
  })

  it('FAILS LOUD when a surface is missing a held-out scenario score (no fabricated 0)', async () => {
    // A judge that errors on h3 → that cell has no score → the baseline score
    // vector omits h3. compareDrivers must refuse to fabricate a 0 for the
    // missing scenario (which would corrupt the lift CI) and throw, naming h3.
    const flakeyJudge: JudgeConfig<S, A> = {
      name: 'flakey',
      dimensions: [{ key: 'solved', description: 'solved' }],
      score: ({ scenario }) => {
        if (scenario.id === 'h3') throw new Error('judge unavailable for h3')
        return { dimensions: { solved: 1 }, composite: 1, notes: '' }
      },
    }
    await expect(
      compareDrivers<S, A>({
        drivers: [fixedEntry('d', 'whatever', 1)],
        baselineSurface: 'b',
        holdoutScenarios: HOLDOUT,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [flakeyJudge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/h3/)
  })

  it('throws on an empty driver list', async () => {
    await expect(
      compareDrivers<S, A>({
        drivers: [],
        baselineSurface: 'x',
        holdoutScenarios: HOLDOUT,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        runDir,
      }),
    ).rejects.toThrow(/no drivers/)
  })

  it('accepts compareProposers + proposers for the clearer public vocabulary', async () => {
    const result = await compareProposers<S, A>({
      proposers: [
        fixedProposer('weak', 'SOLVE_h1', 0.5),
        fixedProposer('strong', 'SOLVE_h1 SOLVE_h2 SOLVE_h3 SOLVE_h4', 2.0),
      ],
      baselineSurface: 'nothing-solved',
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      runDir,
      seed: 7,
      expectUsage: 'off',
    })

    expect(result.best.name).toBe('strong')
    expect(result.scores.map((s) => s.name)).toEqual(['strong', 'weak'])
  })

  it('fails loud when compareProposers receives different proposers and drivers arrays', async () => {
    await expect(
      compareProposers<S, A>({
        proposers: [fixedProposer('a', 'SOLVE_h1', 1)],
        drivers: [fixedProposer('b', 'SOLVE_h2', 1)],
        baselineSurface: 'nothing',
        holdoutScenarios: HOLDOUT,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/either proposers or drivers/)
  })

  it('uses compareProposers in downstream validation errors', async () => {
    const flakeyJudge: JudgeConfig<S, A> = {
      name: 'flakey',
      dimensions: [{ key: 'solved', description: 'solved' }],
      score: ({ scenario }) => {
        if (scenario.id === 'h3') throw new Error('judge unavailable for h3')
        return { dimensions: { solved: 1 }, composite: 1, notes: '' }
      },
    }

    await expect(
      compareProposers<S, A>({
        proposers: [fixedProposer('d', 'whatever', 1)],
        baselineSurface: 'b',
        holdoutScenarios: HOLDOUT,
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [flakeyJudge],
        runDir,
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/compareProposers: baseline produced no held-out score.*h3/)
  })
})

// ── End-to-end: the REAL built-in entries through the REAL loops ───────────
//
// Only the LLM transport is faked (a process boundary). gepaDriver +
// runImprovementLoop, skillOptDriver + runSkillOpt, and compareDrivers all run
// for real. The fake router improves the surface so a measured ranking falls
// out: GEPA rewrites the surface to carry BOTH reward markers (composite 1.0);
// SkillOpt patches in only ONE (composite 0.5). The regression this catches:
// any break in how an entry wires its loop, returns its winner, or reports
// cost — which the synthetic-entry tests above cannot see.

describe('compareDrivers — built-in entries, real loops, faked LLM only', () => {
  const M1 = 'MARKER_ONE'
  const M2 = 'MARKER_TWO'
  // Two reward markers; each holdout scenario rewards their PRESENCE equally.
  const markerJudge: JudgeConfig<A, S> = {
    name: 'markers',
    dimensions: [{ key: 'q', description: 'quality' }],
    score: ({ artifact }) => {
      const v = (artifact.text.includes(M1) ? 0.5 : 0) + (artifact.text.includes(M2) ? 0.5 : 0)
      return { dimensions: { q: v }, composite: v, notes: '' }
    },
  }

  // One router that serves all three request shapes by branching on the system
  // prompt: GEPA reflection/combine want {proposals:[{label,rationale,payload}]}
  // (payload = the FULL improved surface); SkillOpt wants {patches:[...]}.
  function tripleFetch(baseline: string): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const system: string =
        body.messages?.find((m: { role: string }) => m.role === 'system')?.content ?? ''
      let content: string
      if (system.includes('SkillOpt optimizer')) {
        // SkillOpt adds only M1 → reaches composite 0.5.
        content = JSON.stringify({
          patches: [
            { label: 'add-m1', rationale: 'introduce marker one', ops: [{ op: 'add', text: M1 }] },
          ],
        })
      } else {
        // GEPA reflection + combine rewrite the surface to carry BOTH markers.
        content = JSON.stringify({
          proposals: [
            {
              label: 'rewrite',
              rationale: 'add both markers',
              payload: `${baseline}\n${M1}\n${M2}`,
            },
          ],
        })
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
  }

  it('runs gepa-reflection vs gepa-pareto vs skill-opt and ranks by measured held-out lift', async () => {
    const baseline = '# Skill\n- base rule' // neither marker → composite 0
    const config: OptimizerEntryConfig<S, A> = {
      baselineSurface: baseline,
      trainScenarios: [
        { id: 't1', kind: 'q' },
        { id: 't2', kind: 'q' },
      ],
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [markerJudge],
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: tripleFetch(baseline) },
      model: 'test-model',
      target: 'a skill document',
      runDir: join(runDir, 'corpus'),
      seed: 7,
      populationSize: 1,
      maxGenerations: 2,
      maxEpochs: 2,
    }

    const result = await compareDrivers<S, A>({
      drivers: [gepaReflectionEntry(config), gepaParetoEntry(config), skillOptEntry(config)],
      baselineSurface: baseline,
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: config.dispatchWithSurface,
      judges: [markerJudge],
      runDir: join(runDir, 'compare'),
      seed: 7,
      expectUsage: 'off',
    })

    // All three ran + were scored uniformly; baseline measured at 0.
    expect(result.scores).toHaveLength(3)
    expect(result.scores.every((s) => s.baselineComposite === 0)).toBe(true)
    expect(result.scores.map((s) => s.rank).sort()).toEqual([1, 2, 3])

    // GEPA entries carry BOTH markers → composite 1.0, lift 1.0.
    const gepaRef = result.scores.find((s) => s.name === 'gepa-reflection')!
    const skill = result.scores.find((s) => s.name === 'skill-opt')!
    expect(gepaRef.winnerComposite).toBe(1)
    expect(gepaRef.lift).toBeCloseTo(1, 5)
    expect(String(gepaRef.winnerSurface)).toContain(M2)

    // SkillOpt patched in only ONE marker → composite 0.5, and is ranked below.
    expect(skill.winnerComposite).toBeCloseTo(0.5, 5)
    expect(String(skill.winnerSurface)).toContain(M1)
    expect(String(skill.winnerSurface)).not.toContain(M2)
    expect(skill.rank).toBe(3)
    expect(result.best.lift).toBeGreaterThan(skill.lift)

    // Pairwise CIs computed (best vs the other two).
    expect(result.pairwise).toHaveLength(2)
  })

  it("forwards config.findings through the GEPA entry → the finding reaches propose()'s reflection prompt (EYES→HANDS)", async () => {
    // The wiring this guards: OptimizerEntryConfig.findings → gepaEntry →
    // runImprovementLoop → runOptimization → ctx.findings → gepaDriver.propose →
    // reflection prompt. Capture the user prompt and assert the diagnosis landed.
    const baseline = '# Skill\n- base rule'
    const prompts: string[] = []
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      prompts.push(body.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? '')
      const content = JSON.stringify({
        proposals: [{ label: 'r', rationale: 'r', payload: `${baseline}\n${M1}\n${M2}` }],
      })
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const config: OptimizerEntryConfig<S, A> = {
      baselineSurface: baseline,
      trainScenarios: [
        { id: 't1', kind: 'q' },
        { id: 't2', kind: 'q' },
      ],
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [markerJudge],
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: capturingFetch },
      model: 'test-model',
      target: 'a skill document',
      runDir: join(runDir, 'findings-corpus'),
      seed: 7,
      populationSize: 1,
      maxGenerations: 1,
      findings: [
        {
          severity: 'high',
          area: 'markers',
          claim: 'the surface omits MARKER_TWO on every holdout scenario',
          recommended_action: 'append MARKER_TWO to the skill document',
        },
      ],
    }

    await compareDrivers<S, A>({
      drivers: [gepaReflectionEntry(config)],
      baselineSurface: baseline,
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: config.dispatchWithSurface,
      judges: [markerJudge],
      runDir: join(runDir, 'findings-compare'),
      seed: 7,
      expectUsage: 'off',
    })

    const joined = prompts.join('\n---\n')
    expect(joined).toContain('Diagnosed findings') // the renderAnalystEvidence block
    expect(joined).toContain('omits MARKER_TWO') // the claim
    expect(joined).toContain('append MARKER_TWO to the skill document') // recommended_action
  })

  it('runs the FAPO escalation entry through the real loop and scores it uniformly', async () => {
    const baseline = '# Skill\n- base rule'
    const prompts: string[] = []
    const fapoFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      prompts.push(body.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? '')
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

    const config: OptimizerEntryConfig<S, A> = {
      baselineSurface: baseline,
      trainScenarios: [
        { id: 't1', kind: 'q' },
        { id: 't2', kind: 'q' },
      ],
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [markerJudge],
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: fapoFetch },
      model: 'test-model',
      target: 'a skill document',
      runDir: join(runDir, 'fapo-corpus'),
      seed: 7,
      populationSize: 1,
      maxGenerations: 1,
    }

    const result = await compareDrivers<S, A>({
      drivers: [fapoEscalationEntry(config)],
      baselineSurface: baseline,
      holdoutScenarios: HOLDOUT,
      dispatchWithSurface: config.dispatchWithSurface,
      judges: [markerJudge],
      runDir: join(runDir, 'fapo-compare'),
      seed: 7,
      expectUsage: 'off',
    })

    expect(result.best.name).toBe('fapo-escalation')
    expect(result.best.winnerComposite).toBe(1)
    expect(String(result.best.winnerSurface)).toContain(M2)
    expect(prompts.join('\n')).toContain('Current variant')
  })
})
