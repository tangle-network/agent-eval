import { describe, expect, it, vi } from 'vitest'
import { CostLedger } from '../src/cost-ledger'
import { jevJudge, runJevDecision } from '../src/analyst/jev'
import { parseJevResponse, validateJevRequest, type JevRequest } from '../src/analyst/jev-protocol'

const model = 'jev-1.13.0'
const request: JevRequest = {
  model, state: 'Observed output',
  questions: { quality: { type: 'score', instructions: 'How well did it meet the requirements?', criteria: ['Missing', 'Partial', 'Complete'] } },
}
function response() {
  return { model, usage: { input_tokens: 100, output_tokens: 5 }, answers: {
    quality: { type: 'score', score: 1.6, legend: { '0': 'Missing', '1': 'Partial', '2': 'Complete' }, probabilities: { '0': 0.05, '1': 0.3, '2': 0.65 }, confidence: 0.78 },
  } }
}

describe('Jev native protocol', () => {
  it('preserves score distributions and usage', () => {
    expect(parseJevResponse(response(), request).answers.quality).toEqual(response().answers.quality)
  })
  it.each([
    ['missing answer', (x: ReturnType<typeof response>) => { x.answers = {} as typeof x.answers }],
    ['missing usage', (x: ReturnType<typeof response>) => { delete (x as { usage?: unknown }).usage }],
    ['invalid probability mass', (x: ReturnType<typeof response>) => { x.answers.quality.probabilities['0'] = 0.8 }],
    ['incorrect expectation', (x: ReturnType<typeof response>) => { x.answers.quality.score = 0.2 }],
    ['changed rubric', (x: ReturnType<typeof response>) => { x.answers.quality.legend['0'] = 'Excellent' }],
    ['wrong model', (x: ReturnType<typeof response>) => { x.model = 'jev-99.0.0' }],
    ['invalid confidence', (x: ReturnType<typeof response>) => { x.answers.quality.confidence = NaN }],
    ['invalid tokens', (x: ReturnType<typeof response>) => { x.usage.input_tokens = -1 }],
  ])('rejects %s', (_name, mutate) => {
    const raw = response(); mutate(raw)
    expect(() => parseJevResponse(raw, request)).toThrow()
  })
  it('rejects malformed questions before dispatch', () => {
    expect(() => validateJevRequest({ ...request, questions: { quality: { type: 'score', instructions: 'Rate', criteria: ['Only'] } } })).toThrow()
  })
  it('allows alias resolution for non-judge decisions', () => {
    expect(parseJevResponse(response(), { ...request, model: 'jev-latest' }).model).toBe(model)
  })
  it('rejects missing/unknown choice options and accepts literal special keys', () => {
    const input: JevRequest = { model, state: '', questions: { route: { type: 'choice', instructions: 'Pick', criteria: JSON.parse('{"__proto__":null,"normal":null}') } } }
    const raw = { model, usage: { input_tokens: 1, output_tokens: 0 }, answers: { route: { type: 'choice', choice: '__proto__', confidence: 0.7, probabilities: JSON.parse('{"__proto__":0.8,"normal":0.2}') } } }
    expect(parseJevResponse(raw, input).answers.route.type).toBe('choice')
    raw.answers.route.choice = 'invented'
    expect(() => parseJevResponse(raw, input)).toThrow()
  })
})

describe('Jev paid evaluation', () => {
  it('records tokens even when answer validation fails', async () => {
    const costLedger = new CostLedger()
    const raw = response(); raw.answers.quality.score = 90
    const evaluate = vi.fn(async () => raw)
    await expect(runJevDecision(request, { evaluate, actor: 'judge', costLedger })).rejects.toThrow()
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(costLedger.summary().inputTokens).toBe(100)
    expect(costLedger.summary().totalCalls).toBe(1)
  })
  it('never converts absent usage into known zero tokens', async () => {
    const costLedger = new CostLedger()
    const raw = response(); delete (raw as { usage?: unknown }).usage
    await expect(runJevDecision(request, { evaluate: async () => raw, actor: 'judge', costLedger })).rejects.toThrow()
    expect(costLedger.summary().usageComplete).toBe(false)
  })
  it('does not dispatch when already cancelled', async () => {
    const controller = new AbortController(); controller.abort()
    const evaluate = vi.fn(async () => response())
    await expect(runJevDecision(request, { evaluate, actor: 'judge', costLedger: new CostLedger(), signal: controller.signal })).rejects.toThrow()
    expect(evaluate).not.toHaveBeenCalled()
  })
  it('does not let a transport mutate the rubric being validated', async () => {
    const evaluate = vi.fn(async (sent: JevRequest) => {
      sent.model = 'jev-99.0.0'
      const raw = response(); raw.model = sent.model
      return raw
    })
    await expect(runJevDecision(request, { evaluate, actor: 'judge', costLedger: new CostLedger() })).rejects.toThrow('pinned model')
    expect(request.model).toBe(model)
  })
  it('normalizes ordered scores using the existing campaign contract', async () => {
    const judge = jevJudge('quality', {
      model, judgeVersion: 'quality/v1', evaluate: async () => response(),
      questions: { quality: { type: 'score', instructions: 'Rate', criteria: ['Missing', 'Partial', 'Complete'] } },
      renderState: ({ artifact }) => String(artifact),
    })
    const score = await judge.score({ artifact: 'answer', scenario: { id: 'one', kind: 'test' }, signal: new AbortController().signal })
    expect(score.composite).toBeCloseTo(0.8)
    expect(score.distribution?.quality).toEqual([{ score: 0, probability: 0.05 }, { score: 0.5, probability: 0.3 }, { score: 1, probability: 0.65 }])
  })
  it('requires a pinned model for judge caching', () => {
    expect(() => jevJudge('quality', { model: 'jev-latest', judgeVersion: 'v1', evaluate: async () => response(), questions: {}, renderState: () => '' })).toThrow('Pin')
  })
})
