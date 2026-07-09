import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSkillOpt } from '../../src/campaign/presets/run-skill-opt'
import {
  type ProposePatchesArgs,
  parseSkillPatchResponse,
  type SkillOptProposer,
  skillOptProposer,
} from '../../src/campaign/proposers/skill-opt'
import type { SkillPatch } from '../../src/campaign/skill-patch'
import type { JudgeConfig, ProposeContext, Scenario } from '../../src/campaign/types'

interface S extends Scenario {
  id: string
  kind: string
}
interface A {
  text: string
}

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'skillopt-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

// ── parseSkillPatchResponse (adversarial) ──────────────────────────────────

describe('parseSkillPatchResponse', () => {
  it('parses patches + truncates ops to the edit budget', () => {
    const raw = JSON.stringify({
      patches: [
        {
          label: 'l',
          rationale: 'r',
          ops: [
            { op: 'add', after: 'X', text: 'a' },
            { op: 'delete', anchor: 'Y' },
            { op: 'replace', anchor: 'Z', text: 'z' },
          ],
        },
      ],
    })
    const out = parseSkillPatchResponse(raw, 5, 2)
    expect(out).toHaveLength(1)
    expect(out[0]!.ops).toHaveLength(2) // budget=2 truncates the 3rd op
  })

  it('strips code fences', () => {
    const raw =
      '```json\n{"patches":[{"label":"l","rationale":"r","ops":[{"op":"delete","anchor":"X"}]}]}\n```'
    expect(parseSkillPatchResponse(raw, 5, 3)).toHaveLength(1)
  })

  it('drops malformed ops (missing required fields), keeps valid ones', () => {
    const raw = JSON.stringify({
      patches: [
        {
          label: 'l',
          rationale: 'r',
          ops: [
            { op: 'delete' }, // missing anchor → dropped
            { op: 'add' }, // missing text → dropped
            { op: 'replace', anchor: 'Z', text: 'z' }, // valid
            { op: 'bogus', anchor: 'Q' }, // unknown → dropped
          ],
        },
      ],
    })
    const out = parseSkillPatchResponse(raw, 5, 9)
    expect(out[0]!.ops).toEqual([{ op: 'replace', anchor: 'Z', text: 'z' }])
  })

  it('drops a patch whose ops all fail validation', () => {
    const raw = JSON.stringify({
      patches: [{ label: 'l', rationale: 'r', ops: [{ op: 'delete' }] }],
    })
    expect(parseSkillPatchResponse(raw, 5, 9)).toEqual([])
  })

  it('THROWS on non-JSON (a router/model failure must not look like zero patches)', () => {
    expect(() => parseSkillPatchResponse('not json at all', 5, 3)).toThrow(/not valid JSON/)
  })

  it('returns [] for valid JSON with zero usable patches (a legitimate no-op)', () => {
    expect(parseSkillPatchResponse(JSON.stringify({ patches: [] }), 5, 3)).toEqual([])
    expect(
      parseSkillPatchResponse(JSON.stringify({ patches: [{ label: 'l', ops: [] }] }), 5, 3),
    ).toEqual([])
  })

  it('caps at maxPatches', () => {
    const raw = JSON.stringify({
      patches: Array.from({ length: 5 }, (_, i) => ({
        label: `p${i}`,
        rationale: 'r',
        ops: [{ op: 'delete', anchor: 'X' }],
      })),
    })
    expect(parseSkillPatchResponse(raw, 2, 3)).toHaveLength(2)
  })
})

// ── skillOptProposer (LLM-stubbed) ────────────────────────────────────────────

describe('skillOptProposer', () => {
  function patchFetch(capture: { user?: string }, patches: SkillPatch[]): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      capture.user = body.messages?.find((m: { role: string }) => m.role === 'user')?.content
      const content = JSON.stringify({ patches })
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  const DOC = '# Skill\n- always cite a source'

  it('proposePatches feeds the surface + rejected buffer into the prompt', async () => {
    const capture: { user?: string } = {}
    const proposer = skillOptProposer({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: patchFetch(capture, []) },
      model: 'm',
      target: 'citation policy',
    })
    await proposer.proposePatches({
      surface: DOC,
      evidence: {
        weakScenarios: [{ scenarioId: 'cite-missing', composite: 0.1 }],
        weakDimensions: [{ dimension: 'grounding', score: 0.2 }],
      },
      editBudget: 2,
      rejectedBuffer: [{ label: 'tried-X', rationale: 'r', reason: 'no improvement' }],
      count: 1,
      signal: new AbortController().signal,
    })
    expect(capture.user).toContain('always cite a source') // the surface
    expect(capture.user).toContain('cite-missing') // weak scenario evidence
    expect(capture.user).toContain('grounding') // weak dimension evidence
    expect(capture.user).toContain('tried-X') // rejected buffer
    expect(capture.user).toContain('at most 2') // the edit budget
  })

  it('propose() feeds ctx.findings + ctx.report into the patch prompt', async () => {
    // The dead-wire regression: findings/report were plumbed onto ProposeContext
    // but skill-opt never read them. A patch must now be able to target the
    // analyst's diagnosed root cause, not just the weak-scenario evidence.
    const capture: { user?: string } = {}
    const proposer = skillOptProposer({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: patchFetch(capture, []) },
      model: 'm',
      target: 'citation policy',
    })
    const ctx: ProposeContext = {
      currentSurface: DOC,
      history: [],
      findings: [
        {
          severity: 'high',
          area: 'grounding',
          claim: 'answers cite no source when the retrieval set is empty',
          recommended_action: 'state "no source found" instead of fabricating one',
        },
      ],
      report: 'Hallucinated citations appeared in 3 of 7 empty-retrieval cases.',
      populationSize: 1,
      generation: 0,
      signal: new AbortController().signal,
    }
    await proposer.propose(ctx)
    expect(capture.user).toContain('Diagnosed findings')
    expect(capture.user).toContain('cite no source when the retrieval set is empty')
    expect(capture.user).toContain('no source found') // recommended_action
    expect(capture.user).toContain('Research report')
    expect(capture.user).toContain('3 of 7 empty-retrieval')
  })

  it('propose (generic SurfaceProposer) applies patches to the surface', async () => {
    const patches: SkillPatch[] = [
      {
        label: 'add-rule',
        rationale: 'fill gap',
        ops: [{ op: 'add', after: '- always cite a source', text: '- never fabricate a citation' }],
      },
    ]
    const proposer = skillOptProposer({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: patchFetch({}, patches) },
      model: 'm',
      target: 'citation policy',
    })
    const ctx: ProposeContext = {
      currentSurface: DOC,
      history: [],
      findings: [],
      populationSize: 1,
      generation: 0,
      signal: new AbortController().signal,
    }
    const out = await proposer.propose(ctx)
    expect(out).toHaveLength(1)
    expect(out[0]!.label).toBe('add-rule')
    expect(String(out[0]!.surface)).toContain('- never fabricate a citation')
    expect(String(out[0]!.surface)).toContain('- always cite a source') // original preserved
  })

  it('propose throws on a non-string (CodeSurface) — SkillOpt patches text', async () => {
    const proposer = skillOptProposer({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: patchFetch({}, []) },
      model: 'm',
      target: 't',
    })
    await expect(
      proposer.propose({
        currentSurface: { kind: 'code', worktreeRef: '/wt/a' } as never,
        history: [],
        findings: [],
        populationSize: 1,
        generation: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/string skill document/)
  })
})

// ── runSkillOpt epoch loop (deterministic, scripted proposer) ────────────────

describe('runSkillOpt', () => {
  const SCEN_TRAIN: S[] = [
    { id: 't1', kind: 'doc' },
    { id: 't2', kind: 'doc' },
  ]
  const SCEN_HOLD: S[] = [
    { id: 'h1', kind: 'doc' },
    { id: 'h2', kind: 'doc' },
  ]
  // Score = fraction of the two "good" markers present in the surface.
  const judge: JudgeConfig<A, S> = {
    name: 'markers',
    dimensions: [{ key: 'q', description: 'quality' }],
    score: ({ artifact }) => {
      const n =
        (artifact.text.includes('GOOD_A') ? 1 : 0) + (artifact.text.includes('GOOD_B') ? 1 : 0)
      const v = n / 2
      return { dimensions: { q: v }, composite: v, notes: '' }
    },
  }

  /** A scripted SkillOpt proposer: epoch 0 adds GOOD_A (accepted), epochs 1+2
   *  add neutral lines (rejected → drives budget annealing), epoch 3 adds
   *  GOOD_B (accepted). Captures the args it was called with. */
  function scriptedProposer(seen: ProposePatchesArgs[]): SkillOptProposer {
    const scripts: SkillPatch[][] = [
      [{ label: 'add-good-a', rationale: 'introduce A', ops: [{ op: 'add', text: 'GOOD_A' }] }],
      [{ label: 'neutral-1', rationale: 'noise', ops: [{ op: 'add', text: 'NEUTRAL_1' }] }],
      [{ label: 'neutral-2', rationale: 'noise', ops: [{ op: 'add', text: 'NEUTRAL_2' }] }],
      [{ label: 'add-good-b', rationale: 'introduce B', ops: [{ op: 'add', text: 'GOOD_B' }] }],
    ]
    let call = 0
    return {
      kind: 'scripted-skill-opt',
      async propose() {
        return []
      },
      async proposePatches(args: ProposePatchesArgs): Promise<SkillPatch[]> {
        seen.push(args)
        return scripts[call++] ?? []
      },
    }
  }

  it('accepts only held-out-improving edits, anneals the budget, and is monotonic', async () => {
    const seen: ProposePatchesArgs[] = []
    const result = await runSkillOpt<S, A>({
      baselineSurface: '# Skill\n- base rule',
      dispatchWithSurface: async (surface) => ({ text: surface }),
      judges: [judge],
      proposer: scriptedProposer(seen),
      trainScenarios: SCEN_TRAIN,
      holdoutScenarios: SCEN_HOLD,
      maxEpochs: 4,
      patchesPerEpoch: 1,
      editBudget: 3,
      runDir,
      expectUsage: 'off',
    })

    // Baseline has neither marker → 0; winner has both → 1.0.
    expect(result.baselineHoldoutComposite).toBe(0)
    expect(result.winnerHoldoutComposite).toBe(1)
    expect(result.lift).toBe(1)
    // Exactly the two marker edits were accepted; the two neutral edits rejected.
    expect(result.acceptedEdits.map((e) => e.label)).toEqual(['add-good-a', 'add-good-b'])
    expect(result.rejectedEdits.map((e) => e.label).sort()).toEqual(['neutral-1', 'neutral-2'])
    // The winning surface carries BOTH accepted edits.
    expect(result.winnerSurface).toContain('GOOD_A')
    expect(result.winnerSurface).toContain('GOOD_B')
    expect(result.winnerSurface).not.toContain('NEUTRAL_1') // rejected → never applied to winner

    // Monotonic non-decreasing held-out across epochs (never ships a regression).
    const holdouts = result.history.map((h) => h.holdoutComposite)
    for (let i = 1; i < holdouts.length; i++)
      expect(holdouts[i]!).toBeGreaterThanOrEqual(holdouts[i - 1]!)

    // Budget annealed: after 2 consecutive rejected epochs (1 and 2), epoch 2's
    // recorded budget drops 3 → 2.
    expect(result.history[0]!.editBudget).toBe(3) // accepted epoch, no decay
    expect(result.history[2]!.editBudget).toBe(2) // two rejections → annealed

    // The rejected buffer was threaded back into the proposer on later calls.
    const epoch2Args = seen[2]!
    expect(epoch2Args.rejectedBuffer.length).toBeGreaterThan(0)
    expect(epoch2Args.rejectedBuffer.some((r) => r.label === 'neutral-1')).toBe(true)
    // Budget anneals AFTER the epoch-2 proposal (so epoch 2 still saw 3), and
    // the annealed budget reaches the proposer on the next epoch (epoch 3).
    expect(epoch2Args.editBudget).toBe(3)
    expect(seen[3]!.editBudget).toBe(2)
  })

  it('reports zero lift when nothing improves (and never regresses)', async () => {
    const onlyNeutral: SkillOptProposer = {
      kind: 'neutral',
      async propose() {
        return []
      },
      async proposePatches() {
        return [{ label: 'noise', rationale: 'r', ops: [{ op: 'add', text: 'IGNORED' }] }]
      },
    }
    const result = await runSkillOpt<S, A>({
      baselineSurface: '# Skill',
      dispatchWithSurface: async (surface) => ({ text: surface }),
      judges: [judge],
      proposer: onlyNeutral,
      trainScenarios: SCEN_TRAIN,
      holdoutScenarios: SCEN_HOLD,
      maxEpochs: 3,
      patience: 2, // stop after 2 fruitless epochs
      runDir,
      expectUsage: 'off',
    })
    expect(result.lift).toBe(0)
    expect(result.acceptedEdits).toEqual([])
    expect(result.winnerSurface).toBe('# Skill') // unchanged
    expect(result.epochsRun).toBe(2) // patience stopped it early
  })

  it('does NOT anneal the budget on a single rejection followed by an acceptance', async () => {
    // reject epoch 0 (sinceAccept=1, no anneal), accept epoch 1 (sinceAccept→0).
    // Annealing requires >=2 CONSECUTIVE rejections, so the budget stays at 3.
    const scripts: SkillPatch[][] = [
      [{ label: 'neutral', rationale: 'noise', ops: [{ op: 'add', text: 'NEUTRAL' }] }],
      [{ label: 'add-good-a', rationale: 'A', ops: [{ op: 'add', text: 'GOOD_A' }] }],
    ]
    let call = 0
    const proposer: SkillOptProposer = {
      kind: 'one-reject-then-accept',
      async propose() {
        return []
      },
      async proposePatches() {
        return scripts[call++] ?? []
      },
    }
    const result = await runSkillOpt<S, A>({
      baselineSurface: '# Skill',
      dispatchWithSurface: async (surface) => ({ text: surface }),
      judges: [judge],
      proposer,
      trainScenarios: SCEN_TRAIN,
      holdoutScenarios: SCEN_HOLD,
      maxEpochs: 2,
      editBudget: 3,
      runDir,
      expectUsage: 'off',
    })
    expect(result.history[0]!.accepted).toBeNull() // epoch 0 rejected
    expect(result.history[1]!.accepted).not.toBeNull() // epoch 1 accepted
    expect(result.history.every((h) => h.editBudget === 3)).toBe(true) // never annealed
  })

  it('rejects a patch whose ops do not apply (applied === 0), without accepting it', async () => {
    // The patch anchors on a line that does not exist → applySkillPatch yields
    // applied=0 / unchanged surface → the loop rejects it before scoring.
    const proposer: SkillOptProposer = {
      kind: 'unanchored',
      async propose() {
        return []
      },
      async proposePatches() {
        return [
          {
            label: 'bad-anchor',
            rationale: 'r',
            ops: [{ op: 'replace', anchor: 'NO_SUCH_LINE', text: 'x' }],
          },
        ]
      },
    }
    const result = await runSkillOpt<S, A>({
      baselineSurface: '# Skill',
      dispatchWithSurface: async (surface) => ({ text: surface }),
      judges: [judge],
      proposer,
      trainScenarios: SCEN_TRAIN,
      holdoutScenarios: SCEN_HOLD,
      maxEpochs: 1,
      runDir,
      expectUsage: 'off',
    })
    expect(result.acceptedEdits).toEqual([])
    expect(result.rejectedEdits.map((r) => r.label)).toEqual(['bad-anchor'])
    expect(result.rejectedEdits[0]!.reason).toContain('no-op')
    expect(result.winnerSurface).toBe('# Skill')
  })

  const noopProposer: SkillOptProposer = {
    kind: 'noop',
    async propose() {
      return []
    },
    async proposePatches() {
      return []
    },
  }
  const guardBase = {
    baselineSurface: '# Skill',
    dispatchWithSurface: async (surface: string) => ({ text: surface }),
    proposer: noopProposer,
    maxEpochs: 1,
    runDir: '/tmp/never',
    expectUsage: 'off' as const,
  }

  it('throws when no judges are provided (scoring would be a silent zero)', async () => {
    await expect(
      runSkillOpt<S, A>({
        ...guardBase,
        judges: [],
        trainScenarios: SCEN_TRAIN,
        holdoutScenarios: SCEN_HOLD,
      }),
    ).rejects.toThrow(/at least one judge/)
  })

  it('throws when train and holdout overlap (held-out leakage)', async () => {
    await expect(
      runSkillOpt<S, A>({
        ...guardBase,
        judges: [judge],
        trainScenarios: [{ id: 'h1', kind: 'doc' }, ...SCEN_TRAIN],
        holdoutScenarios: SCEN_HOLD,
      }),
    ).rejects.toThrow(/disjoint/)
  })

  it('throws on a negative minImprovement (would accept regressions)', async () => {
    await expect(
      runSkillOpt<S, A>({
        ...guardBase,
        judges: [judge],
        trainScenarios: SCEN_TRAIN,
        holdoutScenarios: SCEN_HOLD,
        minImprovement: -0.1,
      }),
    ).rejects.toThrow(/minImprovement must be >= 0/)
  })
})
