import { type AxChatRequest, type AxChatResponse, AxMockAIService } from '@ax-llm/ax'
import { describe, expect, it } from 'vitest'
import {
  readTraceAnalysisCompletion,
  runTraceAnalysisLoop,
  TRACE_ANALYSIS_FINAL_TASK,
} from './loop'

describe('runTraceAnalysisLoop', () => {
  it('returns one exact structured result from a real Ax executor run', async () => {
    let modelCalls = 0
    let request: Readonly<AxChatRequest<unknown>> | undefined
    const ai = new AxMockAIService<string>({
      features: { functions: false, streaming: false },
      chatResponse: async (nextRequest): Promise<AxChatResponse> => {
        modelCalls += 1
        request = nextRequest
        return {
          results: [
            {
              index: 0,
              content: `Javascript Code: final(${JSON.stringify(TRACE_ANALYSIS_FINAL_TASK)}, { report: "exact report", findings: ["span://trace-1/span-2"] })`,
              finishReason: 'stop',
            },
          ],
          modelUsage: {
            ai: 'mock-ai',
            model: 'mock-model',
            tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        }
      },
    })

    const result = await runTraceAnalysisLoop({
      id: 'test-analyst',
      description: 'Tests the direct analysis loop.',
      prompt: 'Inspect the supplied traces.',
      question: 'What failed?',
      ai,
      tools: [],
      findingType: 'string',
      maxSubqueries: 0,
      maxParallelSubqueries: 1,
      maxTurns: 2,
      maxRuntimeChars: 6000,
    })

    expect(result.report).toBe('exact report')
    expect(result.findings).toEqual(['span://trace-1/span-2'])
    expect(result.turnCount).toBe(1)
    expect(modelCalls).toBe(1)
    const prompts = request?.chatPrompt.map((message) =>
      'content' in message
        ? typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content)
        : JSON.stringify(message),
    )
    expect(prompts?.join('\n')).toContain('What failed?')
    expect(prompts?.join('\n')).toContain('there is no downstream responder for this run')
  })

  it('rejects Ax max-turn fallback text instead of treating it as a result', () => {
    expect(() =>
      readTraceAnalysisCompletion(
        {
          type: 'final',
          args: ['Actor stopped without calling final(...). Evidence summary: none'],
        },
        'string',
      ),
    ).toThrow('did not return a structured final result')
  })

  it('rejects a different final task even when its payload looks valid', () => {
    expect(() =>
      readTraceAnalysisCompletion(
        { type: 'final', args: ['Format this.', { report: 'plausible', findings: [] }] },
        'string',
      ),
    ).toThrow('did not return a structured final result')
  })
})
