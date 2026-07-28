import { describe, expect, it, vi } from 'vitest'
import {
  computeCellComposite,
  type JudgeConfig,
  type JudgeScore as JudgeScoreShape,
  renderDimensions,
  renderJsonFooter,
  runJudge,
} from '../../src/multishot/index'

const DIMS = [
  { key: 'quality', description: 'overall quality 0-10' },
  { key: 'specificity', description: 'concrete vs vague 0-10' },
] as const

const JUDGE: JudgeConfig<{ text: string }> = {
  name: 'test-judge',
  dimensions: [...DIMS],
  systemPrompt: 'You are a strict judge. JSON only.',
  buildPrompt: ({ text }) => `Score:\n${text}\n${renderJsonFooter(DIMS)}`,
}

function stubFetch(responses: Array<{ ok?: boolean; body: unknown }>) {
  let i = 0
  return vi.fn(async () => {
    const r = responses[i++]
    if (!r) throw new Error('stub exhausted')
    return {
      ok: r.ok ?? true,
      status: 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response
  })
}

describe('runJudge', () => {
  it('parses dimensions + composite + notes', async () => {
    const original = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = stubFetch([
      {
        body: {
          choices: [
            {
              message: {
                content: '{"quality":8,"specificity":6,"notes":"good but vague at the end"}',
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          _response_cost: 0.0123,
        },
      },
    ]) as unknown as typeof fetch

    const { score, cost } = await runJudge(JUDGE, { text: 'test transcript' })
    expect(score.dimensions.quality).toBe(8)
    expect(score.dimensions.specificity).toBe(6)
    expect(score.composite).toBe(7)
    expect(score.notes).toBe('good but vague at the end')
    expect(score.llmCall).toMatchObject({
      costUsd: 0.0123,
      model: 'openai/gpt-4o-mini',
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        captured: true,
      },
    })
    expect(cost).toEqual({ kind: 'observed', usd: 0.0123 })
    global.fetch = original
  })

  it('clamps out-of-range values + defaults missing to 0', async () => {
    const original = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = stubFetch([
      { body: { choices: [{ message: { content: '{"quality":15}' } }] } },
    ]) as unknown as typeof fetch

    const { score } = await runJudge(JUDGE, { text: 'x' })
    expect(score.dimensions.quality).toBe(10) // clamped from 15
    expect(score.dimensions.specificity).toBe(0) // missing → 0
    expect(score.composite).toBe(5)
    global.fetch = original
  })

  it('marks non-JSON replies as failed (additive) with parse-failure note', async () => {
    const original = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = stubFetch([
      {
        body: {
          choices: [{ message: { content: 'I cannot output JSON because reasons' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        },
      },
    ]) as unknown as typeof fetch

    const { score, cost } = await runJudge(JUDGE, { text: 'x' })
    expect(score.composite).toBe(0)
    expect(score.notes).toMatch(/non-JSON/)
    // failed:true lets aggregators exclude this score instead of meaning a zero.
    expect(score.failed).toBe(true)
    expect(score.llmCall).toMatchObject({
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        captured: true,
      },
    })
    expect(score.llmCall?.costUsd).toBeNull()
    expect(cost.kind).toBe('estimated')
    expect(cost.usd).toBeCloseTo(0.000045, 10)
    global.fetch = original
  })

  it('reports uncaptured usage and unknown cost instead of a zero', async () => {
    const original = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = stubFetch([
      {
        body: {
          choices: [{ message: { content: '{"quality":8,"specificity":6}' } }],
        },
      },
    ]) as unknown as typeof fetch

    const { score, cost } = await runJudge(JUDGE, { text: 'x' })
    expect(score.llmCall).toMatchObject({
      costUsd: null,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        captured: false,
      },
    })
    expect(cost).toEqual({ kind: 'uncaptured', usd: null })
    global.fetch = original
  })

  it('preserves a failed score and uncaptured cost when the provider call fails', async () => {
    const original = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = stubFetch([
      { ok: false, body: { error: 'unavailable' } },
    ]) as unknown as typeof fetch

    const { score, cost } = await runJudge(JUDGE, { text: 'x' })
    expect(score).toMatchObject({
      composite: 0,
      failed: true,
      llmCall: {
        costUsd: null,
        usage: { captured: false },
      },
    })
    expect(score.notes).toMatch(/call failed/)
    expect(cost).toEqual({ kind: 'uncaptured', usd: null })
    global.fetch = original
  })

  it('strips ```json fences before parsing', async () => {
    const original = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = stubFetch([
      {
        body: {
          choices: [{ message: { content: '```json\n{"quality":7,"specificity":5}\n```' } }],
        },
      },
    ]) as unknown as typeof fetch

    const { score } = await runJudge(JUDGE, { text: 'x' })
    expect(score.dimensions.quality).toBe(7)
    expect(score.composite).toBe(6)
    global.fetch = original
  })

  it('uses configured max token budget for judge calls', async () => {
    const original = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    const fetchStub = stubFetch([
      { body: { choices: [{ message: { content: '{"quality":8,"specificity":8}' } }] } },
    ])
    global.fetch = fetchStub as unknown as typeof fetch

    await runJudge({ ...JUDGE, maxTokens: 321 }, { text: 'x' })

    const body = JSON.parse(String(fetchStub.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect(body.max_tokens).toBe(321)

    global.fetch = original
  })
})

describe('helpers', () => {
  it('renderDimensions emits one line per dim', () => {
    const txt = renderDimensions(DIMS)
    expect(txt.split('\n')).toHaveLength(2)
    expect(txt).toContain('- quality:')
    expect(txt).toContain('- specificity:')
  })

  it('renderJsonFooter includes every dim key + notes', () => {
    const footer = renderJsonFooter(DIMS)
    expect(footer).toContain('"quality":N')
    expect(footer).toContain('"specificity":N')
    expect(footer).toContain('"notes"')
  })
})

describe('computeCellComposite — failed-score exclusion', () => {
  const ok = (composite: number): JudgeScoreShape => ({
    dimensions: {},
    composite,
    notes: 'ok',
  })
  const failed = (): JudgeScoreShape => ({
    dimensions: {},
    composite: 0,
    notes: 'judge call failed',
    failed: true,
  })

  it('means over configured slots when nothing failed', () => {
    const cell = computeCellComposite({
      conversation: ok(8),
      codeReviews: [ok(6), ok(4)],
    })
    // (8 + mean(6,4)) / 2 = 6.5
    expect(cell.composite).toBeCloseTo(6.5, 5)
    expect(cell.codeComposite).toBeCloseTo(5, 5)
    expect(cell.allJudgesFailed).toBe(false)
  })

  it('excludes failed scores from a slot mean instead of zeroing it', () => {
    const cell = computeCellComposite({
      conversation: ok(8),
      codeReviews: [ok(6), failed()],
    })
    // code slot = mean over the ONE live review, not (6+0)/2
    expect(cell.codeComposite).toBeCloseTo(6, 5)
    expect(cell.composite).toBeCloseTo(7, 5)
  })

  it('drops an all-failed slot from the cell mean entirely', () => {
    const cell = computeCellComposite({
      conversation: ok(8),
      codeReviews: [failed(), failed()],
    })
    // No code signal → composite is the conversation alone, not dragged to 4.
    expect(cell.composite).toBeCloseTo(8, 5)
    expect(cell.allJudgesFailed).toBe(false)
  })

  it('drops a failed conversation judge from the mean', () => {
    const cell = computeCellComposite({
      conversation: failed(),
      contentReviews: [ok(6)],
    })
    expect(cell.composite).toBeCloseTo(6, 5)
  })

  it('flags allJudgesFailed when every configured slot failed', () => {
    const cell = computeCellComposite({
      conversation: failed(),
      codeReviews: [failed()],
    })
    expect(cell.composite).toBe(0)
    expect(cell.allJudgesFailed).toBe(true)
  })

  it('an empty configured slot still contributes 0 (long-standing semantics)', () => {
    const cell = computeCellComposite({
      conversation: ok(8),
      codeReviews: [],
    })
    expect(cell.composite).toBeCloseTo(4, 5)
  })
})
