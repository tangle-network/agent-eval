import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type CounterfactualRunner, runCounterfactual } from '../src/counterfactual'
import { ValidationError } from '../src/errors'
import {
  evaluateHypothesis,
  type HypothesisManifest,
  hashJson,
  manifestContentDigest,
  type SignedManifest,
  signManifest,
  verifyManifest,
} from '../src/pre-registration'
import type { LlmSpan, ToolSpan } from '../src/trace'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import { buildTrajectory, trajectoryTimingBoundary } from '../src/trajectory'

/** Produce a correctly hashed retired record to exercise scheme rejection. */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
  }
  return out
}

async function seed(
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
      await h.end({ result: 'ok' } as Partial<ToolSpan>)
    }
  }
  await e.endRun({ pass: true, score: outputScore })
  return e.runId
}

describe('runCounterfactual', () => {
  it('records a meta run with parent = original + returns signed delta', async () => {
    const store = new InMemoryTraceStore()
    const originalId = await seed(store, 0.6, [
      { kind: 'llm', name: 'plan', model: 'claude-sonnet' },
      { kind: 'tool', name: 'search' },
    ])
    const runner: CounterfactualRunner = {
      async executeFrom(_ctx, emitter) {
        const h = await emitter.span({
          kind: 'llm',
          name: 'plan-cf',
          model: 'claude-opus',
          messages: [],
          output: 'better',
        })
        await h.end()
        await emitter.endRun({ pass: true, score: 0.82 })
      },
    }
    const result = await runCounterfactual(
      store,
      originalId,
      { kind: 'swap-model', at: 0, newModel: 'claude-opus' },
      runner,
    )
    expect(result.delta.deltaScore).toBeCloseTo(0.22)
    const cfRun = await store.getRun(result.counterfactualRunId)
    expect(cfRun?.parentRunId).toBe(originalId)
    expect(cfRun?.layer).toBe('meta')
    expect(cfRun?.tags?.counterfactual).toBe('true')
  })

  it('never hands the replayed agent a step that started after the decision it changes', async () => {
    // Two parallel branches under one supervisor: A starts at t=1, B at t=2,
    // B decides at t=3, and A writes at t=40. Depth-first order lists A's whole
    // branch, write included, before B.
    const store = new InMemoryTraceStore()
    let t = 0
    const e = new TraceEmitter(store, { now: () => t })
    await e.startRun({ scenarioId: 's' })
    const root = await e.span({ kind: 'agent', name: 'supervisor' })
    t = 1
    const a = await e.span({ kind: 'agent', name: 'agent-a', parentSpanId: root.span.spanId })
    t = 2
    const b = await e.span({ kind: 'agent', name: 'agent-b', parentSpanId: root.span.spanId })
    t = 3
    const decide = await e.span({
      kind: 'llm',
      name: 'b-decide',
      model: 'm',
      messages: [],
      parentSpanId: b.span.spanId,
    })
    t = 5
    await decide.end()
    t = 40
    const write = await e.span({
      kind: 'tool',
      name: 'a-write',
      toolName: 'write',
      args: { path: 'out.txt' },
      parentSpanId: a.span.spanId,
    })
    t = 41
    await write.end()
    t = 42
    await a.end()
    t = 43
    await b.end()
    t = 50
    await root.end()
    await e.endRun({ pass: true, score: 0.5 })

    let prefix: string[] = []
    let inFlight: string[] = []
    const runner: CounterfactualRunner = {
      async executeFrom(ctx, emitter) {
        expect(ctx.mutatedStep.span.name).toBe('b-decide')
        expect((ctx.mutatedStep.span as LlmSpan).model).toBe('other')
        const startedAt = ctx.mutatedStep.span.startedAt
        prefix = ctx.prefix.map((s) => s.span.name)
        inFlight = ctx.inFlight.map((s) => s.span.name)
        expect(ctx.prefix.filter((s) => s.span.startedAt > startedAt)).toHaveLength(0)
        await emitter.endRun({ pass: true, score: 0.5 })
      },
    }
    const result = await runCounterfactual(
      store,
      e.runId,
      { kind: 'swap-model', at: 4, newModel: 'other' },
      runner,
    )
    // a-write (t=40) is in neither list; agent-a was running when B decided.
    expect(prefix).toEqual(['supervisor', 'agent-b'])
    expect(inFlight).toEqual(['agent-a'])
    expect(result.delta.deltaScore).toBe(0)
    expect(result.targetSpanId).toBe(decide.span.spanId)
    const byIndex = await store.getRun(result.counterfactualRunId)
    expect(byIndex?.variantId).toBe('cf:swap-model@4')
    expect(byIndex?.tags).toMatchObject({ mutationAt: '4', mutationSpanId: decide.span.spanId })

    // The same target named by span id draws the same boundary.
    prefix = []
    inFlight = []
    const bySpan = await runCounterfactual(
      store,
      e.runId,
      { kind: 'swap-model', at: { spanId: decide.span.spanId }, newModel: 'other' },
      runner,
    )
    expect(prefix).toEqual(['supervisor', 'agent-b'])
    expect(inFlight).toEqual(['agent-a'])
    expect(bySpan.targetSpanId).toBe(decide.span.spanId)
    const bySpanRun = await store.getRun(bySpan.counterfactualRunId)
    expect(bySpanRun?.variantId).toBe(`cf:swap-model@span:${decide.span.spanId}`)
    expect(bySpanRun?.tags).toMatchObject({ mutationAt: '4', mutationSpanId: decide.span.spanId })

    // Drawn at A's write instead: B's decision had settled, B itself had not.
    const boundary = trajectoryTimingBoundary(await buildTrajectory(store, e.runId), {
      spanId: write.span.spanId,
    })
    expect(boundary.target.span.name).toBe('a-write')
    expect(boundary.prefix.map((s) => s.span.name)).toEqual(['supervisor', 'agent-a', 'b-decide'])
    expect(boundary.inFlight.map((s) => s.span.name)).toEqual(['agent-b'])
  })

  it('draws the same prefix as the step list for a sequential trace, at every step', async () => {
    const store = new InMemoryTraceStore()
    let t = 0
    const e = new TraceEmitter(store, { now: () => t++ })
    await e.startRun({ scenarioId: 's' })
    await e.within({ kind: 'agent', name: 'plan' }, async () => {
      const llm = await e.llm({ name: 'think', model: 'm', messages: [] })
      await llm.end()
      const tool = await e.tool({ name: 'search', toolName: 'search', args: {} })
      await tool.end()
    })
    const answer = await e.llm({ name: 'answer', model: 'm', messages: [] })
    await answer.end()
    await e.recordJudge({
      judgeId: 'j',
      targetSpanId: answer.span.spanId,
      dimension: 'quality',
      score: 1,
      name: 'grade',
    })
    await e.endRun({ pass: true, score: 1 })
    // Real-clock runs share milliseconds; ties must not reorder anything.
    const realClock = await seed(store, 0.5, [
      { kind: 'llm', name: 'plan' },
      { kind: 'tool', name: 'search' },
      { kind: 'llm', name: 'answer' },
      { kind: 'tool', name: 'write' },
    ])

    for (const runId of [e.runId, realClock]) {
      const trajectory = await buildTrajectory(store, runId)
      expect(trajectory.steps.length).toBeGreaterThanOrEqual(4)
      for (const step of trajectory.steps) {
        const prefixes: string[][] = []
        await runCounterfactual(
          store,
          runId,
          { kind: 'truncate-after', at: step.index },
          {
            async executeFrom(ctx, emitter) {
              expect(ctx.inFlight).toEqual([])
              prefixes.push(ctx.prefix.map((s) => s.span.spanId))
              await emitter.endRun({ pass: true })
            },
          },
        )
        expect(prefixes).toEqual([trajectory.steps.slice(0, step.index).map((s) => s.span.spanId)])
      }
    }
  })

  it('rejects a span id no step carries', async () => {
    const store = new InMemoryTraceStore()
    const originalId = await seed(store, 0.5, [{ kind: 'llm', name: 'one' }])
    const attempt = runCounterfactual(
      store,
      originalId,
      { kind: 'swap-model', at: { spanId: 'not-in-this-run' }, newModel: 'x' },
      {
        async executeFrom(_c, e) {
          await e.endRun({ pass: true })
        },
      },
    )
    await expect(attempt).rejects.toBeInstanceOf(ValidationError)
    await expect(attempt).rejects.toThrow(/no step has span id "not-in-this-run"/)
  })

  it('rejects out-of-range mutation index — regression: silent OOB would produce bogus replays', async () => {
    const store = new InMemoryTraceStore()
    const originalId = await seed(store, 0.5, [{ kind: 'llm', name: 'one' }])
    await expect(
      runCounterfactual(
        store,
        originalId,
        { kind: 'swap-model', at: 5, newModel: 'x' },
        {
          async executeFrom(_c, e) {
            await e.endRun({ pass: true })
          },
        },
      ),
    ).rejects.toThrow(/out of range/)
  })
})

describe('pre-registration', () => {
  const base: HypothesisManifest = {
    id: 'h1',
    hypothesis: 'variant B improves score by ≥ 0.05',
    metric: 'overallScore',
    direction: 'increase',
    minEffect: 0.05,
    alpha: 0.05,
    power: 0.8,
    preRegisteredN: 30,
    registeredAt: '2026-04-20T00:00:00Z',
    baselineLabel: 'A',
    candidateLabel: 'B',
  }

  it('signManifest produces a stable contentHash', async () => {
    const a = await signManifest(base)
    const b = await signManifest(base)
    expect(a.contentHash).toBe(b.contentHash)
    expect(await verifyManifest(a)).toBe(true)
  })

  it('accepts RFC 8785 and refuses correctly hashed records under the retired scheme', async () => {
    const signed = await signManifest(base)
    expect(signed.algo).toBe('sha256-rfc8785')
    expect(await verifyManifest(signed)).toBe(true)

    const legacyDigest = createHash('sha256')
      .update(JSON.stringify(sortKeysDeep(base)), 'utf8')
      .digest('hex')
    const tagged: SignedManifest = JSON.parse(
      JSON.stringify({ ...base, contentHash: legacyDigest, algo: 'sha256-content' }),
    )
    const untagged: SignedManifest = JSON.parse(
      JSON.stringify({ ...base, contentHash: legacyDigest }),
    )
    expect(await verifyManifest(tagged)).toBe(false)
    expect(await verifyManifest(untagged)).toBe(false)
    await expect(evaluateHypothesis(tagged, { n: 30, effect: 0.08, pValue: 0.01 })).rejects.toThrow(
      /unsupported manifest hash scheme/,
    )

    expect(await verifyManifest({ ...signed, minEffect: base.minEffect + 1 })).toBe(false)
  })

  it('refuses an unknown scheme in both synchronous and asynchronous verification', async () => {
    const alien: SignedManifest = JSON.parse(
      JSON.stringify({ ...base, contentHash: 'x'.repeat(64), algo: 'sha512-future' }),
    )
    expect(() => manifestContentDigest(alien)).toThrow(
      /unsupported manifest hash algo 'sha512-future'/,
    )
    expect(await verifyManifest(alien)).toBe(false)
  })

  it('evaluateHypothesis confirms when all conditions met', async () => {
    const signed = await signManifest(base)
    const r = await evaluateHypothesis(signed, { n: 30, effect: 0.08, pValue: 0.01 })
    expect(r.confirmed).toBe(true)
    expect(r.rejectionReasons).toHaveLength(0)
  })

  it('rejects with machine-tagged reasons when conditions fail — regression: ambiguous rejections let you re-interpret', async () => {
    const signed = await signManifest(base)
    const r = await evaluateHypothesis(signed, { n: 20, effect: -0.02, pValue: 0.3 })
    expect(r.confirmed).toBe(false)
    expect(r.rejectionReasons).toContain('wrong_direction')
    expect(r.rejectionReasons).toContain('effect_too_small')
    expect(r.rejectionReasons).toContain('not_significant')
    expect(r.rejectionReasons).toContain('undersampled')
  })

  it('tampered manifest is rejected', async () => {
    const signed = await signManifest(base)
    const tampered = { ...signed, minEffect: 0.001 } // silently relax the threshold
    await expect(
      evaluateHypothesis(tampered, { n: 30, effect: 0.003, pValue: 0.01 }),
    ).rejects.toThrow(/tampered|hash/i)
  })

  it('hashJson is stable across key insertion order — the property signManifest depends on', async () => {
    const ordered = await hashJson({ b: 2, a: 1 })
    const reordered = await hashJson({ a: 1, b: 2 })
    expect(ordered).toBe(reordered)
    expect(ordered).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashJson matches signManifest contentHash for the same payload — generic primitive composes with the manifest signer', async () => {
    const signed = await signManifest(base)
    const direct = await hashJson(base)
    expect(signed.contentHash).toBe(direct)
  })

  it('hashJson and prompt-registry hashContent are independent functions — different return shape', async () => {
    // Regression: don't accidentally collapse the two. hashContent (prompt-registry)
    // returns a 12-char id over a string. hashJson (here) returns 64 hex chars over
    // canonicalized JSON.
    const long = await hashJson('x')
    expect(long).toMatch(/^[0-9a-f]{64}$/)
  })
})
