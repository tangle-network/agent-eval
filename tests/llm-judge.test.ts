import { describe, expect, it } from 'vitest'
import { type ChatClient, type ChatRequest, createChatClient } from '../src/analyst/chat-client'
import type { Scenario } from '../src/campaign/types'

import { llmJudge } from '../src/llm-judge'

/** A mock ChatClient whose handler returns a fixed model response. The handler
 *  also records the requests it saw, so a test can assert what the judge sent. */

const scenario: Scenario = { id: 's1', kind: 'task' }
const artifact = { answer: 'the agent did the thing' }

/** Build a token stream for a judge answer whose grade token carries a
 *  probability window. Mirrors the OpenAI-compatible `logprobs.content`
 *  shape: one entry per emitted token, each with its alternatives. */
function judgeAnswerWithGradeWindow(
  key: string,
  grade: number,
  window: Array<{ score: number; probability: number }>,
) {
  const prefix = `{"dimensions": {"${key}": `
  const suffix = `}, "notes": "graded"}`
  return {
    content: `${prefix}${grade}${suffix}`,
    logprobs: [
      { token: prefix, logprob: 0, top: [] },
      {
        token: String(grade),
        logprob: Math.log(window.find((entry) => entry.score === grade)?.probability ?? 1),
        top: window.map((entry) => ({
          token: String(entry.score),
          logprob: Math.log(entry.probability),
        })),
      },
      { token: suffix, logprob: 0, top: [] },
    ],
  }
}

function logprobChat(
  answer: ReturnType<typeof judgeAnswerWithGradeWindow> | { content: string; logprobs: null },
) {
  const seen: ChatRequest[] = []
  const client = createChatClient({
    transport: 'mock',
    defaultModel: 'mock-model',
    handler: async (req) => {
      seen.push(req)
      return {
        content: answer.content,
        logprobs: answer.logprobs,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: null,
        model: req.model ?? 'mock-model',
        durationMs: 0,
        raw: {},
      }
    },
  })
  return { client, seen }
}

describe('llmJudge — logprob-expectation scoring', () => {
  const score = async (client: ChatClient, scoring?: Parameters<typeof llmJudge>[2]['scoring']) =>
    llmJudge('grader', 'grade it', {
      chat: client,
      dimensions: ['accuracy'],
      scale: 'ten',
      ...(scoring ? { scoring } : {}),
    }).score({ artifact, scenario, signal: new AbortController().signal })

  it('separates two candidates that tie on the sampled grade', async () => {
    // Both answers emit 8. The first model nearly meant 7, the second nearly
    // meant 9, and sampled scoring throws that ranking signal away.
    const weak = judgeAnswerWithGradeWindow('accuracy', 8, [
      { score: 7, probability: 0.45 },
      { score: 8, probability: 0.5 },
      { score: 9, probability: 0.05 },
    ])
    const strong = judgeAnswerWithGradeWindow('accuracy', 8, [
      { score: 7, probability: 0.05 },
      { score: 8, probability: 0.5 },
      { score: 9, probability: 0.45 },
    ])

    const sampledWeak = await score(logprobChat(weak).client)
    const sampledStrong = await score(logprobChat(strong).client)
    expect(sampledWeak.composite).toBe(sampledStrong.composite)

    const expectationScoring = { method: 'expectation' as const, whenUnavailable: 'fail' as const }
    const expectedWeak = await score(logprobChat(weak).client, expectationScoring)
    const expectedStrong = await score(logprobChat(strong).client, expectationScoring)
    expect(expectedWeak.composite).toBeLessThan(expectedStrong.composite)
    expect(expectedWeak.composite).toBeCloseTo(0.76, 10)
    expect(expectedStrong.composite).toBeCloseTo(0.84, 10)
    expect(expectedStrong.scoringMethod).toBe('expectation')
    expect(expectedStrong.distribution?.accuracy).toEqual([
      { score: 7, probability: 0.05 },
      { score: 8, probability: 0.5 },
      { score: 9, probability: 0.45 },
    ])
  })

  it('fails loud, or records the sampled grade, when the provider returns no logprobs', async () => {
    const answer = { content: '{"dimensions": {"accuracy": 8}}', logprobs: null }

    await expect(
      score(logprobChat(answer).client, { method: 'expectation', whenUnavailable: 'fail' }),
    ).rejects.toThrow(/expectation scoring is unavailable — the provider returned no logprobs/)

    const fellBack = await score(logprobChat(answer).client, {
      method: 'expectation',
      whenUnavailable: 'sampled',
    })
    expect(fellBack.composite).toBeCloseTo(0.8, 10)
    // The score reports what produced it, so a mixed run stays auditable.
    expect(fellBack.scoringMethod).toBe('sampled')
    expect(fellBack.distribution).toBeUndefined()
  })

  it('refuses a grade that did not land in one token instead of approximating it', async () => {
    // A two-token "10" has no single position carrying its distribution.
    const split = {
      content: '{"dimensions": {"accuracy": 10}, "notes": "graded"}',
      logprobs: [
        { token: '{"dimensions": {"accuracy": ', logprob: 0, top: [] },
        { token: '1', logprob: Math.log(0.9), top: [{ token: '1', logprob: Math.log(0.9) }] },
        { token: '0', logprob: Math.log(0.9), top: [{ token: '0', logprob: Math.log(0.9) }] },
        { token: '}, "notes": "graded"}', logprob: 0, top: [] },
      ],
    }
    await expect(
      score(logprobChat(split).client, { method: 'expectation', whenUnavailable: 'fail' }),
    ).rejects.toThrow(/not the whole of its token/)
  })

  it('refuses expectation scoring on the unit scale at construction', () => {
    expect(() =>
      llmJudge('grader', 'grade it', {
        chat: logprobChat({ content: '{}', logprobs: null }).client,
        scale: 'unit',
        scoring: { method: 'expectation', whenUnavailable: 'fail' },
      }),
    ).toThrow(/requires scale 'ten'/)
  })
})
