import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildLoopProvenanceRecord,
  type CodeSurface,
  composeGate,
  type DispatchFn,
  defaultProductionGate,
  emitLoopProvenance,
  evolutionaryDriver,
  FsLabeledScenarioStore,
  type Gate,
  gepaDriver,
  heldOutGate,
  inMemoryCampaignStorage,
  type JudgeConfig,
  loopProvenanceSpans,
  type MutableSurface,
  type Mutator,
  openAutoPr,
  type ProposeContext,
  runEval,
  runImprovementLoop,
  runOptimization,
  type Scenario,
  surfaceContentHash,
  surfaceHash,
} from '../../src/campaign/index'
import type { RunRecord } from '../../src/run-record'

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

// >=3 holdout scenarios so the rigorous gate's paired-bootstrap has the
// minProductiveRuns (3) it needs to ever clear zero — a real lift on only 2
// holdout cells is correctly held as too-few-runs.
const HOLDOUT: FakeScenario[] = [
  { id: 'h1', kind: 'chat', intent: 'H1' },
  { id: 'h2', kind: 'chat', intent: 'H2' },
  { id: 'h3', kind: 'chat', intent: 'H3' },
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

// ── gepaDriver end-to-end through runImprovementLoop + defaultProductionGate ─

describe('gepaDriver → runImprovementLoop → defaultProductionGate (full wiring)', () => {
  // The honesty gap (#101/#106): gepaDriver was only unit-tested in isolation
  // with a fake fetch returning canned payloads — never driven through the
  // whole loop to a measured held-out lift + a real gate promotion. This test
  // closes the WIRING half of that gap deterministically (the live-router
  // half lives in examples/substrate-lift-proof): a weak baseline scores 0,
  // gepaDriver's reflected candidate scores 1, the holdout re-score sees the
  // delta, and defaultProductionGate promotes. The regression it catches: any
  // refactor that collapses the candidate/baseline holdout maps (delta→0) or
  // drops the driver's proposal before the gate (winner == baseline).

  // The worker scores 1 iff the surface carries the schema directive the
  // driver is supposed to introduce; the weak baseline lacks it → scores 0.
  const SCHEMA_MARKER = 'OUTPUT_STRICT_SCHEMA'
  const judge: JudgeConfig<FakeArtifact, FakeScenario> = {
    name: 'has-schema',
    dimensions: [{ key: 'schema', description: 'surface enforces strict schema' }],
    score: ({ artifact }) => {
      const ok = artifact.text.includes(SCHEMA_MARKER) ? 1 : 0
      return { dimensions: { schema: ok }, composite: ok, notes: '' }
    },
  }

  // Fake router for the driver's reflection: returns one candidate surface
  // that contains the marker. This is the LLM's job in the live proof —
  // here it is stubbed so the wiring is deterministic + offline.
  function driverFetch(): typeof fetch {
    return (async () => {
      const proposals = [
        { label: 'fix', rationale: 'add schema directive', payload: `BASE ${SCHEMA_MARKER}` },
      ]
      const content = JSON.stringify({ proposals })
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
  }

  it('promotes a real driver-proposed lift on the held-out split', async () => {
    const driver = gepaDriver({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: driverFetch() },
      model: 'test-model',
      target: 'enforce a strict output schema',
    })

    const result = await runImprovementLoop<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      holdoutScenarios: HOLDOUT,
      baselineSurface: 'BASE',
      // The worker echoes the surface it was given — the judge keys on the marker.
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      driver,
      populationSize: 1,
      maxGenerations: 1,
      promoteTopK: 1,
      gate: defaultProductionGate<FakeArtifact, FakeScenario>({
        holdoutScenarios: HOLDOUT,
        deltaThreshold: 0.5,
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
    // The promoted surface is the driver's proposal, NOT the baseline.
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
    const driver = gepaDriver({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: driverFetch() },
      model: 'test-model',
      target: 'enforce a strict output schema',
    })
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
        driver,
        populationSize: 1,
        maxGenerations: 1,
        promoteTopK: 1,
        gate: defaultProductionGate<FakeArtifact, FakeScenario>({
          holdoutScenarios: HOLDOUT,
          deltaThreshold: 0.5,
        }),
        autoOnPromote: 'none',
        runDir: mkdtempSync(join(tmpdir(), 'holdout-fail-loud-')),
        seed: 7,
      }),
    ).rejects.toThrow(/holdout produced no scorable cells/)
  })

  it('holds when the driver proposes no improvement (winner == baseline)', async () => {
    // Driver returns only the parent surface → deduped to empty → winner stays
    // baseline → holdout delta 0 → gate holds. Guards the "nothing to ship" path.
    const noopFetch = (async () => {
      const content = JSON.stringify({
        proposals: [{ label: 'x', rationale: 'r', payload: 'BASE' }],
      })
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const result = await runImprovementLoop<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      holdoutScenarios: HOLDOUT,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      driver: gepaDriver({
        llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: noopFetch },
        model: 'test-model',
        target: 'enforce a strict output schema',
      }),
      populationSize: 1,
      maxGenerations: 1,
      gate: defaultProductionGate<FakeArtifact, FakeScenario>({
        holdoutScenarios: HOLDOUT,
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

describe('loop provenance emission (transaction-extraction shape, offline)', () => {
  // This is the deterministic, offline twin of examples/substrate-lift-proof:
  // a weak baseline ('Extract the transaction info.') scores 0, gepaDriver's
  // reflected candidate carries the schema marker and scores 1, the holdout
  // re-score sees the +1 lift, defaultProductionGate ships. It then asserts
  // the FULL provenance chain the audit + ADC require is emitted + durable:
  //   1. the winner carries its rationale ("because Z" survives),
  //   2. real content-hashes distinguish baseline from winner (byte-verifiable),
  //   3. the explicit baseline→candidate diff is present,
  //   4. the structured provenance record + OTel spans are emitted,
  //   5. backend provenance (verdict + worker call count + model) is captured,
  //   6. the held-out lift RECOMPUTES from the emitted record (not the live return).
  // The regression each guards: gepa.ts dropping label+rationale; the
  // 'sha256:cell' stub hashes; the diff being PR-only; cost-only spans; the
  // provenance record being non-durable.
  const SCHEMA_MARKER = 'OUTPUT_STRICT_SCHEMA'
  const RATIONALE = 'baseline omits the field schema; pin keys + ISO date'
  const LABEL = 'pin-strict-schema'

  const judge: JudgeConfig<FakeArtifact, FakeScenario> = {
    name: 'has-schema',
    dimensions: [{ key: 'schema', description: 'surface enforces strict schema' }],
    score: ({ artifact }) => {
      const ok = artifact.text.includes(SCHEMA_MARKER) ? 1 : 0
      return { dimensions: { schema: ok }, composite: ok, notes: '' }
    },
  }

  function driverFetch(): typeof fetch {
    return (async () => {
      const proposals = [{ label: LABEL, rationale: RATIONALE, payload: `BASE ${SCHEMA_MARKER}` }]
      const content = JSON.stringify({ proposals })
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
  }

  // Real-shaped worker records (nonzero tokens) so the backend verdict reads
  // 'real' — the honest provenance an actual router run would carry.
  function workerRecords(): RunRecord[] {
    return [
      {
        runId: 'wr-1',
        experimentId: 'prov-test',
        candidateId: 'winner',
        seed: 7,
        model: 'anthropic/claude-haiku-4-5@2025-01-01',
        promptHash: 'sha256:x',
        configHash: 'sha256:y',
        commitSha: 'local',
        wallMs: 10,
        costUsd: 0.001,
        tokenUsage: { input: 120, output: 40 },
        outcome: { holdoutScore: 1, raw: {} },
        splitTag: 'holdout',
      },
    ]
  }

  it('emits the full chain + the +lift recomputes from the emitted record', async () => {
    const driver = gepaDriver({
      llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: driverFetch() },
      model: 'test-model',
      target: 'enforce a strict output schema',
    })

    const result = await runImprovementLoop<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      holdoutScenarios: HOLDOUT,
      baselineSurface: 'BASE',
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [judge],
      driver,
      populationSize: 1,
      maxGenerations: 1,
      promoteTopK: 1,
      gate: defaultProductionGate<FakeArtifact, FakeScenario>({
        holdoutScenarios: HOLDOUT,
        deltaThreshold: 0.5,
      }),
      autoOnPromote: 'none',
      runDir,
      seed: 7,
    })

    // (1) The rationale survived gepa.ts → GenerationCandidate → result.winner*.
    expect(result.winnerRationale).toBe(RATIONALE)
    expect(result.winnerLabel).toBe(LABEL)
    const winnerCandidate = result.generations[0]!.record.candidates[0]!
    expect(winnerCandidate.rationale).toBe(RATIONALE)
    expect(winnerCandidate.label).toBe(LABEL)

    // (3) The diff is present UNCONDITIONALLY (autoOnPromote === 'none').
    expect(result.promotedDiff).toContain(SCHEMA_MARKER)
    expect(result.promotedDiff).toContain('--- baseline')

    // Emit the durable record + spans through in-memory storage.
    const storage = inMemoryCampaignStorage()
    const liveDelta = 1 // winner 1 - baseline 0 on holdout
    const { record, spans, recordPath, spansPath } = await emitLoopProvenance<
      FakeArtifact,
      FakeScenario
    >({
      runId: 'prov-test#1',
      runDir,
      timestamp: '2026-05-30T00:00:00.000Z',
      baselineSurface: 'BASE',
      winnerSurface: result.winnerSurface,
      winnerLabel: result.winnerLabel,
      winnerRationale: result.winnerRationale,
      diff: result.promotedDiff,
      generations: result.generations.map((g) => ({
        generationIndex: g.record.generationIndex,
        candidates: g.record.candidates,
        promoted: g.record.promoted,
        surfaces: g.surfaces.map((s) => ({ surfaceHash: s.surfaceHash, surface: s.surface })),
      })),
      gate: result.gateResult,
      baselineOnHoldout: result.baselineOnHoldout,
      winnerOnHoldout: result.winnerOnHoldout,
      workerRecords: workerRecords(),
      totalCostUsd: 0.001,
      totalDurationMs: 1234,
      storage,
    })

    // (1) rationale in the record.
    expect(record.winnerRationale).toBe(RATIONALE)
    expect(record.candidates.some((c) => c.rationale === RATIONALE && c.label === LABEL)).toBe(true)

    // (2) real content hashes distinguish baseline from winner + verify bytes.
    expect(record.baselineContentHash).toBe(surfaceContentHash('BASE'))
    expect(record.winnerContentHash).toBe(surfaceContentHash(result.winnerSurface))
    expect(record.baselineContentHash).not.toBe(record.winnerContentHash)
    expect(record.baselineContentHash).toMatch(/^sha256:[a-f0-9]{64}$/)

    // (3) diff carried on the record.
    expect(record.diff).toContain(SCHEMA_MARKER)

    // (4) the structured record + OTel spans are DURABLE (written to storage).
    expect(storage.read(recordPath)).toBeDefined()
    expect(JSON.parse(storage.read(recordPath)!).schema).toBe('tangle.loop-provenance.v1')
    const spanLines = storage.read(spansPath)!.split('\n')
    expect(spanLines.length).toBe(spans.length)
    // Spans pivot on the OTLP-ingestable tangle.* attributes the otel adapter reads.
    const root = spans.find((s) => s.name === 'improvement-loop')!
    expect(root['tangle.runId']).toBe('prov-test#1')
    const candidateSpan = spans.find((s) => s.name.startsWith('candidate-'))!
    expect(candidateSpan.attributes['tangle.candidateRationale']).toBe(RATIONALE)
    expect(candidateSpan.attributes['tangle.candidateLabel']).toBe(LABEL)
    expect(candidateSpan['tangle.generation']).toBe(0)
    const gateSpan = spans.find((s) => s.name === 'gate-decision')!
    expect(gateSpan.attributes['tangle.gateDecision']).toBe('ship')

    // (5) backend provenance captured (verdict + worker call count + model).
    expect(record.backend.verdict).toBe('real')
    expect(record.backend.workerCallCount).toBe(1)
    expect(record.backend.models).toEqual(['anthropic/claude-haiku-4-5@2025-01-01'])
    expect(record.backend.totalOutputTokens).toBe(40)

    // (6) the +lift RECOMPUTES from the emitted record — re-parse the durable
    // JSON and re-derive winnerHoldout - baselineHoldout, never reading the
    // in-memory return. This is the audit's "re-derivable from cells" check.
    const reparsed = JSON.parse(storage.read(recordPath)!) as typeof record
    const recomputed = reparsed.winnerHoldoutComposite - reparsed.baselineHoldoutComposite
    expect(recomputed).toBeCloseTo(liveDelta, 9)
    expect(reparsed.heldOutLift).toBeCloseTo(liveDelta, 9)
    expect(reparsed.gate.delta).toBeCloseTo(liveDelta, 9)
  })

  it('buildLoopProvenanceRecord falls back to a stub verdict when no token channel is wired', () => {
    // The honest fallback: derive backend provenance from cost-only cells (no
    // token usage) → verdict reads 'stub', the explicit signal that no worker
    // token channel reached the record. NOT a silent 'real'.
    const record = buildLoopProvenanceRecord<FakeArtifact, FakeScenario>({
      runId: 'r',
      runDir,
      timestamp: '2026-05-30T00:00:00.000Z',
      baselineSurface: 'BASE',
      winnerSurface: 'BASE',
      diff: '',
      generations: [],
      gate: { decision: 'hold', reasons: [], contributingGates: [] },
      baselineOnHoldout: { cells: [] } as never,
      winnerOnHoldout: { cells: [] } as never,
      workerRecords: [
        {
          runId: 'c',
          experimentId: 'e',
          candidateId: 'winner',
          seed: 1,
          model: 'campaign-cell',
          promptHash: 'sha256:p',
          configHash: 'sha256:c',
          commitSha: 'cell',
          wallMs: 1,
          costUsd: 0,
          tokenUsage: { input: 0, output: 0 },
          outcome: { holdoutScore: 0, raw: {} },
          splitTag: 'holdout',
        },
      ],
      totalCostUsd: 0,
      totalDurationMs: 1,
    })
    expect(record.backend.verdict).toBe('stub')
    // winner == baseline ⇒ identical content hashes (the no-op-loop signature).
    expect(record.baselineContentHash).toBe(record.winnerContentHash)
  })

  it('loopProvenanceSpans builds a parent-linked tree (root → gen → candidate, root → gate)', () => {
    const record = buildLoopProvenanceRecord<FakeArtifact, FakeScenario>({
      runId: 'tree',
      runDir,
      timestamp: '2026-05-30T00:00:00.000Z',
      baselineSurface: 'BASE',
      winnerSurface: 'BASE NEW',
      winnerRationale: 'r',
      diff: '--- baseline\n+++ winner',
      generations: [
        {
          generationIndex: 0,
          candidates: [{ surfaceHash: 'abc', composite: 1, label: 'l', rationale: 'r' }],
          promoted: ['abc'],
          surfaces: [{ surfaceHash: 'abc', surface: 'BASE NEW' }],
        },
      ],
      gate: { decision: 'ship', reasons: ['ok'], delta: 1, contributingGates: [] },
      baselineOnHoldout: { cells: [] } as never,
      winnerOnHoldout: { cells: [] } as never,
      workerRecords: [],
      totalCostUsd: 0,
      totalDurationMs: 1,
    })
    const spans = loopProvenanceSpans(record)
    const root = spans.find((s) => s.name === 'improvement-loop')!
    const gen = spans.find((s) => s.name === 'generation-0')!
    const cand = spans.find((s) => s.name === 'candidate-abc')!
    const gate = spans.find((s) => s.name === 'gate-decision')!
    expect(gen.parentSpanId).toBe(root.spanId)
    expect(cand.parentSpanId).toBe(gen.spanId)
    expect(gate.parentSpanId).toBe(root.spanId)
    // All share one trace.
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1)
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
      ['h3:0', { text: 'normal' }],
    ])
    const baseline = new Map<string, FakeArtifact>([
      ['h1:0', { text: 'normal' }],
      ['h2:0', { text: 'normal' }],
      ['h3:0', { text: 'normal' }],
    ])
    const mk = (entries: Array<[string, number]>) =>
      new Map<
        string,
        Record<string, { composite: number; dimensions: Record<string, number>; notes: string }>
      >(entries.map(([c, v]) => [c, { judge: { composite: v, dimensions: {}, notes: '' } }]))
    // A real, uniform +3 lift on 3 holdout cells ⇒ CI.low > 0 ⇒ ship.
    const judgeScores = mk([
      ['h1:0', 8],
      ['h2:0', 9],
      ['h3:0', 7],
    ])
    const baselineJudgeScores = mk([
      ['h1:0', 5],
      ['h2:0', 6],
      ['h3:0', 4],
    ])
    const result = await gate.decide({
      candidateArtifacts: candidate,
      baselineArtifacts: baseline,
      judgeScores,
      baselineJudgeScores,
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
  it('fails closed on a missing runDir before writing under ./undefined', async () => {
    const spillDir = join(process.cwd(), 'undefined')
    rmSync(spillDir, { recursive: true, force: true })
    const noopMutator: Mutator = {
      kind: 'noop',
      async mutate({ currentSurface }) {
        return [currentSurface]
      },
    }

    try {
      await expect(
        runOptimization({
          scenarios: SCENARIOS.slice(0, 1),
          baselineSurface: 'base',
          dispatchWithSurface: async (surface: string, s: FakeScenario) => ({
            text: `${surface}::${s.id}`,
          }),
          driver: evolutionaryDriver({ mutator: noopMutator }),
          populationSize: 1,
          maxGenerations: 1,
          runDir: undefined as unknown as string,
        }),
      ).rejects.toThrow(/runDir is required/)
      expect(existsSync(spillDir)).toBe(false)
    } finally {
      rmSync(spillDir, { recursive: true, force: true })
    }
  })

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

  it('records per-candidate dimensional + per-scenario scores (reflective-driver evidence)', async () => {
    // The reflective driver needs to see WHICH dimensions a candidate is weak
    // on and WHICH scenarios it best/worst handled — not just one composite.
    const judge: JudgeConfig<FakeArtifact, FakeScenario> = {
      name: 'dim-judge',
      dimensions: [
        { key: 'clarity', description: 'c' },
        { key: 'safety', description: 's' },
      ],
      score: ({ scenario }) => ({
        composite: scenario.id === 'a' ? 0.8 : 0.4,
        dimensions: { clarity: scenario.id === 'a' ? 0.9 : 0.3, safety: 0.5 },
        notes: '',
      }),
    }
    const noopMutator: Mutator = {
      kind: 'noop',
      async mutate({ currentSurface, populationSize }) {
        return new Array(populationSize).fill(0).map((_, i) => `${currentSurface}+${i}`)
      },
    }
    const result = await runOptimization({
      scenarios: SCENARIOS,
      baselineSurface: 'base',
      dispatchWithSurface: async (surface: string, s: FakeScenario) => ({
        text: `${surface}::${s.id}`,
      }),
      judges: [judge],
      driver: evolutionaryDriver({ mutator: noopMutator }),
      populationSize: 2,
      maxGenerations: 1,
      runDir,
    })

    const cand = result.generations[0]!.record.candidates[0]!
    expect(Object.keys(cand.dimensions).sort()).toEqual(['clarity', 'safety'])
    expect(cand.dimensions.safety).toBeCloseTo(0.5, 5)
    // clarity mean across scenarios a(0.9) + b(0.3) = 0.6
    expect(cand.dimensions.clarity).toBeCloseTo(0.6, 5)
    expect(cand.scenarios.map((x) => x.scenarioId).sort()).toEqual(['a', 'b'])
    const sa = cand.scenarios.find((x) => x.scenarioId === 'a')!
    const sb = cand.scenarios.find((x) => x.scenarioId === 'b')!
    expect(sa.composite).toBeGreaterThan(sb.composite)
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
    const probeDriver = {
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
      driver: probeDriver,
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

  it('keeps a candidate missing a scenario score via the finite floor (not dropped)', async () => {
    // The judge is "unavailable" for (X, scenario b) → X's campaign cell b errors
    // → X.objectives omits 'b'. computeParetoFrontier must rank X worst on 'b'
    // via a FINITE floor, NOT -Infinity (which the canonical paretoFrontier would
    // exclude entirely, silently dropping X). Regression guard for that floor.
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
      driver: {
        kind: 'pareto-probe',
        async propose(ctx: { generation: number }): Promise<MutableSurface[]> {
          return ctx.generation === 0 ? ['X', 'Y'] : []
        },
      },
      populationSize: 2,
      maxGenerations: 1,
      runDir,
    })

    const xParent = result.paretoFrontier.find((p) => p.surfaceHash === surfaceHash('X'))
    // X scored only scenario 'a' (b errored) — but it is STILL on the frontier
    // (uniquely best on 'a'), not silently dropped for the missing axis.
    expect(xParent).toBeDefined()
    expect(Object.keys(xParent!.objectives)).toEqual(['a'])
    expect(xParent!.objectives.a).toBeCloseTo(0.9, 5)
    expect(result.paretoFrontier.some((p) => p.surfaceHash === surfaceHash('Y'))).toBe(true)
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

// ── emitLoopProvenance ships BOTH eval-run + traces to a hosted client ──────

describe('emitLoopProvenance — hosted ingest (eval-run + traces)', () => {
  function mkHoldout(composite: number) {
    return {
      cells: [
        {
          cellId: 'h1:0',
          scenarioId: 'h1',
          rep: 0,
          artifact: {},
          judgeScores: { j: { composite, dimensions: { q: composite }, notes: '' } },
          costUsd: 0.01,
          tokenUsage: { input: 10, output: 5 },
          durationMs: 5,
          seed: 1,
          cached: false,
        },
      ],
      aggregates: { totalCostUsd: 0.01 },
      durationMs: 5,
    } as never
  }

  it('ships an eval-run event (run list) AND trace spans (drill-down)', async () => {
    const evalRuns: unknown[] = []
    const traceBatches: unknown[][] = []
    const mockClient = {
      tenant: { endpoint: 'https://x/v1', apiKey: 'k', tenantId: 't' },
      wireVersion: '2026-05-26.v1' as const,
      async ingestEvalRun(event: unknown) {
        evalRuns.push(event)
        return { accepted: 1, rejected: [] }
      },
      async ingestEvalRuns(events: unknown[]) {
        evalRuns.push(...events)
        return { accepted: events.length, rejected: [] }
      },
      async ingestTraces(spans: unknown[]) {
        traceBatches.push(spans)
        return { accepted: spans.length, rejected: [] }
      },
    }

    const { record } = await emitLoopProvenance<FakeArtifact, FakeScenario>({
      runId: 'hosted-ship#1',
      runDir,
      timestamp: '2026-05-30T00:00:00.000Z',
      baselineSurface: 'BASE',
      winnerSurface: 'BASE BETTER',
      winnerLabel: 'fix',
      winnerRationale: 'because',
      diff: '--- baseline\n+++ winner',
      generations: [
        {
          generationIndex: 0,
          candidates: [{ surfaceHash: 'h', composite: 1, label: 'fix', rationale: 'because' }],
          promoted: ['h'],
          surfaces: [{ surfaceHash: 'h', surface: 'BASE BETTER' }],
        },
      ],
      gate: { decision: 'ship', reasons: ['ok'], delta: 0.5, contributingGates: [] },
      baselineOnHoldout: mkHoldout(0.5),
      winnerOnHoldout: mkHoldout(1.0),
      workerRecords: [],
      totalCostUsd: 0.02,
      totalDurationMs: 10,
      storage: inMemoryCampaignStorage(),
      hostedClient: mockClient,
    })

    // Eval-run event shipped, with the run-list-shaping fields populated.
    expect(evalRuns).toHaveLength(1)
    const ev = evalRuns[0] as {
      runId: string
      status: string
      gateDecision: string
      holdoutLift: number
      baseline: { compositeMean: number }
      generations: Array<{ compositeMean: number }>
    }
    expect(ev.runId).toBe('hosted-ship#1')
    expect(ev.status).toBe('finished')
    expect(ev.gateDecision).toBe('ship')
    expect(ev.baseline.compositeMean).toBeCloseTo(0.5, 5)
    expect(ev.generations[0]!.compositeMean).toBeCloseTo(1.0, 5)
    expect(ev.holdoutLift).toBeCloseTo(0.5, 5) // matches the record
    expect(ev.holdoutLift).toBeCloseTo(record.heldOutLift, 9)
    // Trace spans shipped too (the per-candidate drill-down).
    expect(traceBatches).toHaveLength(1)
    expect(traceBatches[0]!.length).toBeGreaterThan(0)
  })
})

describe('runImprovementLoop — no-op guard (empty-diff false-ship killer)', () => {
  // Regression for the observed production false positive: the gepaDriver's
  // candidate did NOT beat the training baseline, so the winner stayed the
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
  // Driver proposes a STRICTLY WEAKER candidate (no marker → scores 0 < baseline 1).
  const weakerProposalFetch = (async () => {
    const content = JSON.stringify({
      proposals: [{ label: 'weaker', rationale: 'r', payload: 'WEAKER_CANDIDATE' }],
    })
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  it('HOLDS when no candidate beats the baseline, even with a near-zero delta threshold', async () => {
    const result = await runImprovementLoop<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      holdoutScenarios: HOLDOUT,
      baselineSurface: STRONG,
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [prefersBaseline],
      driver: gepaDriver({
        llm: { apiKey: 'k', baseUrl: 'https://router.test/v1', fetch: weakerProposalFetch },
        model: 'm',
        target: 't',
      }),
      populationSize: 1,
      maxGenerations: 1,
      promoteTopK: 1,
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
    expect(result.gateResult.reasons.join(' ')).toMatch(/winner == baseline/)
    expect(result.promotedDiff).toBe('')
    // The winner surface is byte-identical to the baseline.
    expect(String(result.winnerSurface)).toBe(STRONG)
  })
})

// ── runOptimization: analyzeGeneration loop closure (EYES→HANDS) ──────
describe('runOptimization — analyzeGeneration feeds findings forward', () => {
  const passJudge: JudgeConfig<FakeArtifact, FakeScenario> = {
    name: 'noop',
    dimensions: [{ key: 'ok', description: 'always 1 — isolates the findings wire' }],
    score: () => ({ dimensions: { ok: 1 }, composite: 1, notes: '' }),
  }

  it("re-diagnoses each generation and feeds the fresh findings into the NEXT generation's propose()", async () => {
    const seen: unknown[][] = []
    // A recorder driver: captures ctx.findings each generation, returns a
    // distinct candidate so the loop advances.
    const driver = {
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
      driver,
      populationSize: 1,
      maxGenerations: 3,
      promoteTopK: 1,
      runDir,
      seed: 1,
      findings: [{ claim: 'seed' }],
      analyzeGeneration: async ({ generation, candidates }) => {
        // The producer sees this generation's scored candidates (real wire:
        // it would read their traces). Return a finding keyed by generation.
        expect(candidates.length).toBe(1)
        analyzed.push(generation)
        return [{ claim: `gen-${generation} finding` }]
      },
    })

    expect(seen).toHaveLength(3)
    // Gen 0 sees the static seed; gen 1 sees gen-0's produced finding; gen 2 gen-1's.
    expect(seen[0]).toEqual([{ claim: 'seed' }])
    expect(seen[1]).toEqual([{ claim: 'gen-0 finding' }])
    expect(seen[2]).toEqual([{ claim: 'gen-1 finding' }])
    // Producer runs after gens 0 and 1, NOT the last (gen 2 has no next propose()).
    expect(analyzed).toEqual([0, 1])
  })

  it('without analyzeGeneration, findings stay the static seed every generation', async () => {
    const seen: unknown[][] = []
    const driver = {
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
      driver,
      populationSize: 1,
      maxGenerations: 2,
      promoteTopK: 1,
      runDir,
      seed: 1,
      findings: [{ claim: 'seed' }],
    })
    expect(seen).toEqual([[{ claim: 'seed' }], [{ claim: 'seed' }]])
  })
})
