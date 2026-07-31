import { describe, expect, it } from 'vitest'
import { TraceAnalysisValidationError } from './errors'
import { OtlpFileTraceStore, TraceNotFoundError } from './store-otlp'
import {
  buildTraceAnalysisToolDescriptors,
  TRACE_ANALYST_TOOL_NAMESPACE,
  traceAnalystFunctionGroup,
} from './tools'

const TINY_FIXTURE = new URL('../../tests/fixtures/trace-analyst/tiny-trace.jsonl', import.meta.url)
  .pathname

describe('trace analysis tool descriptors', () => {
  it('exposes exactly seven transport-neutral trace reads', () => {
    const tools = buildTraceAnalysisToolDescriptors({
      store: new OtlpFileTraceStore({ path: TINY_FIXTURE }),
    })

    expect(tools.map((tool) => tool.name)).toEqual([
      'getDatasetOverview',
      'queryTraces',
      'countTraces',
      'viewTrace',
      'viewSpans',
      'searchTrace',
      'searchSpan',
    ])
    expect(tools.every((tool) => tool.namespace === TRACE_ANALYST_TOOL_NAMESPACE)).toBe(true)
  })

  it('publishes the same descriptors through the function group', () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const group = traceAnalystFunctionGroup({ store })

    expect(group.namespace).toBe('traces')
    expect(group.title).toMatch(/trace/i)
    expect(group.functions).toHaveLength(7)
    expect(group.selectionCriteria).toContain('OTLP')
  })

  it('preserves the store byte limit through viewTrace', async () => {
    const tool = findTool(
      buildTraceAnalysisToolDescriptors({
        store: new OtlpFileTraceStore({
          path: TINY_FIXTURE,
          perCallByteCeiling: 100,
        }),
      }),
      'viewTrace',
    )
    const result = (await tool.handler({ trace_id: 't000000000001' })) as {
      spans?: unknown
      oversized?: { span_count: number }
    }

    expect(result.spans).toBeUndefined()
    expect(result.oversized?.span_count).toBe(4)
  })

  it.each([
    ['queryTraces', { limit: 0 }],
    ['queryTraces', { limit: 201 }],
    ['queryTraces', { limit: 1, offset: -1 }],
    ['searchTrace', { trace_id: 't000000000001', regex_pattern: '[', max_matches: 1 }],
    ['searchTrace', { trace_id: 't000000000001', regex_pattern: 'x', max_matches: 501 }],
  ])('rejects invalid %s arguments', async (name, args) => {
    const tool = findTool(
      buildTraceAnalysisToolDescriptors({
        store: new OtlpFileTraceStore({ path: TINY_FIXTURE }),
      }),
      name,
    )

    await expect(tool.handler(args)).rejects.toBeInstanceOf(TraceAnalysisValidationError)
  })

  it('publishes typed JSON schemas with public integer limits', () => {
    const tools = buildTraceAnalysisToolDescriptors({
      store: new OtlpFileTraceStore({ path: TINY_FIXTURE }),
    })
    const byName = new Map(tools.map((tool) => [tool.name, tool.parameters]))

    expect(byName.get('queryTraces')).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['limit'],
    })
    expect(byName.get('viewSpans')).toMatchObject({
      properties: {
        span_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string', minLength: 1 },
        },
      },
    })
    expect(byName.get('searchTrace')).toMatchObject({
      properties: {
        max_matches: { type: 'integer', minimum: 1, maximum: 500 },
      },
    })
  })

  it.each([
    ['getDatasetOverview', { unexpected: true }],
    ['queryTraces', { limit: 1, unexpected: true }],
    ['countTraces', { unexpected: true }],
    ['viewTrace', { trace_id: 't000000000001', unexpected: true }],
    ['viewSpans', { trace_id: 't000000000001', span_ids: ['s004'], unexpected: true }],
    ['searchTrace', { trace_id: 't000000000001', regex_pattern: 'x', unexpected: true }],
    [
      'searchSpan',
      {
        trace_id: 't000000000001',
        span_id: 's004',
        regex_pattern: 'x',
        unexpected: true,
      },
    ],
  ])('rejects unknown %s fields', async (name, args) => {
    const tool = findTool(
      buildTraceAnalysisToolDescriptors({
        store: new OtlpFileTraceStore({ path: TINY_FIXTURE }),
      }),
      name,
    )

    await expect(tool.handler(args)).rejects.toBeInstanceOf(TraceAnalysisValidationError)
  })

  it.each([
    { filters: { has_errors: 'true' } },
    { filters: { service_names: 'runtime' } },
    { filters: { start_time_after: 'yesterday' } },
    { filters: { unknown_filter: true } },
  ])('rejects an invalid filter instead of broadening the query', async (args) => {
    const tool = findTool(
      buildTraceAnalysisToolDescriptors({
        store: new OtlpFileTraceStore({ path: TINY_FIXTURE }),
      }),
      'getDatasetOverview',
    )

    await expect(tool.handler(args)).rejects.toMatchObject({ code: 'validation' })
  })

  it('forwards cancellation before a store read', async () => {
    const tool = findTool(
      buildTraceAnalysisToolDescriptors({
        store: new OtlpFileTraceStore({ path: TINY_FIXTURE }),
      }),
      'viewTrace',
    )
    const controller = new AbortController()
    const reason = new Error('stop trace read')
    controller.abort(reason)

    await expect(
      tool.handler({ trace_id: 't000000000001' }, { signal: controller.signal }),
    ).rejects.toBe(reason)
  })

  it('preserves typed store errors', async () => {
    const tool = findTool(
      buildTraceAnalysisToolDescriptors({
        store: new OtlpFileTraceStore({ path: TINY_FIXTURE }),
      }),
      'viewTrace',
    )

    await expect(tool.handler({ trace_id: 'missing' })).rejects.toBeInstanceOf(TraceNotFoundError)
  })
})

function findTool(tools: ReturnType<typeof buildTraceAnalysisToolDescriptors>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}
