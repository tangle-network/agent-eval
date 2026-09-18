import { describe, expect, it, vi } from 'vitest'
import { CostLedger } from '../src/cost-ledger'
import { jevAnalyst, jevJudge, parseJevResult, type JevRequest, type JevResult } from '../src/jev'

const request: JevRequest = {
  model: 'jev-1.13.0', state: 'observed artifact',
  questions: {
    quality: { type: 'score', instructions: 'Rate quality', criteria: ['missing', 'partial', 'complete'] },
    supported: { type: 'noul', instructions: 'Supported by the evidence?' },
  },
}
const response = (): JevResult => ({
  model: request.model,
  answers: {
    quality: { type: 'score', score: 1.5, confidence: 0.4, legend: { 0: 'missing', 1: 'partial', 2: 'complete' }, probabilities: { 0: 0, 1: 0.5, 2: 0.5 } },
    supported: { type: 'noul', noul: 0.5 },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
})
const signal = () => new AbortController().signal
const config = () => ({
  evaluate: vi.fn(async () => response()), model: request.model, questions: structuredClone(request.questions),
  version: 'rubric-v1', renderState: ({ artifact }: { artifact: string }) => artifact,
  pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 0 },
})

describe('Jev native adapter', () => {
  it('preserves the native answer distributions', () => {
    const raw = response()
    expect(parseJevResult(raw, request)).toBe(raw)
  })
  it.each([
    ['missing answer', (raw: JevResult) => { delete raw.answers.supported }],
    ['extra answer', (raw: JevResult) => { raw.answers.extra = { type: 'noul', noul: 1 } }],
    ['model mismatch', (raw: JevResult) => { raw.model = 'another-model' }],
    ['negative tokens', (raw: JevResult) => { raw.usage.input_tokens = -1 }],
    ['missing usage', (raw: JevResult) => { Reflect.deleteProperty(raw, 'usage') }],
    ['invalid probability', (raw: JevResult) => { raw.answers.supported = { type: 'noul', noul: Number.NaN } }],
    ['wrong answer kind', (raw: JevResult) => { raw.answers.quality = { type: 'noul', noul: 1 } }],
  ])('rejects %s', (_name, mutate) => {
    const raw = response()
    mutate(raw)
    expect(() => parseJevResult(raw, request)).toThrow()
  })
  it('refuses missing probability levels and fabricated score expectations', () => {
    const raw = response()
    if (raw.answers.quality.type !== 'score') throw new Error('fixture')
    raw.answers.quality.score = 2
    expect(() => parseJevResult(raw, request)).toThrow(/distribution/)
    raw.answers.quality.score = 1.5
    delete raw.answers.quality.probabilities['0']
    expect(() => parseJevResult(raw, request)).toThrow(/request/)
  })
  it('normalizes rubric expectations and uses canonical weighted reduction', async () => {
    const opts = config()
    const ledger = new CostLedger()
    const judge = jevJudge('quality', { ...opts, weights: { quality: 3, supported: 1 } })
    const score = await judge.score({ artifact: 'answer', scenario: { id: 'one', kind: 'test' }, signal: signal(), costLedger: ledger })
    expect(score.dimensions).toEqual({ quality: 0.75, supported: 0.5 })
    expect(score.composite).toBe(0.6875)
    expect(score.scoringMethod).toBe('expectation')
    expect(score.distribution?.quality).toEqual([{ score: 0, probability: 0 }, { score: 0.5, probability: 0.5 }, { score: 1, probability: 0.5 }])
    expect(score.llmCall?.usage.promptTokens).toBe(100)
    expect(opts.evaluate.mock.calls).toHaveLength(1)
  })
  it('forwards cancellation and paid-call identity', async () => {
    let context: { signal: AbortSignal; idempotencyKey: string } | undefined
    const judge = jevJudge('quality', { ...config(), evaluate: async (_request, ctx) => { context = ctx; return response() } })
    await judge.score({ artifact: 'answer', scenario: { id: 'one', kind: 'test' }, signal: signal() })
    expect(context?.signal).toBeInstanceOf(AbortSignal)
    expect(context?.idempotencyKey).toBeTruthy()
  })
  it('does not dispatch an already-cancelled call', async () => {
    const opts = config()
    const controller = new AbortController()
    controller.abort()
    await expect(jevJudge('quality', opts).score({ artifact: 'answer', scenario: { id: 'one', kind: 'test' }, signal: controller.signal })).rejects.toThrow()
    expect(opts.evaluate).not.toHaveBeenCalled()
  })
  it('snapshots the rubric and versions rubric changes', () => {
    const opts = config()
    const first = jevJudge('quality', opts)
    opts.questions.supported.instructions = 'Different question'
    expect(jevJudge('quality', opts).judgeVersion).not.toBe(first.judgeVersion)
  })
  it('does not pretend choices are ordered numeric grades', () => {
    expect(() => jevJudge('route', { ...config(), questions: { route: { type: 'choice', instructions: 'Choose', criteria: { a: null, b: null } } } })).toThrow(/ordering/)
  })
  it('reports analyst usage even when there are no findings', async () => {
    const recordUsage = vi.fn()
    const analyst = jevAnalyst<string>({ ...config(), id: 'triage', description: 'Bounded trace triage', inputKind: 'custom', renderState: (input) => input, findings: () => [] })
    expect(await analyst.analyze('trace', { runId: 'r', correlationId: 'c', recordUsage })).toEqual([])
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ calls: 1, tokens: { input: 100, output: 10 }, cost: { kind: 'estimated', usd: 0.0001 } }))
  })
  it('reports paid usage before rejecting malformed analyst answers', async () => {
    const recordUsage = vi.fn()
    const raw = response()
    delete raw.answers.supported
    const analyst = jevAnalyst<string>({ ...config(), evaluate: async () => raw, id: 'triage', description: 'Bounded trace triage', inputKind: 'custom', renderState: (input) => input, findings: () => [] })
    await expect(analyst.analyze('trace', { runId: 'r', correlationId: 'c', recordUsage })).rejects.toThrow()
    expect(recordUsage).toHaveBeenCalledOnce()
  })
  it('refuses an expired analyst deadline before rendering or inference', async () => {
    const opts = config()
    const renderState = vi.fn(() => 'trace')
    const analyst = jevAnalyst<string>({ ...opts, id: 'triage', description: 'Bounded trace triage', inputKind: 'custom', renderState, findings: () => [] })
    await expect(analyst.analyze('trace', { runId: 'r', correlationId: 'c', deadlineMs: 0 })).rejects.toThrow(/deadline/)
    expect(renderState).not.toHaveBeenCalled()
    expect(opts.evaluate).not.toHaveBeenCalled()
  })
})
