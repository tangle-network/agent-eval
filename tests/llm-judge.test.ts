import { describe, expect, it } from 'vitest'
import { type ChatRequest, createChatClient } from '../src/analyst/chat-client'
import type { Scenario } from '../src/campaign/types'
import { JudgeParseError } from '../src/judges'
import { llmJudge } from '../src/llm-judge'

/** A mock ChatClient whose handler returns a fixed model response. The handler
 *  also records the requests it saw, so a test can assert what the judge sent. */
function mockChat(reply: string | ((req: ChatRequest) => string), defaultModel = 'mock-model') {
  const seen: ChatRequest[] = []
  const client = createChatClient({
    transport: 'mock',
    defaultModel,
    handler: async (req) => {
      seen.push(req)
      const content = typeof reply === 'function' ? reply(req) : reply
      return {
        content,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: null,
        model: req.model ?? defaultModel,
        durationMs: 0,
        raw: {},
      }
    },
  })
  return { client, seen }
}

const scenario: Scenario = { id: 's1', kind: 'task' }
const artifact = { answer: 'the agent did the thing' }

describe('llmJudge — single-call canonical bridge', () => {
  it('returns a well-formed canonical JudgeScore (composite in [0,1], dimensions present)', async () => {
    const { client } = mockChat(
      JSON.stringify({
        dimensions: { accuracy: 0.8, depth: 0.6 },
        notes: 'solid',
      }),
    )
    const judge = llmJudge('rubric', 'You are a strict reviewer.', {
      chat: client,
      dimensions: ['accuracy', 'depth'],
    })

    const score = await judge.score({ artifact, scenario, signal: new AbortController().signal })

    // dimensions map present + every declared key scored
    expect(score.dimensions).toBeTypeOf('object')
    expect(Object.keys(score.dimensions).sort()).toEqual(['accuracy', 'depth'])
    expect(score.dimensions.accuracy).toBeCloseTo(0.8)
    expect(score.dimensions.depth).toBeCloseTo(0.6)
    // composite is the uniform mean, in range
    expect(score.composite).toBeGreaterThanOrEqual(0)
    expect(score.composite).toBeLessThanOrEqual(1)
    expect(score.composite).toBeCloseTo(0.7)
    // notes is a non-empty string carried from the model
    expect(score.notes).toBe('solid')
    // JudgeConfig metadata is well-formed
    expect(judge.name).toBe('rubric')
    expect(judge.dimensions.map((d) => d.key)).toEqual(['accuracy', 'depth'])
  })

  it('defaults to a single `quality` dimension when none are declared', async () => {
    const { client } = mockChat(JSON.stringify({ dimensions: { quality: 0.5 } }))
    const judge = llmJudge('q', 'rate it', { chat: client })
    const score = await judge.score({ artifact, scenario, signal: new AbortController().signal })
    expect(score.dimensions).toEqual({ quality: 0.5 })
    expect(score.composite).toBeCloseTo(0.5)
    expect(score.notes).toContain('q:')
  })

  it("normalizes a 0-10 model scale into [0,1] when scale is 'ten'", async () => {
    const { client } = mockChat(JSON.stringify({ dimensions: { accuracy: 8, depth: 6 } }))
    const judge = llmJudge('ten', 'rate it', {
      chat: client,
      dimensions: ['accuracy', 'depth'],
      scale: 'ten',
    })
    const score = await judge.score({ artifact, scenario, signal: new AbortController().signal })
    expect(score.dimensions.accuracy).toBeCloseTo(0.8)
    expect(score.dimensions.depth).toBeCloseTo(0.6)
    expect(score.composite).toBeCloseTo(0.7)
  })

  it('clamps out-of-range scores into [0,1] rather than emitting > 1', async () => {
    const { client } = mockChat(JSON.stringify({ dimensions: { quality: 1.7 } }))
    const judge = llmJudge('clamp', 'rate it', { chat: client, dimensions: ['quality'] })
    const score = await judge.score({ artifact, scenario, signal: new AbortController().signal })
    expect(score.dimensions.quality).toBe(1)
    expect(score.composite).toBe(1)
  })

  it('honors a partial weights map (selects + weights named dimensions)', async () => {
    const { client } = mockChat(JSON.stringify({ dimensions: { accuracy: 1, depth: 0 } }))
    const judge = llmJudge('weighted', 'rate it', {
      chat: client,
      dimensions: ['accuracy', 'depth'],
      weights: { accuracy: 3, depth: 1 },
    })
    const score = await judge.score({ artifact, scenario, signal: new AbortController().signal })
    // weighted mean = (1*3 + 0*1) / (3+1) = 0.75
    expect(score.composite).toBeCloseTo(0.75)
  })

  it('reads fenced JSON (```json … ```) the model wraps around its answer', async () => {
    const { client } = mockChat('```json\n{"dimensions": {"quality": 0.4}}\n```')
    const judge = llmJudge('fenced', 'rate it', { chat: client, dimensions: ['quality'] })
    const score = await judge.score({ artifact, scenario, signal: new AbortController().signal })
    expect(score.dimensions.quality).toBeCloseTo(0.4)
  })

  it('makes exactly ONE model call carrying the prompt as the system message', async () => {
    const { client, seen } = mockChat(JSON.stringify({ dimensions: { quality: 0.5 } }))
    const judge = llmJudge('one-call', 'JUDGE-PROMPT-MARKER', {
      chat: client,
      dimensions: ['quality'],
    })
    await judge.score({ artifact, scenario, signal: new AbortController().signal })
    expect(seen).toHaveLength(1)
    const sys = seen[0]?.messages.find((m) => m.role === 'system')
    expect(sys?.content).toContain('JUDGE-PROMPT-MARKER')
    expect(seen[0]?.model).toBe('mock-model')
  })

  it('throws JudgeParseError on an unparseable model response (fail-loud, no silent zero)', async () => {
    const { client } = mockChat('not json at all')
    const judge = llmJudge('bad', 'rate it', { chat: client, dimensions: ['quality'] })
    await expect(
      judge.score({ artifact, scenario, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(JudgeParseError)
  })

  it('throws when a declared dimension is missing from the response', async () => {
    const { client } = mockChat(JSON.stringify({ dimensions: { accuracy: 0.8 } }))
    const judge = llmJudge('missing', 'rate it', {
      chat: client,
      dimensions: ['accuracy', 'depth'],
    })
    await expect(
      judge.score({ artifact, scenario, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(JudgeParseError)
  })

  it('forwards appliesTo to the JudgeConfig', () => {
    const { client } = mockChat(JSON.stringify({ dimensions: { quality: 1 } }))
    const judge = llmJudge('scoped', 'rate it', {
      chat: client,
      dimensions: ['quality'],
      appliesTo: (s) => s.kind === 'task',
    })
    expect(judge.appliesTo?.({ id: 'x', kind: 'task' })).toBe(true)
    expect(judge.appliesTo?.({ id: 'y', kind: 'other' })).toBe(false)
  })

  it('throws at construction when no model and no defaultModel resolve', () => {
    const { client } = mockChat(JSON.stringify({ dimensions: { quality: 1 } }), '')
    expect(() =>
      llmJudge('no-model', 'rate it', { chat: client, dimensions: ['quality'] }),
    ).toThrow(/no model/i)
  })

  it('rejects a weights map that names an undeclared dimension', () => {
    const { client } = mockChat(JSON.stringify({ dimensions: { quality: 1 } }))
    expect(() =>
      llmJudge('bad-weights', 'rate it', {
        chat: client,
        dimensions: ['quality'],
        weights: { nonexistent: 1 },
      }),
    ).toThrow(/not declared/i)
  })
})
