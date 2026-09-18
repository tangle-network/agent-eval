import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  asAnalyst,
  asJudge,
  createEvaluator,
  jevAnalyst,
  jevEvaluator,
  jevJudge,
  parseJevRequest,
  parseJevResult,
} from '../src/jev'
import type { JevQuestions, JevRequest } from '../src/jev'

const model = 'jev-test'
const scenario = { id: 'one', kind: 'test' }
const signal = () => new AbortController().signal
const questions = {
  quality: { type: 'score', criteria: [null, { evidence: ['complete'], weight: 1 }] },
  route: { type: 'choice', instructions: null, criteria: { inspect: null, finish: { required: true } } },
  supported: { type: 'noul', criteria: { true: { evidence: ['verified'] }, false: null } },
} satisfies JevQuestions

function response(request: JevRequest) {
  const answers: Record<string, unknown> = {}
  for (const [name, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') {
      answers[name] = { type: 'noul', noul: 0.75 }
    } else {
      const levels = question.type === 'score'
        ? question.criteria.map((_, index) => String(index))
        : Object.keys(question.criteria)
      const last = levels.at(-1)
      answers[name] = {
        type: question.type,
        confidence: 1,
        probabilities: Object.fromEntries(levels.map((level) => [level, level === last ? 1 : 0])),
        ...(question.type === 'score'
          ? { score: levels.length - 1, legend: Object.fromEntries(question.criteria.map((value, index) => [index, structuredClone(value)])) }
          : { choice: last }),
      }
    }
  }
  return { model: request.model, answers, usage: { input_tokens: 100, output_tokens: 10 } }
}

const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 0 }
function fixture() {
  const execute = vi.fn(async (request: JevRequest) => response(request))
  return { execute, evaluate: jevEvaluator({ evaluate: execute, pricing }) }
}

describe('native question contract', () => {
  it('accepts caller JSON, structured criteria, null entries, and omitted instructions', () => {
    const request = { model, state: null, questions }
    expect(parseJevRequest(request)).toBe(request)
    const raw = response(request)
    expect(parseJevResult(raw, request)).toBe(raw)
  })

  it('preserves exact answer names and choice labels', async () => {
    const { evaluate } = fixture()
    const result = await evaluate({ model, state: { task: 'test' }, questions })
    expectTypeOf(result.value.answers.route.choice).toEqualTypeOf<'inspect' | 'finish'>()
    expectTypeOf(result.value.answers.route.probabilities.finish).toEqualTypeOf<number>()
    expectTypeOf(result.value.answers.supported.noul).toEqualTypeOf<number>()
    expect(result.value.answers.route.choice).toBe('finish')
    expect(result.value.answers.quality.legend['1']).toEqual({ evidence: ['complete'], weight: 1 })
  })

  it('lets each call supply a different question set', async () => {
    const { execute, evaluate } = fixture()
    await evaluate({ model, state: null, questions })
    const second = await evaluate({ model, state: 'next', questions: { ready: { type: 'noul' } } })
    expect(Object.keys(second.value.answers)).toEqual(['ready'])
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('compares structured rubric values, not object identity or key order', () => {
    const request = { model, state: null, questions }
    const raw = response(request)
    raw.answers.quality = {
      type: 'score', score: 1, confidence: 1,
      legend: { 0: null, 1: { weight: 1, evidence: ['complete'] } },
      probabilities: { 0: 0, 1: 1 },
    }
    expect(() => parseJevResult(raw, request)).not.toThrow()
  })

  it.each([
    { model, questions },
    { model, state: true, questions },
    { model, state: null, questions: {} },
    { model, state: null, questions: { q: { type: 'score', criteria: ['one'] } } },
    { model, state: null, questions: { q: { type: 'choice', criteria: {} } } },
  ])('rejects invalid native requests', (request) => {
    expect(() => parseJevRequest(request)).toThrow()
  })

  it('retains reported model identity without guessing alias syntax', async () => {
    const evaluate = jevEvaluator({ evaluate: async (request) => ({ ...response(request), model: 'resolved-version' }) })
    expect((await evaluate({ model: 'deployment-alias', state: null, questions })).value.model).toBe('resolved-version')
    const pinned = jevEvaluator({
      evaluate: async (request) => ({ ...response(request), model: 'different' }),
      acceptModel: (requested, served) => requested === served,
    })
    await expect(pinned({ model, state: null, questions })).rejects.toThrow(/caller policy/)
  })

  it('refuses missing answers, invalid usage, and inconsistent distributions', () => {
    const request = { model, state: null, questions }
    expect(() => parseJevResult({ ...response(request), answers: {} }, request)).toThrow()
    expect(() => parseJevResult({ ...response(request), usage: {} }, request)).toThrow()
    const raw = response(request)
    raw.answers.supported = { type: 'noul', noul: Number.NaN }
    expect(() => parseJevResult(raw, request)).toThrow()
  })
})

describe('reusable evaluation and interpretation', () => {
  it('supports a non-Jev classifier without inventing Jev-shaped outputs', async () => {
    const evaluate = createEvaluator({
      execute: async (text: string) => ({ label: text.length ? 'present' : 'empty' }),
      receipt: () => ({ model: 'local-classifier', inputTokens: 0, outputTokens: 0, actualCostUsd: 0 }),
    })
    expect((await evaluate('hello')).value).toEqual({ label: 'present' })
  })

  it('records the full observation before mapping to a product-specific judge score', async () => {
    const { evaluate, execute } = fixture()
    const order: string[] = []
    const judge = asJudge({
      name: 'caller-policy', version: 'v1',
      dimensions: [{ key: 'utility', description: 'Caller-defined utility' }],
      evaluate: (input: { artifact: string; scenario: typeof scenario }, context) =>
        evaluate({ model, state: input.artifact, questions }, context),
      record: (result) => {
        expect(result.value.answers.route.probabilities.finish).toBe(1)
        expect(result.receipt.costUnknown).toBe(false)
        order.push('record')
      },
      map: (value) => {
        order.push('map')
        return { dimensions: { utility: value.answers.route.probabilities.finish * 10 }, composite: 10, notes: '' }
      },
    })
    const result = await judge.score({ artifact: 'answer', scenario, signal: signal() })
    expect(result.dimensions.utility).toBe(10)
    expect(result.notes).toBe('')
    expect(order).toEqual(['record', 'map'])
    expect(execute).toHaveBeenCalledOnce()
  })

  it('supports choices in a judge when the caller supplies the utility mapping', async () => {
    const judge = jevJudge('route', {
      model, version: 'v1', questions,
      // A custom map decides what the judge reports, and nothing in `questions` predicts it:
      // this map answers a question named `route` with a dimension named `ready`. Without the
      // declaration the judge would advertise `route` and emit `ready`, so jevJudge requires it.
      dimensions: [{ key: 'ready', description: 'Probability the route finishes' }],
      evaluate: async (request) => response(request),
      renderState: ({ artifact }: { artifact: string }) => artifact,
      map: (value) => ({ dimensions: { ready: value.answers.route.probabilities.finish }, composite: 1, notes: '' }),
    })
    expect((await judge.score({ artifact: 'answer', scenario, signal: signal() })).composite).toBe(1)
  })

  it('builds questions per scenario while keeping comparable output dimensions', async () => {
    const seen: JevRequest[] = []
    const judge = jevJudge('dynamic', {
      model, version: 'v1',
      dimensions: [{ key: 'supported', description: 'Evidence support' }],
      questions: ({ scenario: current }: { artifact: string; scenario: typeof scenario }) => ({
        supported: { type: 'noul' as const, instructions: { requirement: current.id } },
      }),
      renderState: ({ artifact }: { artifact: string }) => artifact,
      evaluate: async (request) => { seen.push(request); return response(request) },
    })
    await judge.score({ artifact: 'answer', scenario, signal: signal() })
    await judge.score({ artifact: 'answer', scenario: { ...scenario, id: 'two' }, signal: signal() })
    expect(seen[0]?.questions.supported?.instructions).toEqual({ requirement: 'one' })
    expect(seen[1]?.questions.supported?.instructions).toEqual({ requirement: 'two' })
  })

  it('allows analysts to produce no findings without erasing paid work', async () => {
    const recordUsage = vi.fn()
    const analyst = jevAnalyst<string>({
      id: 'trace', description: 'Caller-defined analysis', inputKind: 'custom',
      model, version: 'v1', questions, pricing,
      evaluate: async (request) => response(request),
      renderState: (input) => input, findings: () => [],
    })
    expect(await analyst.analyze('trace', { runId: 'r', correlationId: 'c', recordUsage })).toEqual([])
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ calls: 1, tokens: { input: 100, output: 10 } }))
  })

  it('makes the analyst adapter available to any typed evaluator', async () => {
    const run = createEvaluator({
      execute: async (input: string) => ({ length: input.length }),
      receipt: () => ({ model: 'local', inputTokens: 0, outputTokens: 0, actualCostUsd: 0 }),
    })
    const analyst = asAnalyst({
      id: 'local', version: 'v1', description: 'Local classifier', inputKind: 'custom',
      cost: { kind: 'deterministic' }, evaluate: run, map: () => [],
    })
    expect(await analyst.analyze('test', { runId: 'r', correlationId: 'c' })).toEqual([])
  })
})

describe('paid-call boundaries', () => {
  it('forwards cancellation and paid-call identity', async () => {
    const execute = vi.fn(async (request: JevRequest, context: { signal: AbortSignal; idempotencyKey: string }) => {
      expect(context.signal).toBeInstanceOf(AbortSignal)
      expect(context.idempotencyKey).toBeTruthy()
      return response(request)
    })
    await jevEvaluator({ evaluate: execute })({ model, state: null, questions }, { signal: signal() })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('does not dispatch an already cancelled call', async () => {
    const { execute, evaluate } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(evaluate({ model, state: null, questions }, { signal: controller.signal })).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('settles reported usage before rejecting malformed answers', async () => {
    const onReceipt = vi.fn()
    const evaluate = jevEvaluator({
      pricing, evaluate: async (request) => ({ ...response(request), answers: {} }),
    })
    await expect(evaluate({ model, state: null, questions }, { onReceipt })).rejects.toThrow()
    expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 100, outputTokens: 10, costUnknown: false }))
  })

  it('does not infer again when a result mapper fails', async () => {
    const { execute, evaluate } = fixture()
    const record = vi.fn()
    const judge = asJudge({
      name: 'broken-map', version: 'v1', dimensions: [],
      evaluate: (_input: { artifact: string; scenario: typeof scenario }, context) => evaluate({ model, state: null, questions }, context),
      record,
      map: () => { throw new Error('mapping failed') },
    })
    await expect(judge.score({ artifact: 'answer', scenario, signal: signal() })).rejects.toThrow('mapping failed')
    expect(record).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects an expired analyst before rendering state or inferring', async () => {
    const renderState = vi.fn(() => 'trace')
    const { execute } = fixture()
    const analyst = jevAnalyst<string>({
      id: 'trace', description: 'Review', inputKind: 'custom', model, version: 'v1',
      questions, evaluate: execute, renderState, findings: () => [],
    })
    await expect(analyst.analyze('trace', { runId: 'r', correlationId: 'c', deadlineMs: 0 })).rejects.toThrow(/deadline/)
    expect(renderState).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})
