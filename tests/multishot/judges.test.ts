import { describe, expect, it, vi } from 'vitest'
import {
  type JudgeConfig,
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
        },
      },
    ]) as unknown as typeof fetch

    const score = await runJudge(JUDGE, { text: 'test transcript' })
    expect(score.dimensions.quality).toBe(8)
    expect(score.dimensions.specificity).toBe(6)
    expect(score.composite).toBe(7)
    expect(score.notes).toBe('good but vague at the end')
    global.fetch = original
  })

  it('clamps out-of-range values + defaults missing to 0', async () => {
    const original = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = stubFetch([
      { body: { choices: [{ message: { content: '{"quality":15}' } }] } },
    ]) as unknown as typeof fetch

    const score = await runJudge(JUDGE, { text: 'x' })
    expect(score.dimensions.quality).toBe(10) // clamped from 15
    expect(score.dimensions.specificity).toBe(0) // missing → 0
    expect(score.composite).toBe(5)
    global.fetch = original
  })

  it('returns zero score with parse-failure note on non-JSON reply', async () => {
    const original = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = stubFetch([
      { body: { choices: [{ message: { content: 'I cannot output JSON because reasons' } }] } },
    ]) as unknown as typeof fetch

    const score = await runJudge(JUDGE, { text: 'x' })
    expect(score.composite).toBe(0)
    expect(score.notes).toMatch(/non-JSON/)
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

    const score = await runJudge(JUDGE, { text: 'x' })
    expect(score.dimensions.quality).toBe(7)
    expect(score.composite).toBe(6)
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
