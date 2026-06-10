import { describe, expect, it } from 'vitest'
import type { CounterfactualMutation, CounterfactualRunner } from '../src/counterfactual'
import {
  causalSweep,
  DIAGNOSE_ANALYST_ID,
  describeMutation,
  prescribeRepair,
  suggestInvariant,
  toAnalystFindings,
  toCorpusRecord,
  type ValidatedRepair,
} from '../src/diagnose'
import type { RunRecord } from '../src/run-record'
import type { ToolSpan } from '../src/trace'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function seedRun(
  store: InMemoryTraceStore,
  outputScore: number,
  shape: Array<{ kind: 'llm' | 'tool'; name: string; model?: string; toolName?: string }>,
): Promise<string> {
  const e = new TraceEmitter(store)
  await e.startRun({ scenarioId: 's' })
  for (const s of shape) {
    if (s.kind === 'llm') {
      const h = await e.span({
        kind: 'llm',
        name: s.name,
        model: s.model ?? 'm',
        messages: [],
        output: 'x',
      })
      await h.end()
    } else {
      const h = await e.span({
        kind: 'tool',
        name: s.name,
        toolName: s.toolName ?? s.name,
        args: {},
      })
      await h.end({ result: 'rate=WRONG' } as Partial<ToolSpan>)
    }
  }
  await e.endRun({ pass: false, score: outputScore })
  return e.runId
}

const SHAPE = [
  { kind: 'llm' as const, name: 'plan' },
  { kind: 'tool' as const, name: 'fetch-rates' },
  { kind: 'tool' as const, name: 'format' },
  { kind: 'llm' as const, name: 'answer' },
]

/**
 * Deterministic fake of the execution seam (same pattern as the
 * runCounterfactual tests in tier2.test.ts): knocking out the faulty
 * fetch-rates step (index 1) flips the run to ~0.8; every other
 * intervention reproduces the original ~0.2 plus seeded noise.
 */
function makeRunner(opts: { seed: number; scoreFor?: (m: CounterfactualMutation) => number }): {
  runner: CounterfactualRunner
  calls: CounterfactualMutation[]
} {
  const rng = mulberry32(opts.seed)
  const calls: CounterfactualMutation[] = []
  const runner: CounterfactualRunner = {
    async executeFrom(ctx, emitter) {
      calls.push(ctx.mutation)
      // Symmetric two-draw noise so per-rep deltas straddle the mean.
      const noise = (rng() - 0.5) * 0.02 + (rng() - 0.5) * 0.02
      const base =
        opts.scoreFor?.(ctx.mutation) ??
        (ctx.mutation.kind === 'swap-tool-result' && ctx.mutation.at === 1 ? 0.8 : 0.2)
      await emitter.endRun({ pass: base >= 0.5, score: base + noise })
    },
  }
  return { runner, calls }
}

describe('causalSweep', () => {
  it('ranks the injected-fault step #1 with CI excluding zero; no-effect step CI includes zero', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedRun(store, 0.2, SHAPE)
    const { runner } = makeRunner({ seed: 42 })

    const report = await causalSweep({
      store,
      runId,
      runner,
      candidateSteps: [1, 2],
      reps: 5,
      budget: 100,
      ciSeed: 7,
    })

    expect(report.steps).toHaveLength(2)
    const [top, rest] = report.steps
    expect(top!.stepRef.index).toBe(1)
    expect(top!.stepRef.name).toBe('fetch-rates')
    expect(top!.mutationKind).toBe('swap-tool-result')
    expect(top!.meanEffect).toBeGreaterThan(0.5)
    expect(top!.ciExcludesZero).toBe(true)
    expect(top!.ci.lower).toBeGreaterThan(0)
    expect(top!.deltas).toHaveLength(5)

    expect(rest!.stepRef.index).toBe(2)
    expect(rest!.ciExcludesZero).toBe(false)
    expect(rest!.ci.lower).toBeLessThanOrEqual(0)
    expect(rest!.ci.upper).toBeGreaterThanOrEqual(0)

    expect(report.replaysUsed).toBe(10)
    expect(report.uncovered).toHaveLength(0)
    expect(report.originalScore).toBeCloseTo(0.2)
    expect(report.byMutationKind[0]!.mutationKind).toBe('swap-tool-result')
    expect(report.byMutationKind[0]!.n).toBe(10)
  })

  it('records counterfactual replays as meta runs parented to the original', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedRun(store, 0.2, SHAPE)
    const { runner } = makeRunner({ seed: 1 })
    const report = await causalSweep({
      store,
      runId,
      runner,
      candidateSteps: [1],
      reps: 2,
      budget: 10,
    })
    const cfRun = await store.getRun(report.steps[0]!.counterfactualRunIds[0]!)
    expect(cfRun?.parentRunId).toBe(runId)
    expect(cfRun?.layer).toBe('meta')
  })

  it('names uncovered steps under a tight budget instead of silently dropping them', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedRun(store, 0.2, SHAPE)
    const { runner } = makeRunner({ seed: 9 })

    const report = await causalSweep({
      store,
      runId,
      runner,
      candidateSteps: [1, 2],
      reps: 4,
      budget: 6,
    })

    expect(report.steps).toHaveLength(1)
    expect(report.steps[0]!.stepRef.index).toBe(1)
    expect(report.replaysUsed).toBe(4)
    expect(report.uncovered).toHaveLength(1)
    expect(report.uncovered[0]!.index).toBe(2)
    expect(report.uncovered[0]!.name).toBe('format')
  })

  it('covers nothing when budget < reps — everything uncovered, zero replays', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedRun(store, 0.2, SHAPE)
    const { runner, calls } = makeRunner({ seed: 9 })
    const report = await causalSweep({
      store,
      runId,
      runner,
      candidateSteps: [1, 2],
      reps: 4,
      budget: 3,
    })
    expect(report.steps).toHaveLength(0)
    expect(report.replaysUsed).toBe(0)
    expect(calls).toHaveLength(0)
    expect(report.uncovered.map((s) => s.index)).toEqual([1, 2])
  })

  it('defaults candidate steps to llm + tool spans with the payload-free probe kinds', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedRun(store, 0.2, SHAPE)
    const { runner, calls } = makeRunner({ seed: 3 })
    await causalSweep({ store, runId, runner, reps: 2, budget: 100 })
    // 4 steps × 1 default mutation × 2 reps
    expect(calls).toHaveLength(8)
    const kinds = new Set(calls.map((c) => c.kind))
    expect(kinds).toEqual(new Set(['truncate-after', 'swap-tool-result']))
  })

  it('rejects reps < 2 — a single intervention delta is noise, not measurement', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedRun(store, 0.2, SHAPE)
    const { runner } = makeRunner({ seed: 3 })
    await expect(causalSweep({ store, runId, runner, reps: 1, budget: 10 })).rejects.toThrow(
      /reps must be an integer >= 2/,
    )
  })

  it('fails loud when the original run has no numeric score', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.endRun({ pass: false })
    const { runner } = makeRunner({ seed: 3 })
    await expect(
      causalSweep({ store, runId: e.runId, runner, reps: 2, budget: 10 }),
    ).rejects.toThrow(/no numeric outcome\.score/)
  })

  it('fails loud when a replay omits the score instead of recording a bogus delta', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedRun(store, 0.2, SHAPE)
    const runner: CounterfactualRunner = {
      async executeFrom(_ctx, emitter) {
        await emitter.endRun({ pass: true })
      },
    }
    await expect(
      causalSweep({ store, runId, runner, candidateSteps: [1], reps: 2, budget: 10 }),
    ).rejects.toThrow(/runner must endRun with a numeric outcome\.score/)
  })
})

describe('prescribeRepair', () => {
  async function diagnosedSetup() {
    const store = new InMemoryTraceStore()
    const runId = await seedRun(store, 0.2, SHAPE)
    const { runner } = makeRunner({ seed: 42 })
    const report = await causalSweep({
      store,
      runId,
      runner,
      candidateSteps: [1, 2],
      reps: 5,
      budget: 100,
      ciSeed: 7,
    })
    return { store, runId, report }
  }

  const goodFix: CounterfactualMutation = {
    kind: 'swap-tool-result',
    at: 1,
    newResult: { rate: 4.5 },
  }
  const badFix: CounterfactualMutation = { kind: 'swap-tool-result', at: 1, newResult: 'garbage' }

  it('emits only flipping mutations; non-flippers land in rejected with reason', async () => {
    const { store, runId, report } = await diagnosedSetup()
    const { runner } = makeRunner({
      seed: 11,
      scoreFor: (m) =>
        m.kind === 'swap-tool-result' &&
        JSON.stringify(m.newResult) === JSON.stringify(goodFix.newResult)
          ? 0.9
          : 0.3,
    })

    const repair = await prescribeRepair({
      store,
      runId,
      runner,
      blamed: report.steps.slice(0, 1),
      proposeFix: async () => [badFix, goodFix],
      flipThreshold: 0.5,
      repsToValidate: 3,
    })

    expect(repair.repairs).toHaveLength(1)
    const validated = repair.repairs[0]!
    expect(validated.validated).toBe(true)
    expect(validated.mutation).toEqual(goodFix)
    expect(validated.stepRef.index).toBe(1)
    expect(validated.meanScore).toBeGreaterThanOrEqual(0.5)
    expect(validated.deltaScore).toBeCloseTo(validated.meanScore - 0.2, 10)
    expect(validated.reps).toBe(3)
    expect(validated.counterfactualRunIds).toHaveLength(3)

    expect(repair.rejected).toHaveLength(1)
    expect(repair.rejected[0]!.reason).toBe('did-not-flip')
    expect(repair.rejected[0]!.mutation).toEqual(badFix)
    expect(repair.rejected[0]!.deltaScore).toBeCloseTo(0.1, 1)
    expect(repair.replaysUsed).toBe(6)
  })

  it('a repair must flip on EVERY validation rep, not on average', async () => {
    const { store, runId, report } = await diagnosedSetup()
    // Scores alternate 0.9 / 0.4: mean 0.65 crosses the threshold but rep 2 does not.
    let call = 0
    const runner: CounterfactualRunner = {
      async executeFrom(_ctx, emitter) {
        call++
        await emitter.endRun({ pass: true, score: call % 2 === 1 ? 0.9 : 0.4 })
      },
    }
    const repair = await prescribeRepair({
      store,
      runId,
      runner,
      blamed: report.steps.slice(0, 1),
      proposeFix: async () => [goodFix],
      repsToValidate: 3,
    })
    expect(repair.repairs).toHaveLength(0)
    expect(repair.rejected[0]!.reason).toBe('did-not-flip')
  })

  it('replay errors become typed rejections, never silent drops', async () => {
    const { store, runId, report } = await diagnosedSetup()
    const { runner } = makeRunner({ seed: 5 })
    const explosive: CounterfactualMutation = {
      kind: 'custom',
      at: 1,
      describe: 'patch the parser',
      apply: () => {
        throw new Error('boom: parser patch unapplicable')
      },
    }
    const repair = await prescribeRepair({
      store,
      runId,
      runner,
      blamed: report.steps.slice(0, 1),
      proposeFix: async () => [explosive],
    })
    expect(repair.repairs).toHaveLength(0)
    expect(repair.rejected).toHaveLength(1)
    expect(repair.rejected[0]!.reason).toBe('error')
    expect(repair.rejected[0]!.error).toMatch(/boom/)
  })

  it('respects maxAttemptsPerStep', async () => {
    const { store, runId, report } = await diagnosedSetup()
    const { runner } = makeRunner({ seed: 5, scoreFor: () => 0.3 })
    const repair = await prescribeRepair({
      store,
      runId,
      runner,
      blamed: report.steps.slice(0, 1),
      proposeFix: async () => [badFix, goodFix],
      maxAttemptsPerStep: 1,
    })
    expect(repair.repairs).toHaveLength(0)
    expect(repair.rejected).toHaveLength(1)
    expect(repair.rejected[0]!.mutation).toEqual(badFix)
  })

  it('rejects a stale report whose stepRef does not match the run', async () => {
    const { store, runId, report } = await diagnosedSetup()
    const { runner } = makeRunner({ seed: 5 })
    const stale = { ...report.steps[0]!, stepRef: { ...report.steps[0]!.stepRef, spanId: 'nope' } }
    await expect(
      prescribeRepair({
        store,
        runId,
        runner,
        blamed: [stale],
        proposeFix: async () => [goodFix],
      }),
    ).rejects.toThrow(/does not match run/)
  })
})

describe('remediation adapters', () => {
  async function fullChain() {
    const store = new InMemoryTraceStore()
    const runId = await seedRun(store, 0.2, SHAPE)
    const sweep = makeRunner({ seed: 42 })
    const report = await causalSweep({
      store,
      runId,
      runner: sweep.runner,
      candidateSteps: [1, 2],
      reps: 5,
      budget: 100,
      ciSeed: 7,
    })
    const fix: CounterfactualMutation = {
      kind: 'swap-tool-result',
      at: 1,
      newResult: { rate: 4.5 },
    }
    const validate = makeRunner({ seed: 11, scoreFor: () => 0.9 })
    const repairs = await prescribeRepair({
      store,
      runId,
      runner: validate.runner,
      blamed: report.steps.slice(0, 1),
      proposeFix: async () => [fix],
    })
    return { report, repairs }
  }

  it('toAnalystFindings emits schema-valid findings with effect-scaled severity', async () => {
    const { report, repairs } = await fullChain()
    const findings = toAnalystFindings(report, repairs)
    expect(findings).toHaveLength(2)

    for (const f of findings) {
      expect(f.schema_version).toBe('1.0.0')
      expect(f.finding_id).toMatch(/^f_[0-9a-f]{20}$/)
      expect(f.analyst_id).toBe(DIAGNOSE_ANALYST_ID)
      expect(f.area).toBe('causal-attribution')
      expect(f.evidence_refs.length).toBeGreaterThanOrEqual(2)
      expect(f.derived_from_judge).toBeUndefined()
    }

    const blamed = findings.find((f) => f.subject === report.steps[0]!.stepRef.spanId)!
    expect(blamed.severity).toBe('critical')
    expect(blamed.confidence).toBe(0.95)
    expect(blamed.recommended_action).toBe(describeMutation(repairs.repairs[0]!.mutation))
    expect(blamed.validation_plan).toMatch(/replay-validated: 3\/3 reps scored >= 0\.5/)
    expect(blamed.evidence_refs[0]!.uri).toBe(`span://${report.steps[0]!.stepRef.spanId}`)
    expect(blamed.evidence_refs[1]!.excerpt).toContain('deltas=[')

    const noise = findings.find((f) => f.subject === report.steps[1]!.stepRef.spanId)!
    expect(noise.severity).toBe('info')
    expect(noise.confidence).toBe(0.3)
    expect(noise.recommended_action).toBeUndefined()
  })

  it('toCorpusRecord pins the failure as a fresh, schema-valid corpus scenario', async () => {
    const { repairs } = await fullChain()
    const original: RunRecord = {
      runId: 'run-original',
      experimentId: 'exp-1',
      candidateId: 'cand-1',
      seed: 42,
      model: 'test-model@2026-01-01',
      promptHash: 'p'.repeat(8),
      configHash: 'c'.repeat(8),
      commitSha: 'deadbeef',
      wallMs: 1200,
      costUsd: 0.01,
      tokenUsage: { input: 100, output: 50 },
      outcome: { searchScore: 0.2, raw: {} },
      splitTag: 'search',
    }
    const repair = repairs.repairs[0]!
    const pinned = toCorpusRecord(original, repair, { prompt: 'fetch the current rates' })

    expect(pinned.runId).toBe(`run-original#repair:${repair.stepRef.spanId}`)
    expect(pinned.runId).not.toBe(original.runId)
    expect(pinned.prompt).toBe('fetch the current rates')
    expect(pinned.completion).toBe(describeMutation(repair.mutation))
    expect(pinned.outcome.raw.diagnose_blamed_step_index).toBe(1)
    expect(pinned.outcome.raw.diagnose_repair_mean_score).toBeCloseTo(repair.meanScore, 10)
    expect(pinned.outcome.raw.diagnose_repair_delta_score).toBeCloseTo(repair.deltaScore, 10)
    // Original record untouched.
    expect(original.outcome.raw.diagnose_blamed_step_index).toBeUndefined()
  })

  it('suggestInvariant derives never/without clauses per mutation kind', async () => {
    const { repairs } = await fullChain()
    const toolHint = suggestInvariant(repairs.repairs[0]!)
    expect(toolHint.description).toContain('fetch-rates')
    expect(toolHint.never).toContain("tool 'fetch-rates'")
    expect(toolHint.without).toContain("tool 'fetch-rates'")

    const base = repairs.repairs[0]!
    const truncate: ValidatedRepair = {
      ...base,
      mutation: { kind: 'truncate-after', at: 1 },
    }
    const truncateHint = suggestInvariant(truncate)
    expect(truncateHint.never).toContain('after')
    expect(truncateHint.without).toBeUndefined()

    const inject: ValidatedRepair = {
      ...base,
      mutation: { kind: 'inject-system-message', at: 1, content: 'always validate rates' },
    }
    const injectHint = suggestInvariant(inject)
    expect(injectHint.without).toContain('always validate rates')

    const swapModel: ValidatedRepair = {
      ...base,
      mutation: { kind: 'swap-model', at: 1, newModel: 'better-model@2026-01-01' },
    }
    expect(suggestInvariant(swapModel).never).toContain('better-model@2026-01-01')
  })
})
