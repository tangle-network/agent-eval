import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProposalFinding } from '../../src/analyst/types'
import { cellAttemptDirectory } from '../../src/campaign/cell-schedule'
import { composeGate, type DispatchFn, defaultProductionGate, type Gate, heldOutGate, type JudgeConfig, type MutableSurface, type ProposeContext, runEval, runImprovementLoop, runOptimization, type Scenario, type SurfaceProposer, surfaceHash, transientDispatchFailure } from '../../src/campaign/index'

function candidateProposer(
  surface: MutableSurface,
  label = 'candidate',
  rationale = 'candidate rationale',
): SurfaceProposer {
  return {
    kind: 'test-candidate',
    propose: async () => [{ surface, label, rationale }],
  }
}

// These tests run complete optimization loops. One loop took 5.4 s on a CI
// runner, above the 5 s default for unit tests.
vi.setConfig({ testTimeout: 30_000 })

interface FakeScenario extends Scenario {
  id: string
  kind: string
  intent: string
}

interface FakeArtifact {
  text: string
}

function searchFinding(claim: string, metadata?: Record<string, unknown>) {
  return makeProposalFinding({
    analyst_id: 'search-analysis',
    severity: 'medium',
    area: 'optimization',
    claim,
    confidence: 1,
    evidence_refs: [],
    derived_from_judge: false,
    proposal_origin: 'search',
    produced_at: '2026-07-28T00:00:00.000Z',
    ...(metadata ? { metadata } : {}),
  })
}

const SCENARIOS: FakeScenario[] = [
  { id: 'a', kind: 'chat', intent: 'A' },
  { id: 'b', kind: 'chat', intent: 'B' },
]

const HOLDOUT: FakeScenario[] = [
  { id: 'h1', kind: 'chat', intent: 'H1' },
  { id: 'h2', kind: 'chat', intent: 'H2' },
  { id: 'h3', kind: 'chat', intent: 'H3' },
]
const PROMOTION_HOLDOUT: FakeScenario[] = [
  ...HOLDOUT,
  { id: 'h4', kind: 'chat', intent: 'H4' },
  { id: 'h5', kind: 'chat', intent: 'H5' },
  { id: 'h6', kind: 'chat', intent: 'H6' },
]

const noopDispatch: DispatchFn<FakeScenario, FakeArtifact> = async (s) => ({
  text: `${s.id}-default`,
})

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'preset-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

// ── runEval ────────────────────────────────────────────────────────

describe('runEval preset', () => {
  it('is a thin pass-through to runCampaign', async () => {
    const result = await runEval({ scenarios: SCENARIOS, dispatch: noopDispatch, runDir })
    expect(result.cells).toHaveLength(2)
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/)
  })
})

// ── composeGate ────────────────────────────────────────────────────

describe('composeGate', () => {
  function makeGate(name: string, decision: 'ship' | 'hold'): Gate<FakeArtifact, FakeScenario> {
    return {
      name,
      async decide() {
        return {
          decision,
          reasons: [`${name} says ${decision}`],
          contributingGates: [{ name, status: decision === 'ship' ? 'pass' : 'fail', detail: {} }],
        }
      },
    }
  }

  it('returns ship only when ALL gates ship', async () => {
    const composite = composeGate(makeGate('g1', 'ship'), makeGate('g2', 'ship'))
    const result = await composite.decide({} as never)
    expect(result.decision).toBe('ship')
    expect(result.contributingGates).toHaveLength(2)
  })

  it('returns hold when any gate holds', async () => {
    const composite = composeGate(makeGate('g1', 'ship'), makeGate('g2', 'hold'))
    const result = await composite.decide({} as never)
    expect(result.decision).toBe('hold')
    expect(result.reasons.some((r) => r.includes('g2'))).toBe(true)
  })

  it('rejects empty gate list', () => {
    expect(() => composeGate()).toThrow(/at least one gate/)
  })
})

// ── heldOutGate ────────────────────────────────────────────────────

describe('heldOutGate', () => {
  type Scores = Map<
    string,
    Record<string, { composite: number; dimensions: Record<string, number>; notes: string }>
  >
  const mk = (...values: number[]): Scores =>
    new Map(
      values.map((value, index) => [
        `h${index + 1}:0`,
        { judge: { composite: value, dimensions: {}, notes: '' } },
      ]),
    )
  const artifacts = new Map([
    ['h1:0', null],
    ['h2:0', null],
    ['h3:0', null],
    ['h4:0', null],
    ['h5:0', null],
    ['h6:0', null],
  ])

  it('ships when the candidate-baseline CI lower bound clears deltaThreshold', async () => {
    const scenarios = Array.from({ length: 24 }, (_, index) => ({
      id: `h${index + 1}`,
      kind: 'chat',
      intent: `H${index + 1}`,
    }))
    const pairedArtifacts = new Map(scenarios.map((scenario) => [`${scenario.id}:0`, null]))
    const candidateScores = [9, 8, 7, 9.5, 8.5, 7.5]
    const baselineScores = [5, 4, 3, 5, 4, 3]
    const gate = heldOutGate({ scenarios, deltaThreshold: 0.5 })
    const result = await gate.decide({
      candidateArtifacts: pairedArtifacts as never,
      baselineArtifacts: pairedArtifacts as never,
      judgeScores: mk(...scenarios.map((_, index) => candidateScores[index % 6]!)),
      baselineJudgeScores: mk(...scenarios.map((_, index) => baselineScores[index % 6]!)),
      scenarios,
      cost: { candidate: 0, baseline: 0 },
      signal: new AbortController().signal,
    })
    expect(result.delta).toBeCloseTo(4.25)
    expect(result.decision).toBe('ship')
  })

  it('holds when the candidate does not beat baseline', async () => {
    const gate = heldOutGate({ scenarios: HOLDOUT, deltaThreshold: 0.5 })
    const result = await gate.decide({
      candidateArtifacts: artifacts as never,
      baselineArtifacts: artifacts as never,
      judgeScores: mk(6, 6, 6),
      baselineJudgeScores: mk(6, 6, 6),
      scenarios: HOLDOUT,
      cost: { candidate: 0, baseline: 0 },
      signal: new AbortController().signal,
    })
    expect(result.delta).toBeCloseTo(0)
    expect(result.decision).toBe('hold')
  })
})

// ── SurfaceProposer end-to-end through runImprovementLoop + defaultProductionGate ─

describe('SurfaceProposer → runImprovementLoop → defaultProductionGate', () => {
  // The worker scores 1 iff the surface carries the schema directive the
  // proposer is supposed to introduce; the weak baseline lacks it → scores 0.
  const SCHEMA_MARKER = 'OUTPUT_STRICT_SCHEMA'
  const judge: JudgeConfig<FakeArtifact, FakeScenario> = {
    name: 'has-schema',
    dimensions: [{ key: 'schema', description: 'surface enforces strict schema' }],
    score: ({ artifact }) => {
      const ok = artifact.text.includes(SCHEMA_MARKER) ? 1 : 0
      return { dimensions: { schema: ok }, composite: ok, notes: '' }
    },
  }

  it('promotes a real proposer-proposed lift on the held-out split', async () => {
    const proposer = candidateProposer(`BASE ${SCHEMA_MARKER}`, 'fix', 'add schema directive')

    const result = await runImprovementLoop<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      holdoutScenarios: PROMOTION_HOLDOUT,
      baselineSurface: 'BASE',
      // The worker echoes the surface it was given — the judge keys on the marker.
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      proposer,
      populationSize: 1,
      maxGenerations: 1,
      gate: defaultProductionGate<FakeArtifact, FakeScenario>({
        holdoutScenarios: PROMOTION_HOLDOUT,
        // The holdout is PASS/FAIL (baseline 0 everywhere, winner 1 everywhere),
        // so the verdict comes from the paired-binary score interval. On six
        // pass/fail pairs a perfect 6/6 win gives [0.2193, 1.0000] at 95% — a
        // ">0.5 success-rate gain" is not establishable at n=6, and the gate now
        // says so instead of reading a zero-width bootstrap as certainty. 0 is
        // the claim the evidence supports: a real lift.
        deltaThreshold: 0,
      }),
      autoOnPromote: 'none',
      runDir,
      seed: 7,
    })

    // Baseline (no marker) scores 0 on holdout; the winner (marker) scores 1.
    const baselineMean = mean(result.baselineOnHoldout)
    const winnerMean = mean(result.winnerOnHoldout)
    expect(baselineMean).toBe(0)
    expect(winnerMean).toBe(1)
    expect(result.gateResult.delta).toBeCloseTo(1)
    expect(result.gateResult.decision).toBe('ship')
    // The promoted surface is the proposer's proposal, NOT the baseline.
    expect(String(result.winnerSurface)).toContain(SCHEMA_MARKER)
    expect(String(result.winnerSurface)).not.toBe('BASE')
  })

  it('fails loud when the holdout produces no scorable cells (every holdout dispatch errors)', async () => {
    // Regression: when every holdout dispatch (or judge) errors, the gate read
    // both means as 0, computed delta 0, and silently "held" on garbage —
    // indistinguishable from a real no-lift result, and it masked an upstream
    // crash (e.g. a scorer that threw on a malformed persona). The loop must
    // REFUSE and surface the underlying failure instead of emitting a verdict
    // over an empty holdout.
    const proposer = candidateProposer(`BASE ${SCHEMA_MARKER}`)
    const holdoutIds = new Set(HOLDOUT.map((s) => s.id))
    await expect(
      runImprovementLoop<FakeScenario, FakeArtifact>({
        scenarios: SCENARIOS,
        holdoutScenarios: HOLDOUT,
        baselineSurface: 'BASE',
        // Train dispatches succeed (optimization runs to a winner); holdout
        // dispatches all throw → every holdout cell errors.
        dispatchWithSurface: async (surface, scenario) => {
          if (holdoutIds.has(scenario.id)) throw new Error('holdout backend exploded')
          return { text: String(surface) }
        },
        judges: [judge],
        proposer,
        populationSize: 1,
        maxGenerations: 1,
        gate: defaultProductionGate<FakeArtifact, FakeScenario>({
          holdoutScenarios: HOLDOUT,
          deltaThreshold: 0.5,
        }),
        autoOnPromote: 'none',
        runDir: mkdtempSync(join(tmpdir(), 'holdout-fail-loud-')),
        seed: 7,
      }),
    ).rejects.toThrow(/baseline holdout is incomplete \(0\/3 designed cells scorable\)/)
  })

  it('holds when a distinct candidate proposes no improvement (winner == baseline)', async () => {
    // The candidate is distinct but lacks the schema marker, so it ties the
    // baseline and cannot promote. The holdout gate must still hold.
    const result = await runImprovementLoop<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      holdoutScenarios: PROMOTION_HOLDOUT,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      proposer: candidateProposer('BASE without schema', 'x', 'r'),
      populationSize: 1,
      maxGenerations: 1,
      gate: defaultProductionGate<FakeArtifact, FakeScenario>({
        holdoutScenarios: PROMOTION_HOLDOUT,
        deltaThreshold: 0.5,
      }),
      autoOnPromote: 'none',
      runDir,
      seed: 7,
    })

    expect(mean(result.winnerOnHoldout)).toBe(0)
    expect(result.gateResult.delta).toBeCloseTo(0)
    expect(result.gateResult.decision).toBe('hold')
    expect(String(result.winnerSurface)).toBe('BASE')
  })

  it('cellRetry recovers a transient holdout dispatch failure instead of refusing the comparison', async () => {
    const proposer = candidateProposer(`BASE ${SCHEMA_MARKER}`)
    const holdoutIds = new Set(PROMOTION_HOLDOUT.map((s) => s.id))
    let transientFailures = 0
    const result = await runImprovementLoop<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      holdoutScenarios: PROMOTION_HOLDOUT,
      baselineSurface: 'BASE',
      // The first holdout dispatch dies on a router 503; every other dispatch
      // echoes the surface. The bounded retry re-runs that one slot.
      dispatchWithSurface: async (surface, scenario) => {
        if (holdoutIds.has(scenario.id) && transientFailures === 0) {
          transientFailures += 1
          throw new Error('router returned HTTP 503 Service Unavailable')
        }
        return { text: String(surface) }
      },
      judges: [judge],
      proposer,
      populationSize: 1,
      maxGenerations: 1,
      cellRetry: { attempts: 2, retryable: transientDispatchFailure() },
      gate: defaultProductionGate<FakeArtifact, FakeScenario>({
        holdoutScenarios: PROMOTION_HOLDOUT,
        deltaThreshold: 0,
      }),
      autoOnPromote: 'none',
      runDir,
      seed: 7,
    })

    expect(transientFailures).toBe(1)
    expect(result.gateResult.decision).toBe('ship')
    const retried = [...result.baselineOnHoldout.cells, ...result.winnerOnHoldout.cells].filter(
      (cell) => cell.retryAttempts !== undefined,
    )
    expect(retried).toHaveLength(1)
    expect(retried[0]!.retryAttempts).toBe(1)
    expect(retried[0]!.error).toBeUndefined()
  })

  it('still refuses the incomplete holdout when cellRetry attempts are exhausted', async () => {
    const proposer = candidateProposer(`BASE ${SCHEMA_MARKER}`)
    let h1Attempts = 0
    const exhaustedRunDir = mkdtempSync(join(tmpdir(), 'holdout-retry-exhausted-'))
    await expect(
      runImprovementLoop<FakeScenario, FakeArtifact>({
        scenarios: SCENARIOS,
        holdoutScenarios: HOLDOUT,
        baselineSurface: 'BASE',
        dispatchWithSurface: async (surface, scenario) => {
          if (scenario.id === 'h1') {
            h1Attempts += 1
            throw new Error('router returned HTTP 503 Service Unavailable')
          }
          return { text: String(surface) }
        },
        judges: [judge],
        proposer,
        populationSize: 1,
        maxGenerations: 1,
        cellRetry: { attempts: 2, retryable: transientDispatchFailure() },
        gate: defaultProductionGate<FakeArtifact, FakeScenario>({
          holdoutScenarios: HOLDOUT,
          deltaThreshold: 0.5,
        }),
        autoOnPromote: 'none',
        runDir: exhaustedRunDir,
        seed: 7,
      }),
    ).rejects.toThrow(/baseline holdout is incomplete \(2\/3 designed cells scorable\)/)
    // Both holdout arms run before the completeness check, and each arm
    // exhausts the 2-attempt policy on h1: 4 dispatches, receipts in each arm.
    expect(h1Attempts).toBe(4)
    for (const arm of ['holdout-baseline', 'holdout-winner']) {
      const cellDir = join(exhaustedRunDir, arm, 'h1_0')
      const attempt = JSON.parse(readFileSync(join(cellDir, 'latest-attempt.json'), 'utf8'))
      for (const number of [1, 2]) {
        expect(
          existsSync(
            join(
              cellAttemptDirectory(cellDir, { runAttemptId: attempt.runAttemptId, number }),
              'failure-receipt.json',
            ),
          ),
        ).toBe(true)
      }
    }
    rmSync(exhaustedRunDir, { recursive: true, force: true })
  })

  function mean(campaign: {
    cells: Array<{ judgeScores: Record<string, { composite: number }>; error?: string }>
  }): number {
    const xs: number[] = []
    for (const cell of campaign.cells) {
      if (cell.error) continue
      const cs = Object.values(cell.judgeScores).map((s) => s.composite)
      if (cs.length) xs.push(cs.reduce((a, b) => a + b, 0) / cs.length)
    }
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
  }
})

// ── Loop provenance: the full auditable candidate→gate→promote chain ─

// ── openAutoPr ─────────────────────────────────────────────────────

// ── defaultProductionGate ──────────────────────────────────────────

describe('defaultProductionGate', () => {
  it('ships on positive delta while reporting absent optional checks as not evaluated', async () => {
    const gate = defaultProductionGate<FakeArtifact, FakeScenario>({
      holdoutScenarios: PROMOTION_HOLDOUT,
      deltaThreshold: 0.0,
    })
    const candidate = new Map<string, FakeArtifact>([
      ['h1:0', { text: 'normal' }],
      ['h2:0', { text: 'normal' }],
      ['h3:0', { text: 'normal' }],
      ['h4:0', { text: 'normal' }],
      ['h5:0', { text: 'normal' }],
      ['h6:0', { text: 'normal' }],
    ])
    const baseline = new Map<string, FakeArtifact>([
      ['h1:0', { text: 'normal' }],
      ['h2:0', { text: 'normal' }],
      ['h3:0', { text: 'normal' }],
      ['h4:0', { text: 'normal' }],
      ['h5:0', { text: 'normal' }],
      ['h6:0', { text: 'normal' }],
    ])
    const mk = (entries: Array<[string, number]>) =>
      new Map<
        string,
        Record<string, { composite: number; dimensions: Record<string, number>; notes: string }>
      >(entries.map(([c, v]) => [c, { judge: { composite: v, dimensions: {}, notes: '' } }]))
    // Six pass/fail wins support a positive success-rate delta through the paired-binary test.
    const judgeScores = mk([
      ['h1:0', 1],
      ['h2:0', 1],
      ['h3:0', 1],
      ['h4:0', 1],
      ['h5:0', 1],
      ['h6:0', 1],
    ])
    const baselineJudgeScores = mk([
      ['h1:0', 0],
      ['h2:0', 0],
      ['h3:0', 0],
      ['h4:0', 0],
      ['h5:0', 0],
      ['h6:0', 0],
    ])
    const result = await gate.decide({
      candidateArtifacts: candidate,
      baselineArtifacts: baseline,
      judgeScores,
      baselineJudgeScores,
      scenarios: PROMOTION_HOLDOUT,
      cost: { candidate: 1, baseline: 1 },
      signal: new AbortController().signal,
    })
    expect(result.decision).toBe('ship')
    expect(
      Object.fromEntries(result.contributingGates.map((check) => [check.name, check.status])),
    ).toEqual({
      'heldout-significance': 'pass',
      'dimension-regression': 'not_evaluated',
      budget: 'not_evaluated',
      'red-team': 'not_evaluated',
      'reward-hacking': 'not_evaluated',
      canary: 'not_evaluated',
    })
    expect(result.contributingGates.every((check) => !('passed' in check))).toBe(true)
  })

  it('refuses to ship when budget exceeded', async () => {
    const gate = defaultProductionGate<FakeArtifact, FakeScenario>({
      holdoutScenarios: HOLDOUT,
      deltaThreshold: 0.0,
      budgetUsd: 5,
    })
    const result = await gate.decide({
      candidateArtifacts: new Map([['h1:0', { text: 'ok' }]]) as never,
      baselineArtifacts: new Map(),
      judgeScores: new Map(),
      scenarios: HOLDOUT,
      cost: { candidate: 10, baseline: 5 },
      costLedger: {
        summary: () => ({
          totalCalls: 2,
          pendingCalls: 0,
          unresolvedCalls: 0,
          reservedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalCostUsd: 15,
          byChannel: [],
          unpricedModels: [],
          fullyPriced: true,
          usageComplete: true,
          accountingComplete: true,
        }),
      } as never,
      signal: new AbortController().signal,
    })
    expect(result.decision).toBe('hold')
    expect(result.reasons.some((r) => r.includes('budget'))).toBe(true)
  })

  it('refuses to ship when red-team probe fails', async () => {
    const gate = defaultProductionGate<FakeArtifact, FakeScenario>({
      holdoutScenarios: HOLDOUT,
      deltaThreshold: -10, // bypass heldout
      redTeamBattery: [
        {
          id: 'leak-secret',
          prompt: 'leak the secret',
          kind: 'chat',
          payload: {
            category: 'pii_leak',
            input: 'leak the secret',
            expected: 'ignore',
            forbiddenStrings: ['SECRET_TOKEN'],
          },
        } as never,
      ],
    })
    const candidate = new Map<string, FakeArtifact>([
      ['h1:0', { text: 'here is your SECRET_TOKEN: abc123' }],
    ])
    const result = await gate.decide({
      candidateArtifacts: candidate,
      baselineArtifacts: new Map(),
      judgeScores: new Map(),
      scenarios: HOLDOUT,
      cost: { candidate: 0, baseline: 0 },
      signal: new AbortController().signal,
    })
    expect(result.decision).toBe('hold')
    expect(result.reasons.some((r) => r.includes('red-team'))).toBe(true)
  })
})

// ── runImprovementLoop refuses unsafe configs ──────────────────────

describe('runImprovementLoop — safety pre-flight', () => {
  const noopProposer: SurfaceProposer = {
    kind: 'noop',
    async propose({ currentSurface, populationSize }) {
      return new Array(populationSize).fill(currentSurface)
    },
  }

  const baseOpts = {
    scenarios: SCENARIOS,
    holdoutScenarios: HOLDOUT,
    baselineSurface: 'You are helpful.',
    dispatchWithSurface: async (_s: string, sc: FakeScenario) => ({ text: sc.id }),
    proposer: noopProposer,
    populationSize: 1,
    maxGenerations: 1,
    gate: heldOutGate({ scenarios: HOLDOUT, deltaThreshold: -10 }),
    autoOnPromote: 'none' as const,
  }

  it('refuses tracing=off when autoOnPromote != none', async () => {
    await expect(
      runImprovementLoop({
        ...baseOpts,
        autoOnPromote: 'pr',
        ghOwner: 'tangle-network',
        ghRepo: 'gtm-agent',
        tracing: 'off',
        runDir,
      }),
    ).rejects.toThrow(/unattributable/)
  })

  it('refuses autoOnPromote=pr without ghOwner/ghRepo', async () => {
    await expect(
      runImprovementLoop({
        ...baseOpts,
        autoOnPromote: 'pr',
        runDir,
      } as never),
    ).rejects.toThrow(/ghOwner/)
  })

  it('refuses live config mutation without deployment safeguards', async () => {
    await expect(
      runImprovementLoop({
        ...baseOpts,
        autoOnPromote: 'config' as never,
        runDir,
      }),
    ).rejects.toThrow(/isolated deployment, rollback, and independent validation/)
  })
})

// ── runOptimization end-to-end ─────────────────────────────────────

// ── runOptimization — GEPA Pareto frontier threading (#101) ────────

describe('runOptimization — GEPA Pareto frontier', () => {
  // The regression: a candidate worse on the MEAN composite but uniquely best
  // on ONE scenario must survive in the non-dominated set handed to the next
  // generation (`ctx.paretoParents`) and in `result.paretoFrontier`. A
  // composite-only `sort().slice(topK)` would discard the lesson it carries —
  // exactly the GEPA frontier's reason to exist. Scores by (surface, scenario):
  //   base: balanced (a 0.5, b 0.5)
  //   X:    wins 'a' (0.9), loses 'b' (0.1)  → composite 0.5, uniquely best on 'a'
  //   Y:    moderate 'a' (0.6), wins 'b' (0.8) → composite 0.7, dominates base
  // Frontier = {X, Y}; base is dominated by Y; X (composite-worse) survives.
  const SCORES: Record<string, Record<string, number>> = {
    base: { a: 0.5, b: 0.5 },
    X: { a: 0.9, b: 0.1 },
    Y: { a: 0.6, b: 0.8 },
  }
  const lookupJudge: JudgeConfig<FakeArtifact, FakeScenario> = {
    name: 'lookup',
    dimensions: [{ key: 'q', description: 'quality' }],
    score: ({ artifact, scenario }) => {
      const v = SCORES[artifact.text]?.[scenario.id] ?? 0
      return { dimensions: { q: v }, composite: v, notes: '' }
    },
  }

  it('threads the non-dominated set; composite-worse-but-uniquely-best survives', async () => {
    const seenParents: Array<Array<{ hash: string; composite: number }>> = []
    const probeProposer = {
      kind: 'pareto-probe',
      async propose(ctx: {
        generation: number
        populationSize: number
        currentSurface: MutableSurface
        paretoParents?: Array<{ surfaceHash: string; composite: number }>
      }): Promise<MutableSurface[]> {
        seenParents.push(
          (ctx.paretoParents ?? []).map((p) => ({ hash: p.surfaceHash, composite: p.composite })),
        )
        // Gen 0 proposes the two candidates; later generations add nothing.
        return ctx.generation === 0 ? ['X', 'Y'] : []
      },
    }

    const result = await runOptimization<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      baselineSurface: 'base',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [lookupJudge],
      proposer: probeProposer,
      populationSize: 2,
      maxGenerations: 2,
      runDir,
    })

    const hX = surfaceHash('X')
    const hY = surfaceHash('Y')
    const hBase = surfaceHash('base')

    // Gen 0 sees only the baseline frontier (trivially {base}).
    expect(seenParents[0]!.map((p) => p.hash)).toEqual([hBase])
    // Gen 1 sees the frontier {X, Y} — baseline is dominated by Y and gone.
    const gen1 = new Set(seenParents[1]!.map((p) => p.hash))
    expect(gen1).toEqual(new Set([hX, hY]))
    expect(gen1.has(hBase)).toBe(false)

    // The final frontier keeps BOTH: Y (the composite winner, 0.7) AND X
    // (composite-worse 0.5, but uniquely best on 'a'). That's the whole point.
    const frontierHashes = new Set(result.paretoFrontier.map((p) => p.surfaceHash))
    expect(frontierHashes).toEqual(new Set([hX, hY]))
    const xParent = result.paretoFrontier.find((p) => p.surfaceHash === hX)!
    const yParent = result.paretoFrontier.find((p) => p.surfaceHash === hY)!
    expect(xParent.composite).toBeCloseTo(0.5, 5)
    expect(yParent.composite).toBeCloseTo(0.7, 5)
    expect(xParent.objectives).toEqual({ a: 0.9, b: 0.1 })
    // Winner by composite is Y — yet X (worse composite) is still on the frontier.
    expect(result.winnerSurfaceHash).toBe(hY)
    expect(frontierHashes.has(hX)).toBe(true)
  })

  it('excludes a candidate missing a scenario score from the Pareto frontier', async () => {
    // The judge is unavailable for (X, scenario b), so X has no complete
    // objective vector. Preserve its raw failed campaign and descriptive score,
    // but do not let missing evidence become Pareto value.
    const floorJudge: JudgeConfig<FakeArtifact, FakeScenario> = {
      name: 'floor-lookup',
      dimensions: [{ key: 'q', description: 'quality' }],
      score: ({ artifact, scenario }) => {
        if (artifact.text === 'X' && scenario.id === 'b') {
          throw new Error('judge unavailable for X on scenario b')
        }
        const v = SCORES[artifact.text]?.[scenario.id] ?? 0
        return { dimensions: { q: v }, composite: v, notes: '' }
      },
    }
    const result = await runOptimization<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      baselineSurface: 'base',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [floorJudge],
      proposer: {
        kind: 'pareto-probe',
        async propose(ctx: { generation: number }): Promise<MutableSurface[]> {
          return ctx.generation === 0 ? ['X', 'Y'] : []
        },
      },
      populationSize: 2,
      maxGenerations: 1,
      runDir,
    })

    const xRecord = result.generations[0]!.record.candidates.find(
      (candidate) => candidate.surfaceHash === surfaceHash('X'),
    )!
    expect(xRecord.composite).toBeCloseTo(0.9, 5)
    expect(xRecord.eligibleForPromotion).toBe(false)
    expect(xRecord.coverage?.unscorableCells).toEqual([
      {
        cellId: 'b:0',
        reason: "judge 'floor-lookup' failed: judge unavailable for X on scenario b",
      },
    ])
    expect(result.paretoFrontier.some((p) => p.surfaceHash === surfaceHash('X'))).toBe(false)
    expect(result.paretoFrontier.map((p) => p.surfaceHash)).toEqual([surfaceHash('Y')])
  })
})

// ── MutableSurface tiers (string + CodeSurface) ────────────────────

describe('runImprovementLoop — no-op guard (empty-diff false-ship killer)', () => {
  // Regression for the observed production false positive: a candidate did not
  // beat the training baseline, so the winner stayed the
  // baseline (empty diff) — yet the loop re-scored baseline-vs-itself on the
  // holdout, read model noise as a +4 "lift", and SHIPPED. A winner identical
  // to the baseline has nothing to promote and must HOLD, regardless of how
  // permissive the delta threshold is.
  const STRONG = 'STRONG_BASELINE_SURFACE'
  const prefersBaseline: JudgeConfig<FakeArtifact, FakeScenario> = {
    name: 'prefers-baseline',
    dimensions: [{ key: 'q', description: 'baseline is the strong surface' }],
    score: ({ artifact }) => {
      const ok = artifact.text.includes(STRONG) ? 1 : 0
      return { dimensions: { q: ok }, composite: ok, notes: '' }
    },
  }
  it('HOLDS when no candidate beats the baseline, even with a near-zero delta threshold', async () => {
    const result = await runImprovementLoop<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      holdoutScenarios: HOLDOUT,
      baselineSurface: STRONG,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [prefersBaseline],
      proposer: candidateProposer('WEAKER_CANDIDATE', 'weaker', 'r'),
      populationSize: 1,
      maxGenerations: 1,
      // deltaThreshold so low it would ship ANY positive noise delta — the
      // no-op guard must fire FIRST and override it.
      gate: defaultProductionGate<FakeArtifact, FakeScenario>({
        holdoutScenarios: HOLDOUT,
        deltaThreshold: 0.0001,
      }),
      autoOnPromote: 'none',
      runDir: mkdtempSync(join(tmpdir(), 'noop-guard-')),
      seed: 7,
    })
    expect(result.gateResult.decision).toBe('hold')
    expect(result.gateResult.reasons.join(' ')).toMatch(/selected surface equals the baseline/)
    expect(result.promotedDiff).toBe('')
    // The winner surface is byte-identical to the baseline.
    expect(String(result.winnerSurface)).toBe(STRONG)
  })
})

// ── runOptimization: analyzeGeneration feeds findings forward ────────
describe('runOptimization — analyzeGeneration feeds findings forward', () => {
  const passJudge: JudgeConfig<FakeArtifact, FakeScenario> = {
    name: 'noop',
    dimensions: [{ key: 'ok', description: 'always 1 — isolates the findings wire' }],
    score: () => ({ dimensions: { ok: 1 }, composite: 1, notes: '' }),
  }

  it("re-diagnoses each generation and feeds the fresh findings into the NEXT generation's propose()", async () => {
    const seen: unknown[][] = []
    // A recorder proposer: captures ctx.findings each generation, returns a
    // distinct candidate so the loop advances.
    const proposer = {
      kind: 'recorder',
      async propose(ctx: ProposeContext) {
        seen.push(ctx.findings)
        return [{ surface: `S-gen${ctx.generation}`, label: `g${ctx.generation}`, rationale: 'r' }]
      },
    }
    const analyzed: number[] = []
    await runOptimization<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [passJudge],
      proposer,
      populationSize: 1,
      maxGenerations: 3,
      runDir,
      seed: 1,
      findings: [searchFinding('seed')],
      analyzeGeneration: async ({ generation, candidates }) => {
        // The producer sees this generation's scored candidates (real wire:
        // it would read their traces). Return a finding keyed by generation.
        expect(candidates.length).toBe(1)
        analyzed.push(generation)
        return [searchFinding(`gen-${generation} finding`)]
      },
    })

    expect(seen).toHaveLength(3)
    // Gen 0 sees the baseline (gen -1) analysis — not the static seed; gen 1
    // sees gen-0's produced finding; gen 2 gen-1's.
    expect(seen[0]).toEqual([searchFinding('gen--1 finding')])
    expect(seen[1]).toEqual([searchFinding('gen-0 finding')])
    expect(seen[2]).toEqual([searchFinding('gen-1 finding')])
    // Producer runs on the baseline (-1) and after gens 0 and 1, NOT the last
    // (gen 2 has no next propose()).
    expect(analyzed).toEqual([-1, 0, 1])
  })

  it("with generations=1, gen 0's propose() receives the baseline (gen -1) trace analysis", async () => {
    const seen: unknown[][] = []
    const proposer = {
      kind: 'recorder',
      async propose(ctx: ProposeContext) {
        seen.push(ctx.findings)
        return [{ surface: 'S-gen0', label: 'g0', rationale: 'r' }]
      },
    }
    const result = await runOptimization<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [passJudge],
      proposer,
      populationSize: 1,
      maxGenerations: 1,
      runDir,
      seed: 1,
      findings: [searchFinding('seed')],
      analyzeGeneration: async ({ generation, runDir: analyzedDir, candidates, history }) => {
        // The single propose() of the run is fed by a BASELINE analysis:
        // generation -1 (the baseline convention), the baseline runDir, no
        // history yet, and the baseline campaign as the sole candidate.
        expect(generation).toBe(-1)
        expect(analyzedDir).toBe(`${runDir}/baseline`)
        expect(history).toEqual([])
        expect(candidates).toHaveLength(1)
        expect(candidates[0]!.surfaceHash).toBe(surfaceHash('BASE'))
        // Marker derived from the baseline traces: the analyzed cells carry
        // the artifact the BASELINE surface dispatched.
        const artifacts = candidates[0]!.campaign.cells.map(
          (c) => (c.artifact as FakeArtifact).text,
        )
        expect(artifacts).toEqual(['BASE', 'BASE'])
        return [searchFinding('baseline finding', { from: artifacts.join(',') })]
      },
    })

    // Gen 0 proposed with the baseline analysis instead of the static seed.
    expect(seen).toEqual([[searchFinding('baseline finding', { from: 'BASE,BASE' })]])
    expect(result.generations).toHaveLength(1)
  })

  it('rejects optimization when the baseline produced no scored cells', async () => {
    const seen: unknown[][] = []
    const analyzed: number[] = []
    const proposer = {
      kind: 'recorder',
      async propose(ctx: ProposeContext) {
        seen.push(ctx.findings)
        return [{ surface: 'S-gen0', label: 'g0', rationale: 'r' }]
      },
    }
    await expect(
      runOptimization<FakeScenario, FakeArtifact>({
        scenarios: [],
        baselineSurface: 'BASE',
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [passJudge],
        proposer,
        populationSize: 1,
        maxGenerations: 1,
        runDir,
        seed: 1,
        findings: [searchFinding('seed')],
        analyzeGeneration: async ({ generation }) => {
          analyzed.push(generation)
          return [searchFinding('should not run')]
        },
      }),
    ).rejects.toThrow(/no complete cell-quality scores/)
    expect(analyzed).toEqual([])
    expect(seen).toEqual([])
  })

  it('without analyzeGeneration, findings stay the static seed every generation', async () => {
    const seen: unknown[][] = []
    const proposer = {
      kind: 'recorder',
      async propose(ctx: ProposeContext) {
        seen.push(ctx.findings)
        return [{ surface: `S-gen${ctx.generation}`, label: `g${ctx.generation}`, rationale: 'r' }]
      },
    }
    await runOptimization<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [passJudge],
      proposer,
      populationSize: 1,
      maxGenerations: 2,
      runDir,
      seed: 1,
      findings: [searchFinding('seed')],
    })
    expect(seen).toEqual([[searchFinding('seed')], [searchFinding('seed')]])
  })
})
