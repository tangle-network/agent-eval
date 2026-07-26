import { describe, expect, it } from 'vitest'
import { createChatClient } from '../src/analyst/chat-client'
import { coherenceJudge } from '../src/judges'

const noopChat = createChatClient({
  transport: 'mock',
  defaultModel: 'gpt-4o',
  handler: async () => ({
    content: '[]',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costUsd: null,
    model: 'gpt-4o',
    durationMs: 0,
    raw: {},
  }),
})

const baseScenario = {
  thesis: 'test',
  persona: 'p',
  firstMessage: 'hi',
  turns: [],
  expectedOutcome: '',
}
const turn = (userMessage: string, agentResponse: string) => ({
  userMessage,
  agentResponse,
  latencyMs: 0,
})

describe('coherenceJudge', () => {
  it('emits no judge scores for single-turn scenarios (regression)', async () => {
    // Pre-fix bug: returned a hardcoded 5/10 for single-turn scenarios,
    // pinning the coherence dimension to a non-signal value that still
    // folded into the aggregate. Result: every single-turn scenario was
    // implicitly penalized to a 5/10 ceiling on coherence.
    const out = await coherenceJudge(noopChat, {
      scenario: baseScenario as never,
      turns: [turn('hello', 'hi there')],
    })
    expect(out).toEqual([])
  })

  it('still emits no scores for empty-turn cases', async () => {
    const out = await coherenceJudge(noopChat, { scenario: baseScenario as never, turns: [] })
    expect(out).toEqual([])
  })
})
