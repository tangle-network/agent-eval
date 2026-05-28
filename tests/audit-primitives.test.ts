import { describe, expect, it } from 'vitest'
import {
  assertSingleBackend,
  type BackendDescriptor,
  SingleBackendError,
} from '../src/integrity/single-backend'
import { assertCrossFamily, CrossFamilyError, judgeFamily } from '../src/judge-families'
import { cliffsDelta, interpretCliffs, weightedComposite } from '../src/statistics'

// ── T08 cliffsDelta ──────────────────────────────────────────────────
describe('cliffsDelta + interpretCliffs', () => {
  it('is +1 when after strictly dominates before, -1 when reversed', () => {
    expect(cliffsDelta([1, 2, 3], [4, 5, 6])).toBe(1)
    expect(cliffsDelta([4, 5, 6], [1, 2, 3])).toBe(-1)
  })
  it('is 0 for identical distributions and for empty input', () => {
    expect(cliffsDelta([1, 2, 3], [1, 2, 3])).toBe(0)
    expect(cliffsDelta([], [1, 2])).toBe(0)
  })
  it('maps magnitude with the standard thresholds', () => {
    expect(interpretCliffs(0.1)).toBe('negligible')
    expect(interpretCliffs(0.2)).toBe('small')
    expect(interpretCliffs(0.4)).toBe('medium')
    expect(interpretCliffs(0.9)).toBe('large')
    expect(interpretCliffs(-0.9)).toBe('large') // magnitude, sign-independent
  })
})

// ── T03 weightedComposite ────────────────────────────────────────────
describe('weightedComposite', () => {
  it('computes the weighted mean over weighted dimensions', () => {
    const r = weightedComposite({
      dims: { accuracy: 0.9, style: 0.5, safety: 1 },
      weights: { accuracy: 3, style: 1 },
    })
    expect(r.composite).toBeCloseTo((0.9 * 3 + 0.5 * 1) / 4, 10)
    expect(r.pass).toBeUndefined()
  })
  it('reports pass against a threshold', () => {
    expect(weightedComposite({ dims: { a: 0.8 }, weights: { a: 1 }, threshold: 0.7 }).pass).toBe(
      true,
    )
    expect(weightedComposite({ dims: { a: 0.6 }, weights: { a: 1 }, threshold: 0.7 }).pass).toBe(
      false,
    )
  })
  it('fails loud on a weighted dimension absent from dims', () => {
    expect(() => weightedComposite({ dims: { a: 0.9 }, weights: { a: 1, missing: 2 } })).toThrow(
      /absent from `dims`/,
    )
  })
  it('fails loud on negative weight, empty weights, and zero weight sum', () => {
    expect(() => weightedComposite({ dims: { a: 1 }, weights: { a: -1 } })).toThrow(/negative/)
    expect(() => weightedComposite({ dims: { a: 1 }, weights: {} })).toThrow(/empty/)
    expect(() => weightedComposite({ dims: { a: 1 }, weights: { a: 0 } })).toThrow(/sum to 0/)
  })
})

// ── T01 judgeFamily + assertCrossFamily ──────────────────────────────
describe('judgeFamily + assertCrossFamily', () => {
  it('classifies by provider prefix and by model-name fallback', () => {
    expect(judgeFamily('anthropic/claude-opus-4-5-20251101')).toBe('anthropic')
    expect(judgeFamily('openai/gpt-4o')).toBe('openai')
    expect(judgeFamily('claude-sonnet-4-6@2026-05-08')).toBe('anthropic')
    expect(judgeFamily('gemini-2.5-pro')).toBe('google')
    expect(judgeFamily('meta-llama/llama-3.3-70b')).toBe('meta')
    expect(judgeFamily('some-internal-model')).toBe('unknown')
  })
  it('classifies Tangle cli-bridge model ids (moonshot + zhipu) instead of unknown', () => {
    expect(judgeFamily('kimi/k2')).toBe('moonshot')
    expect(judgeFamily('kimi-code/k2-0905')).toBe('moonshot')
    expect(judgeFamily('moonshotai/kimi-k2')).toBe('moonshot')
    expect(judgeFamily('opencode/kimi-k2')).toBe('moonshot')
    expect(judgeFamily('zai/glm-4.6')).toBe('zhipu')
    expect(judgeFamily('z-ai/glm-4.6')).toBe('zhipu')
    expect(judgeFamily('glm-4.6')).toBe('zhipu')
    expect(judgeFamily('zhipu/glm-4-plus')).toBe('zhipu')
    expect(judgeFamily('claude-code/sonnet')).toBe('anthropic')
  })
  it('counts kimi vs glm as two distinct families (no false single-family collapse)', () => {
    expect(assertCrossFamily(['kimi/k2', 'zai/glm-4.6'])).toEqual(['moonshot', 'zhipu'])
  })
  it('passes a genuinely cross-family ensemble', () => {
    expect(assertCrossFamily(['anthropic/claude-opus-4-5', 'openai/gpt-4o'])).toEqual([
      'anthropic',
      'openai',
    ])
  })
  it('throws for a single-family ensemble (correlated bias)', () => {
    expect(() => assertCrossFamily(['claude-opus', 'claude-haiku'])).toThrow(CrossFamilyError)
  })
  it('excludes unknown-family models from the count by default', () => {
    expect(() => assertCrossFamily(['openai/gpt-4o', 'mystery-model'])).toThrow(CrossFamilyError)
    expect(assertCrossFamily(['openai/gpt-4o', 'mystery-model'], { allowUnknown: true })).toEqual([
      'openai',
      'unknown',
    ])
  })
})

// ── T05 assertSingleBackend (spec test plan) ─────────────────────────
describe('assertSingleBackend', () => {
  const base: BackendDescriptor = {
    kind: 'tcloud',
    baseUrl: 'https://router.tangle.tools/v1',
    model: 'claude-sonnet-4-6',
    apiKey: 'sk-x',
  }
  it('identical descriptors → ok, no divergences', () => {
    const r = assertSingleBackend(base, { ...base })
    expect(r.ok).toBe(true)
    expect(r.divergences).toEqual([])
  })
  it('different baseUrl → throws under default strictness', () => {
    expect(() =>
      assertSingleBackend(base, { ...base, baseUrl: 'https://openrouter.ai/api/v1' }),
    ).toThrow(SingleBackendError)
  })
  it('different model → ok by default, throws under strict', () => {
    const judge = { ...base, model: 'claude-haiku-4-5' }
    expect(assertSingleBackend(base, judge).ok).toBe(true)
    expect(() => assertSingleBackend(base, judge, { strict: true })).toThrow(SingleBackendError)
  })
  it('mismatched apiKey presence → throws (values never compared)', () => {
    expect(() => assertSingleBackend(base, { ...base, apiKey: undefined })).toThrow(
      /apiKeyPresence/,
    )
  })
  it('ignores a trailing slash on baseUrl', () => {
    expect(assertSingleBackend(base, { ...base, baseUrl: `${base.baseUrl}/` }).ok).toBe(true)
  })
  it('bakes agent/judge labels into the message', () => {
    expect(() =>
      assertSingleBackend(
        base,
        { ...base, kind: 'cli-bridge' },
        {
          agentLabel: 'AGENT',
          judgeLabel: 'JUDGE',
        },
      ),
    ).toThrow(/AGENT.*JUDGE/s)
  })
})
