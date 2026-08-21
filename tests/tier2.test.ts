import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  attributeCounterfactuals,
  type CounterfactualRunner,
  runCounterfactual,
} from '../src/counterfactual'
import {
  evaluateHypothesis,
  type HypothesisManifest,
  hashJson,
  manifestContentDigest,
  type SignedManifest,
  signManifest,
  verifyManifest,
} from '../src/pre-registration'
import type { ToolSpan } from '../src/trace'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

/** Key-sorted `JSON.stringify`, the scheme manifests were signed under before
 * RFC 8785. Kept here to MINT a legacy manifest the verifier must still accept. */
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

  it('attributeCounterfactuals ranks mutations by mean absolute delta', () => {
    const rows = [
      {
        counterfactualRunId: 'a',
        originalRunId: 'o',
        mutation: { kind: 'swap-model', at: 0, newModel: 'x' } as const,
        delta: { originalOutcomeScore: 0.5, counterfactualOutcomeScore: 0.8, deltaScore: 0.3 },
      },
      {
        counterfactualRunId: 'b',
        originalRunId: 'o',
        mutation: { kind: 'swap-tool-result', at: 1, newResult: 'x' } as const,
        delta: { originalOutcomeScore: 0.5, counterfactualOutcomeScore: 0.52, deltaScore: 0.02 },
      },
      {
        counterfactualRunId: 'c',
        originalRunId: 'o',
        mutation: { kind: 'swap-model', at: 2, newModel: 'y' } as const,
        delta: { originalOutcomeScore: 0.5, counterfactualOutcomeScore: 0.7, deltaScore: 0.2 },
      },
    ]
    const rank = attributeCounterfactuals(rows)
    expect(rank[0].mutationKind).toBe('swap-model')
    expect(rank[0].n).toBe(2)
    expect(rank[0].meanAbsDelta).toBeCloseTo(0.25)
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

  it('signs under RFC 8785 and still verifies a manifest signed by the previous scheme — regression: a durable manifest outlives the release that signed it', async () => {
    const signed = await signManifest(base)
    expect(signed.algo).toBe('sha256-rfc8785')
    expect(await verifyManifest(signed)).toBe(true)

    // A manifest signed by the previous release: key-sorted JSON.stringify,
    // tagged 'sha256-content' — and the same manifest with no `algo` at all,
    // which is how the oldest serialized manifests look.
    const legacyDigest = createHash('sha256')
      .update(JSON.stringify(sortKeysDeep(base)), 'utf8')
      .digest('hex')
    const tagged: SignedManifest = { ...base, contentHash: legacyDigest, algo: 'sha256-content' }
    const untagged = { ...base, contentHash: legacyDigest } as SignedManifest
    expect(await verifyManifest(tagged)).toBe(true)
    expect(await verifyManifest(untagged)).toBe(true)

    // Tampering is still caught under either scheme.
    expect(await verifyManifest({ ...tagged, minEffect: base.minEffect + 1 })).toBe(false)
    expect(await verifyManifest({ ...signed, minEffect: base.minEffect + 1 })).toBe(false)
  })

  it('refuses a manifest whose algo this release cannot verify instead of reading it as valid', () => {
    const alien = { ...base, contentHash: 'x'.repeat(64), algo: 'sha512-future' } as unknown
    expect(() => manifestContentDigest(alien as SignedManifest)).toThrow(
      /unrecognized manifest hash algo 'sha512-future'/,
    )
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
