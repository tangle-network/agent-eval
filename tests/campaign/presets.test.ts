import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CodeSurface,
  composeGate,
  type DispatchFn,
  defaultProductionGate,
  evolutionaryDriver,
  FsLabeledScenarioStore,
  type Gate,
  heldOutGate,
  type MutableSurface,
  type Mutator,
  openAutoPr,
  runEval,
  runImprovementLoop,
  runOptimization,
  type Scenario,
  surfaceHash,
} from '../../src/campaign/index'

interface FakeScenario extends Scenario {
  id: string
  kind: string
  intent: string
}

interface FakeArtifact {
  text: string
}

const SCENARIOS: FakeScenario[] = [
  { id: 'a', kind: 'chat', intent: 'A' },
  { id: 'b', kind: 'chat', intent: 'B' },
]

const HOLDOUT: FakeScenario[] = [
  { id: 'h1', kind: 'chat', intent: 'H1' },
  { id: 'h2', kind: 'chat', intent: 'H2' },
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
          contributingGates: [{ name, passed: decision === 'ship', detail: {} }],
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
  const mk = (h1: number, h2: number): Scores =>
    new Map([
      ['h1:0', { judge: { composite: h1, dimensions: {}, notes: '' } }],
      ['h2:0', { judge: { composite: h2, dimensions: {}, notes: '' } }],
    ])
  const artifacts = new Map([
    ['h1:0', null],
    ['h2:0', null],
  ])

  it('ships when candidate beats baseline by >= deltaThreshold (separate score maps)', async () => {
    const gate = heldOutGate({ scenarios: HOLDOUT, deltaThreshold: 0.5 })
    const result = await gate.decide({
      candidateArtifacts: artifacts as never,
      baselineArtifacts: artifacts as never,
      judgeScores: mk(9, 8), // candidate mean 8.5
      baselineJudgeScores: mk(5, 4), // baseline mean 4.5 → delta 4.0
      scenarios: HOLDOUT,
      cost: { candidate: 0, baseline: 0 },
      signal: new AbortController().signal,
    })
    expect(result.delta).toBeCloseTo(4.0)
    expect(result.decision).toBe('ship')
  })

  it('holds when the candidate does not beat baseline', async () => {
    const gate = heldOutGate({ scenarios: HOLDOUT, deltaThreshold: 0.5 })
    const result = await gate.decide({
      candidateArtifacts: artifacts as never,
      baselineArtifacts: artifacts as never,
      judgeScores: mk(6, 6), // candidate 6
      baselineJudgeScores: mk(6, 6), // baseline 6 → delta 0 < 0.5
      scenarios: HOLDOUT,
      cost: { candidate: 0, baseline: 0 },
      signal: new AbortController().signal,
    })
    expect(result.delta).toBeCloseTo(0)
    expect(result.decision).toBe('hold')
  })
})

// ── openAutoPr ─────────────────────────────────────────────────────

describe('openAutoPr', () => {
  const baseGate = { decision: 'ship' as const, reasons: ['ok'], contributingGates: [] }
  const baseResult = {
    manifestHash: 'a'.repeat(64),
    seed: 42,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60_000,
    cells: [],
    aggregates: {
      byJudge: {},
      byScenario: {},
      totalCostUsd: 0,
      cellsExecuted: 0,
      cellsSkipped: 0,
      cellsCached: 0,
      cellsFailed: 0,
    },
    runDir: '/tmp/x',
    artifactsByPath: {},
    scenarios: [],
  }

  it('refuses to open PR when gate is not ship', () => {
    const result = openAutoPr({
      result: baseResult,
      gate: { ...baseGate, decision: 'hold' },
      promotedDiff: 'x',
      ghOwner: 'tangle-network',
      ghRepo: 'gtm-agent',
    })
    expect(result.opened).toBe(false)
    expect(result.reason).toContain('hold')
  })

  it('dry-runs when GH_AUTO_PR_TOKEN unset', () => {
    const prev = process.env.GH_AUTO_PR_TOKEN
    delete process.env.GH_AUTO_PR_TOKEN
    const result = openAutoPr({
      result: baseResult,
      gate: baseGate,
      promotedDiff: 'x',
      ghOwner: 'tangle-network',
      ghRepo: 'gtm-agent',
    })
    expect(result.dryRun).toBe(true)
    expect(result.opened).toBe(false)
    if (prev) process.env.GH_AUTO_PR_TOKEN = prev
  })

  it('shells out to gh when token is set + ghExec succeeds', () => {
    const ghExec = vi.fn(() => ({
      stdout: 'https://github.com/tangle-network/gtm-agent/pull/123\n',
      stderr: '',
      status: 0,
    }))
    const result = openAutoPr({
      result: baseResult,
      gate: baseGate,
      promotedDiff: 'x',
      ghOwner: 'tangle-network',
      ghRepo: 'gtm-agent',
      dryRun: false,
      ghExec,
    })
    expect(ghExec).toHaveBeenCalled()
    expect(result.opened).toBe(true)
    expect(result.prUrl).toMatch(/\/pull\/123/)
  })
})

// ── defaultProductionGate ──────────────────────────────────────────

describe('defaultProductionGate', () => {
  it('passes when delta is positive and no safety findings', async () => {
    const gate = defaultProductionGate<FakeArtifact, FakeScenario>({
      holdoutScenarios: HOLDOUT,
      deltaThreshold: 0.0,
    })
    const candidate = new Map<string, FakeArtifact>([
      ['h1:0', { text: 'normal' }],
      ['h2:0', { text: 'normal' }],
    ])
    const baseline = new Map<string, FakeArtifact>()
    const judgeScores = new Map<
      string,
      Record<string, { composite: number; dimensions: Record<string, number>; notes: string }>
    >([
      ['h1:0', { judge: { composite: 8, dimensions: {}, notes: '' } }],
      ['h2:0', { judge: { composite: 9, dimensions: {}, notes: '' } }],
    ])
    const result = await gate.decide({
      candidateArtifacts: candidate,
      baselineArtifacts: baseline,
      judgeScores,
      scenarios: HOLDOUT,
      cost: { candidate: 1, baseline: 1 },
      signal: new AbortController().signal,
    })
    expect(result.decision).toBe('ship')
    expect(result.contributingGates.length).toBeGreaterThanOrEqual(5) // heldout + budget + red-team + reward-hacking + canary
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
          payload: { category: 'pii-leak', forbiddenStrings: ['SECRET_TOKEN'] },
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
  const noopMutator: Mutator = {
    kind: 'noop',
    async mutate({ currentSurface, populationSize }) {
      return new Array(populationSize).fill(currentSurface)
    },
  }

  const baseOpts = {
    scenarios: SCENARIOS,
    holdoutScenarios: HOLDOUT,
    baselineSurface: 'You are helpful.',
    dispatchWithSurface: async (_s: string, sc: FakeScenario) => ({ text: sc.id }),
    driver: evolutionaryDriver({ mutator: noopMutator }),
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

  it('refuses Pass B autoOnPromote=config (deferred)', async () => {
    await expect(
      runImprovementLoop({
        ...baseOpts,
        autoOnPromote: 'config' as never,
        runDir,
      }),
    ).rejects.toThrow(/Pass B/)
  })
})

// ── runOptimization end-to-end ─────────────────────────────────────

describe('runOptimization', () => {
  it('runs baseline + N generations and returns a winner', async () => {
    const noopMutator: Mutator = {
      kind: 'append-letter',
      async mutate({ currentSurface, populationSize }) {
        return new Array(populationSize).fill(0).map((_, i) => `${currentSurface} +${i}`)
      },
    }
    const dispatchWithSurface = async (surface: string, s: FakeScenario) => ({
      text: `${surface}::${s.id}`,
    })

    const result = await runOptimization({
      scenarios: SCENARIOS,
      baselineSurface: 'base',
      dispatchWithSurface,
      driver: evolutionaryDriver({ mutator: noopMutator }),
      populationSize: 2,
      maxGenerations: 2,
      runDir,
    })

    expect(result.generations).toHaveLength(2)
    expect(result.generations[0]!.surfaces).toHaveLength(2)
    expect(result.winnerSurfaceHash).toMatch(/^[a-f0-9]{16}$/)
    expect(result.baselineCampaign.cells).toHaveLength(2)
  })

  it('drives via ANY ImprovementDriver, not just a mutator (analyst-style)', async () => {
    // A reflective driver that reasons over history instead of mutating —
    // proves the loop is driver-agnostic. This is the shape an analystDriver
    // (consumer-wired from runAnalystLoop) conforms to.
    const proposeCalls: number[] = []
    const reflectiveDriver = {
      kind: 'reflective:test',
      async propose({ currentSurface, history, generation, populationSize }) {
        proposeCalls.push(generation)
        // Reads history: append the prior best composite as a "finding".
        const priorBest = history.at(-1)?.candidates[0]?.composite ?? 0
        return new Array(populationSize)
          .fill(0)
          .map((_, i) => `${currentSurface} [gen${generation} prior=${priorBest} v${i}]`)
      },
    }

    const result = await runOptimization({
      scenarios: SCENARIOS,
      baselineSurface: 'base',
      dispatchWithSurface: async (surface: string, s: FakeScenario) => ({
        text: `${surface}::${s.id}`,
      }),
      driver: reflectiveDriver,
      populationSize: 2,
      maxGenerations: 3,
      runDir,
    })

    expect(proposeCalls).toEqual([0, 1, 2])
    expect(result.generations).toHaveLength(3)
    expect(result.winnerSurfaceHash).toMatch(/^[a-f0-9]{16}$/)
  })

  it('honors driver.decide() early-stop', async () => {
    let proposeCount = 0
    const stopAfterOneDriver = {
      kind: 'stop-after-one',
      async propose({ currentSurface, populationSize }) {
        proposeCount += 1
        return new Array(populationSize).fill(currentSurface)
      },
      decide({ history }: { history: unknown[] }) {
        // Stop once one generation has been recorded.
        return { stop: history.length >= 1, reason: 'converged' }
      },
    }

    const result = await runOptimization({
      scenarios: SCENARIOS,
      baselineSurface: 'base',
      dispatchWithSurface: async (surface: string, s: FakeScenario) => ({
        text: `${surface}::${s.id}`,
      }),
      driver: stopAfterOneDriver,
      populationSize: 1,
      maxGenerations: 10,
      runDir,
    })

    // decide() stops the loop after gen 0 records → only 1 generation runs.
    expect(proposeCount).toBe(1)
    expect(result.generations).toHaveLength(1)
  })

  it('forwards the widened ProposeContext (dataset, report, maxImprovementShots)', async () => {
    // Proves the loop hands a code-tier driver the data it needs to ground
    // proposals: the dataset handle, the Phase-2 report, and the depth knob.
    const seen: Array<{
      hasDataset: boolean
      report: unknown
      maxImprovementShots: number | undefined
    }> = []
    const contextSnoopDriver = {
      kind: 'snoop',
      async propose(ctx: {
        currentSurface: MutableSurface
        populationSize: number
        report?: unknown
        dataset?: unknown
        maxImprovementShots?: number
      }) {
        seen.push({
          hasDataset: ctx.dataset !== undefined,
          report: ctx.report,
          maxImprovementShots: ctx.maxImprovementShots,
        })
        return new Array(ctx.populationSize).fill(ctx.currentSurface)
      },
    }

    const store = new FsLabeledScenarioStore({ root: join(runDir, 'store') })
    await runOptimization({
      scenarios: SCENARIOS,
      baselineSurface: 'base',
      dispatchWithSurface: async (surface: string, s: FakeScenario) => ({
        text: `${surface}::${s.id}`,
      }),
      driver: contextSnoopDriver,
      populationSize: 1,
      maxGenerations: 1,
      labeledStore: store,
      captureSource: 'eval-run',
      report: { findings: ['rubric too lax'], diff: { regressions: 0 } },
      maxImprovementShots: 5,
      runDir,
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.hasDataset).toBe(true)
    expect(seen[0]!.report).toEqual({ findings: ['rubric too lax'], diff: { regressions: 0 } })
    expect(seen[0]!.maxImprovementShots).toBe(5)
  })
})

// ── MutableSurface tiers (string + CodeSurface) ────────────────────

describe('MutableSurface widening', () => {
  it('surfaceHash is content-stable for string surfaces', () => {
    expect(surfaceHash('hello')).toBe(surfaceHash('hello'))
    expect(surfaceHash('hello')).not.toBe(surfaceHash('world'))
  })

  it('surfaceHash distinguishes code surfaces by worktree + base ref', () => {
    const a: CodeSurface = { kind: 'code', worktreeRef: '/wt/a', baseRef: 'main' }
    const b: CodeSurface = { kind: 'code', worktreeRef: '/wt/b', baseRef: 'main' }
    const aAgain: CodeSurface = {
      kind: 'code',
      worktreeRef: '/wt/a',
      baseRef: 'main',
      summary: 'ignored in hash',
    }
    expect(surfaceHash(a)).toBe(surfaceHash(aAgain)) // summary not part of identity
    expect(surfaceHash(a)).not.toBe(surfaceHash(b))
    expect(surfaceHash(a)).toMatch(/^[a-f0-9]{16}$/)
  })

  it('drives an improvement loop over CodeSurface candidates (tier 4)', async () => {
    // A driver that proposes code surfaces (worktree refs), not prompts.
    // The dispatch checks out the worktree conceptually and runs the worker.
    const codeDriver = {
      kind: 'autoresearch:test',
      async propose({
        generation,
        populationSize,
      }: {
        generation: number
        populationSize: number
      }) {
        return new Array(populationSize).fill(0).map(
          (_, i): MutableSurface => ({
            kind: 'code',
            worktreeRef: `/wt/gen${generation}-cand${i}`,
            baseRef: 'main',
            summary: `candidate ${i}`,
          }),
        )
      },
    }
    const dispatchWithSurface = async (surface: MutableSurface, s: FakeScenario) => {
      const ref = typeof surface === 'string' ? surface : surface.worktreeRef
      return { text: `${ref}::${s.id}` }
    }

    const result = await runOptimization({
      scenarios: SCENARIOS,
      baselineSurface: { kind: 'code', worktreeRef: '/wt/main', baseRef: 'main' },
      dispatchWithSurface,
      driver: codeDriver,
      populationSize: 2,
      maxGenerations: 2,
      runDir,
    })

    expect(result.generations).toHaveLength(2)
    expect(result.winnerSurfaceHash).toMatch(/^[a-f0-9]{16}$/)
    // The winner surface is a CodeSurface, not a string.
    expect(typeof result.winnerSurface).toBe('object')
  })
})
