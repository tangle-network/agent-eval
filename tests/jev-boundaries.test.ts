import { describe, expect, it, vi } from 'vitest'
import {
  asJudge,
  jevAnalyst,
  jevEvaluator,
  jevJudge,
  parseJevRequest,
  parseJevResult,
} from '../src/jev'
import { canonicalString, jsonDocument } from '../src/ledger-core/canonical'

const model = 'test-classifier'
const scenario = { id: 'case', kind: 'test' }
const rawResult = {
  model,
  answers: { ready: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 5, output_tokens: 1 },
}
const options = {
  model,
  version: 'v1',
  questions: { ready: { type: 'noul' as const, instructions: null, criteria: undefined } },
  renderState: () => null,
  evaluate: async () => rawResult,
}

describe('native SDK and execution boundaries', () => {
  it('hashes optional undefined fields exactly like their JSON wire form', () => {
    // The official noul() builder returns criteria: undefined when criteria are omitted.
    const explicit = jevJudge('ready', options)
    const omitted = jevJudge('ready', {
      ...options,
      questions: { ready: { type: 'noul', instructions: null } },
    })
    expect(explicit.judgeVersion).toBe(omitted.judgeVersion)
    const common = {
      ...options,
      id: 'ready',
      description: 'Readiness',
      inputKind: 'custom' as const,
      findings: () => [],
    }
    expect(jevAnalyst(common).version).toBe(
      jevAnalyst({
        ...common,
        questions: { ready: { type: 'noul', instructions: null } },
      }).version,
    )
  })

  it('allows optional absent noul outcomes without accepting absent required descriptions', () => {
    expect(() =>
      parseJevRequest({
        model,
        state: null,
        questions: {
          ready: { type: 'noul', criteria: { true: { evidence: 'observed' }, false: undefined } },
        },
      }),
    ).not.toThrow()
    expect(() =>
      parseJevRequest({
        model,
        state: null,
        questions: {
          ready: { type: 'choice', criteria: { yes: undefined } },
        },
      }),
    ).toThrow()
  })

  it.each([
    new Map([['important', true]]),
    new Date(0),
    new Set(['evidence']),
    { evidence: Number.NaN },
  ])('rejects lossy evidence before paid admission', async (state) => {
    const execute = vi.fn(async () => rawResult)
    const evaluate = jevEvaluator({ evaluate: execute })
    await expect(
      evaluate({ model, state: state as never, questions: { ready: { type: 'noul' } } }),
    ).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('retains caller-owned __proto__ labels when normalizing JSON for versioning', () => {
    const document = jsonDocument(
      JSON.parse('{"__proto__":{"type":"noul"},"ready":{"type":"noul"}}'),
    )
    expect(Object.hasOwn(document as object, '__proto__')).toBe(true)
    expect(canonicalString(document)).toBe('{"__proto__":{"type":"noul"},"ready":{"type":"noul"}}')
  })

  it('passes the deadline-aware signal to evidence preparation and findings', async () => {
    const controller = new AbortController()
    const signals: (AbortSignal | undefined)[] = []
    const analyst = jevAnalyst({
      ...options,
      questions: { ready: { type: 'noul' } },
      id: 'ready',
      description: 'Readiness',
      inputKind: 'custom',
      renderState: (_input, context) => {
        signals.push(context.signal)
        return null
      },
      findings: (_result, _input, context) => {
        signals.push(context.signal)
        return []
      },
    })
    await analyst.analyze(null, {
      runId: 'r',
      correlationId: 'c',
      signal: controller.signal,
      deadlineMs: Date.now() + 60_000,
    })
    expect(signals).toHaveLength(2)
    expect(signals[0]).toBeDefined()
    expect(signals[0]).not.toBe(controller.signal)
    expect(signals[1]).toBe(signals[0])
  })

  it('retains the paid observation but does not map a cancelled evaluation into a decision', async () => {
    const controller = new AbortController()
    const evaluate = jevEvaluator({ evaluate: async () => rawResult })
    const map = vi.fn(() => ({ dimensions: { ready: 0.8 }, composite: 0.8, notes: '' }))
    const record = vi.fn(() => controller.abort())
    const judge = asJudge({
      name: 'ready',
      version: 'v1',
      dimensions: [{ key: 'ready', description: 'Readiness' }],
      evaluate: (_input: { artifact: string; scenario: typeof scenario }, context) =>
        evaluate({ model, state: null, questions: { ready: { type: 'noul' } } }, context),
      record,
      map,
    })
    await expect(
      judge.score({ artifact: 'answer', scenario, signal: controller.signal }),
    ).rejects.toThrow()
    expect(record).toHaveBeenCalledOnce()
    expect(map).not.toHaveBeenCalled()
  })
})

describe('retained native response metadata', () => {
  it('preserves provider metadata without a second product parser', () => {
    const raw = { ...rawResult, provenance: { revision: 'r1', evidence: ['e1'] } }
    const request = { model, state: null, questions: { ready: { type: 'noul' as const } } }
    expect(parseJevResult(raw, request)).toBe(raw)
    expect(JSON.parse(JSON.stringify(parseJevResult(raw, request)))).toEqual(raw)
  })
  it('rejects overflow in retained metadata rather than changing it to null', () => {
    const raw = { ...rawResult, providerMetadata: { limit: Infinity } }
    const request = { model, state: null, questions: { ready: { type: 'noul' as const } } }
    expect(() => parseJevResult(raw, request)).toThrow()
  })
})
