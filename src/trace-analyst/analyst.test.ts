import { describe, expect, it, vi } from 'vitest'

import { analyzeTraces } from './analyst'
import type { TraceAnalysisStore } from './store'
import type { DatasetOverview } from './types'

const axMock = vi.hoisted(() => ({
  agentCalls: [] as Array<{ signature: string; options: Record<string, unknown> }>,
  forwardCalls: [] as Array<{ ai: unknown; values: unknown }>,
}))

vi.mock('@ax-llm/ax', () => {
  const field = {
    optional() {
      return field
    },
    array() {
      return field
    },
  }
  const f = Object.assign(
    () => ({
      input() {
        return this
      },
      output() {
        return this
      },
      build() {
        return {}
      },
    }),
    {
      string: () => field,
      number: () => field,
      boolean: () => field,
      json: () => field,
    },
  )
  const fn = (name: string) => {
    const tool: Record<string, unknown> = { name }
    const builder = {
      description(value: string) {
        tool.description = value
        return builder
      },
      namespace(value: string) {
        tool.namespace = value
        return builder
      },
      arg() {
        return builder
      },
      returns() {
        return builder
      },
      handler(value: unknown) {
        tool.handler = value
        return builder
      },
      example() {
        return builder
      },
      build() {
        return tool
      },
    }
    return builder
  }
  return {
    f,
    fn,
    AxJSRuntime: class {
      readonly options: unknown
      constructor(options?: unknown) {
        this.options = options
      }
    },
    agent: (signature: string, options: Record<string, unknown>) => {
      axMock.agentCalls.push({ signature, options })
      return {
        async forward(ai: unknown, values: unknown) {
          axMock.forwardCalls.push({ ai, values })
          const onTurn = options.actorTurnCallback
          if (typeof onTurn === 'function') {
            await onTurn({
              turn: 1,
              actionLogEntryCount: 1,
              guidanceLogEntryCount: 0,
              actorResult: {},
              code: 'const overview = await traces.getDatasetOverview({})',
              result: {},
              output: 'overview loaded',
              isError: false,
              thought: 'inspect first',
            })
          }
          return {
            answer: 'publish_finding hits MaxTurnsExceeded in t000000000001/s004',
            findings: ['t000000000001/s004: publish_finding hit MaxTurnsExceeded'],
          }
        },
        getUsage() {
          return { actor: [{ tokens: { totalTokens: 10 } }], responder: [] }
        },
        getChatLog() {
          return { actor: [{ role: 'assistant' }], responder: [] }
        },
        resetUsage() {},
      }
    },
  }
})

describe('analyzeTraces', () => {
  it('constructs an Ax RLM analyst with bounded trace tools and returns run telemetry', async () => {
    const overview: DatasetOverview = {
      total_traces: 1,
      raw_jsonl_bytes: 100,
      services: ['bench'],
      agents: ['driver'],
      models: ['model-a'],
      tool_names: ['publish_finding'],
      sample_trace_ids: ['t000000000001'],
      errors: { trace_count: 1, span_count: 1 },
      time_range: null,
    }
    const store: TraceAnalysisStore = {
      async getOverview() {
        return overview
      },
      async queryTraces() {
        return {
          traces: [],
          total: 0,
          has_more: false,
        }
      },
      async countTraces() {
        return 1
      },
      async viewTrace() {
        return { trace_id: 't000000000001', spans: [] }
      },
      async viewSpans() {
        return {
          trace_id: 't000000000001',
          spans: [],
          missing_span_ids: [],
          truncated_attribute_count: 0,
        }
      },
      async searchTrace() {
        return {
          trace_id: 't000000000001',
          hits: [],
          total_matches: 0,
          has_more: false,
        }
      },
      async searchSpan() {
        return {
          trace_id: 't000000000001',
          span_id: 's004',
          hits: [],
          total_matches: 0,
          has_more: false,
        }
      },
    }

    const ai = { provider: 'test' }
    const result = await analyzeTraces(
      { question: 'Which harness failure mode blocks success?' },
      { source: store, ai, model: 'rlm-test', maxDepth: 1 },
    )

    expect(axMock.agentCalls).toHaveLength(1)
    expect(axMock.agentCalls[0].signature).toBe('question:string -> answer:string, findings:string[]')
    expect(axMock.agentCalls[0].options.mode).toBe('advanced')
    expect(axMock.agentCalls[0].options.functions).toMatchObject({
      local: expect.arrayContaining([
        expect.objectContaining({ namespace: 'traces', name: 'getDatasetOverview' }),
        expect.objectContaining({ namespace: 'traces', name: 'searchSpan' }),
      ]),
    })
    expect(axMock.forwardCalls).toEqual([
      {
        ai,
        values: { question: 'Which harness failure mode blocks success?' },
      },
    ])
    expect(result.answer).toContain('MaxTurnsExceeded')
    expect(result.findings).toEqual(['t000000000001/s004: publish_finding hit MaxTurnsExceeded'])
    expect(result.turnCount).toBe(1)
    expect(result.turns[0]).toMatchObject({
      turn: 1,
      isError: false,
      output: 'overview loaded',
    })
    expect(result.actorPromptVersion).toMatch(/^trace-analyst-actor-v\d+-/)
  })
})
