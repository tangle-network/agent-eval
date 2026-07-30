import { type AxChatRequest, type AxChatResponse, AxMockAIService } from '@ax-llm/ax'
import { describe, expect, it } from 'vitest'
import { readTraceAnalysisOutput, runTraceAnalysisLoop, TraceAnalysisTurnLimitError } from './loop'

describe('runTraceAnalysisLoop', () => {
  it('uses Ax direct response for a prepared long-context trace', async () => {
    let modelCalls = 0
    const requests: Array<Readonly<AxChatRequest<unknown>>> = []
    const ai = new AxMockAIService<string>({
      features: { functions: false, streaming: false },
      chatResponse: async (nextRequest): Promise<AxChatResponse> => {
        modelCalls += 1
        requests.push(nextRequest)
        return {
          results: [
            {
              index: 0,
              content:
                modelCalls === 1
                  ? 'Javascript Code: respond("Write the trace report.", { inspected: inputs.context })'
                  : 'Report: prepared trace report\nFindings: ["trace://trace-1/span/step-2"]',
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
      id: 'prepared-context-analyst',
      description: 'Analyzes one prepared trace.',
      prompt: 'Inspect the supplied trace.',
      question: 'What failed?',
      context: JSON.stringify({ trace_id: 'trace-1', spans: [{ span_id: 'step-2' }] }),
      ai,
      tools: [],
      findingType: 'string',
      maxSubqueries: 0,
      maxParallelSubqueries: 1,
      maxTurns: 1,
      maxRuntimeChars: 6000,
    })

    expect(result).toMatchObject({
      report: 'prepared trace report',
      findings: ['trace://trace-1/span/step-2'],
      turnCount: 0,
    })
    expect(modelCalls).toBe(2)
    expect(
      requests
        .flatMap((request) => request.chatPrompt)
        .map((message) => ('content' in message ? JSON.stringify(message.content) : ''))
        .join('\n'),
    ).toContain('inputs.context')
  })

  it('uses the public Ax pipeline and returns its structured response', async () => {
    let modelCalls = 0
    const requests: Array<Readonly<AxChatRequest<unknown>>> = []
    const ai = new AxMockAIService<string>({
      features: { functions: false, streaming: false },
      chatResponse: async (nextRequest): Promise<AxChatResponse> => {
        modelCalls += 1
        requests.push(nextRequest)
        const content =
          modelCalls === 1
            ? 'Javascript Code: final("Analyze the trace.", {})'
            : modelCalls === 2
              ? 'Javascript Code: final("Write the trace report.", { report: "exact report", findings: ["span://trace-1/span-2"] })'
              : 'Report: exact report\nFindings: ["span://trace-1/span-2"]'
        return {
          results: [
            {
              index: 0,
              content,
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
      maxTurns: 1,
      maxRuntimeChars: 6000,
    })

    expect(result.report).toBe('exact report')
    expect(result.findings).toEqual(['span://trace-1/span-2'])
    expect(result.turnCount).toBe(1)
    expect(modelCalls).toBe(3)
    const prompts = requests.flatMap((request) =>
      request.chatPrompt.map((message) =>
        'content' in message
          ? typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content)
          : JSON.stringify(message),
      ),
    )
    expect(prompts.join('\n')).toContain('What failed?')
    expect(prompts.join('\n')).toContain('let the response stage produce')
    expect(result.usage.actor).toHaveLength(2)
    expect(result.usage.responder).toHaveLength(1)
    expect(result.chatLog.actor).toHaveLength(2)
    expect(result.chatLog.responder).toHaveLength(1)
    expect(result.chatLog.responder[0]).toMatchObject({ name: 'responder' })
  })

  it('rejects exhausted evidence collection before response synthesis', async () => {
    let mockCalls = 0
    const ai = new AxMockAIService<string>({
      features: { functions: false, streaming: false },
      chatResponse: async (): Promise<AxChatResponse> => {
        mockCalls += 1
        const content =
          mockCalls === 1
            ? 'Javascript Code: final("Analyze the trace.", {})'
            : mockCalls === 2
              ? 'Javascript Code: console.log("partial evidence")'
              : 'Report: partial evidence only\nFindings: []'
        return {
          results: [
            {
              index: 0,
              content,
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

    await expect(
      runTraceAnalysisLoop({
        id: 'turn-limited-analyst',
        description: 'Replays a model response that never calls final.',
        prompt: 'Inspect the supplied traces.',
        question: 'What failed?',
        ai,
        tools: [],
        findingType: 'string',
        maxSubqueries: 0,
        maxParallelSubqueries: 1,
        maxTurns: 1,
        maxRuntimeChars: 6000,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'TraceAnalysisTurnLimitError',
        analystId: 'turn-limited-analyst',
        stage: 'executor',
        maxTurns: 1,
      }),
    )
    expect(mockCalls).toBe(2)
  })

  it('rejects exhausted prepared-context collection even if response synthesis succeeds', async () => {
    let mockCalls = 0
    const ai = new AxMockAIService<string>({
      features: { functions: false, streaming: false },
      chatResponse: async (): Promise<AxChatResponse> => {
        mockCalls += 1
        return {
          results: [
            {
              index: 0,
              content:
                mockCalls === 1
                  ? 'Javascript Code: console.log("partial context")'
                  : mockCalls === 2
                    ? 'Javascript Code: final("Write the trace report.", { partial: true })'
                    : 'Report: partial context only\nFindings: []',
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

    await expect(
      runTraceAnalysisLoop({
        id: 'turn-limited-context-analyst',
        description: 'Replays a context analysis that never calls respond.',
        prompt: 'Inspect the supplied trace.',
        question: 'What failed?',
        context: '{"trace_id":"trace-1"}',
        ai,
        tools: [],
        findingType: 'string',
        maxSubqueries: 0,
        maxParallelSubqueries: 1,
        maxTurns: 1,
        maxRuntimeChars: 6000,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'TraceAnalysisTurnLimitError',
        analystId: 'turn-limited-context-analyst',
        stage: 'distiller',
        maxTurns: 1,
      }),
    )
    expect(mockCalls).toBe(3)
  })

  it('exposes a named error for turn-limit handling', () => {
    expect(new TraceAnalysisTurnLimitError('analyst', 'distiller', 3)).toMatchObject({
      name: 'TraceAnalysisTurnLimitError',
      analystId: 'analyst',
      stage: 'distiller',
      maxTurns: 3,
    })
  })

  it('rejects non-structured response output', () => {
    expect(() =>
      readTraceAnalysisOutput('Actor stopped without a structured response.', 'string'),
    ).toThrow('response must contain report and findings')
  })

  it('leaves object-finding rows for the kind schema to validate or repair', () => {
    expect(
      readTraceAnalysisOutput(
        {
          report: 'plausible',
          findings: ['{"claim":"repairable"}', 42],
        },
        'object',
      ),
    ).toEqual({
      report: 'plausible',
      findings: ['{"claim":"repairable"}', 42],
    })
  })
})
