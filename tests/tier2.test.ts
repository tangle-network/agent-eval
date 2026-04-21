import { describe, expect, it } from 'vitest'
import {
  InMemoryTraceStore,
  TraceEmitter,
} from '../src/trace'
import type { ToolSpan } from '../src/trace'
import {
  attributeCounterfactuals,
  runCounterfactual,
  type CounterfactualRunner,
} from '../src/counterfactual'
import { crossTraceDiff } from '../src/cross-trace-diff'
import {
  evaluateHypothesis,
  signManifest,
  verifyManifest,
  type HypothesisManifest,
} from '../src/pre-registration'

async function seed(
  store: InMemoryTraceStore,
  outputScore: number,
  shape: Array<{ kind: 'llm' | 'tool'; name: string; model?: string; toolName?: string }>,
): Promise<string> {
  const e = new TraceEmitter(store)
  await e.startRun({ scenarioId: 's' })
  for (const s of shape) {
    if (s.kind === 'llm') {
      const h = await e.span({ kind: 'llm', name: s.name, model: s.model ?? 'm', messages: [], output: 'x' })
      await h.end()
    } else {
      const h = await e.span({ kind: 'tool', name: s.name, toolName: s.toolName ?? s.name, args: {} })
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
        const h = await emitter.span({ kind: 'llm', name: 'plan-cf', model: 'claude-opus', messages: [], output: 'better' })
        await h.end()
        await emitter.endRun({ pass: true, score: 0.82 })
      },
    }
    const result = await runCounterfactual(
      store, originalId,
      { kind: 'swap-model', at: 0, newModel: 'claude-opus' },
      runner,
    )
    expect(result.delta.deltaScore).toBeCloseTo(0.22)
    const cfRun = await store.getRun(result.counterfactualRunId)
    expect(cfRun?.parentRunId).toBe(originalId)
    expect(cfRun?.layer).toBe('meta')
    expect(cfRun?.tags?.counterfactual).toBe('true')
  })

  it('rejects out-of-range mutation index — regression: silent OOB would produce bogus replays', async () => {
    const store = new InMemoryTraceStore()
    const originalId = await seed(store, 0.5, [{ kind: 'llm', name: 'one' }])
    await expect(
      runCounterfactual(store, originalId, { kind: 'swap-model', at: 5, newModel: 'x' }, {
        async executeFrom(_c, e) { await e.endRun({ pass: true }) },
      }),
    ).rejects.toThrow(/out of range/)
  })

  it('attributeCounterfactuals ranks mutations by mean absolute delta', () => {
    const rows = [
      { counterfactualRunId: 'a', originalRunId: 'o', mutation: { kind: 'swap-model', at: 0, newModel: 'x' } as const, delta: { originalOutcomeScore: 0.5, counterfactualOutcomeScore: 0.8, deltaScore: 0.3 } },
      { counterfactualRunId: 'b', originalRunId: 'o', mutation: { kind: 'swap-tool-result', at: 1, newResult: 'x' } as const, delta: { originalOutcomeScore: 0.5, counterfactualOutcomeScore: 0.52, deltaScore: 0.02 } },
      { counterfactualRunId: 'c', originalRunId: 'o', mutation: { kind: 'swap-model', at: 2, newModel: 'y' } as const, delta: { originalOutcomeScore: 0.5, counterfactualOutcomeScore: 0.7, deltaScore: 0.2 } },
    ]
    const rank = attributeCounterfactuals(rows)
    expect(rank[0].mutationKind).toBe('swap-model')
    expect(rank[0].n).toBe(2)
    expect(rank[0].meanAbsDelta).toBeCloseTo(0.25)
  })
})

describe('crossTraceDiff', () => {
  it('aligns matched + replaced steps and emits per-step attributions', async () => {
    const store = new InMemoryTraceStore()
    const a = await seed(store, 0.6, [
      { kind: 'llm', name: 'plan', model: 'claude' },
      { kind: 'tool', name: 'search' },
    ])
    const b = await seed(store, 0.8, [
      { kind: 'llm', name: 'plan', model: 'gpt' },   // model swap
      { kind: 'tool', name: 'search' },
    ])
    const diff = await crossTraceDiff(store, a, b)
    expect(diff.totalScoreDelta).toBeCloseTo(0.2)
    const kinds = diff.alignment.map((o) => o.op)
    expect(kinds).toContain('replace')
    expect(kinds).toContain('match')
  })

  it('inserts/deletes on length mismatch', async () => {
    const store = new InMemoryTraceStore()
    const a = await seed(store, 0.5, [{ kind: 'llm', name: 'one' }])
    const b = await seed(store, 0.5, [
      { kind: 'llm', name: 'one' },
      { kind: 'tool', name: 'search' },
    ])
    const diff = await crossTraceDiff(store, a, b)
    expect(diff.alignment.find((o) => o.op === 'insert')).toBeDefined()
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
})
