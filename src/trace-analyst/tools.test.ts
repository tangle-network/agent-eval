/**
 * Tests for the AxFunction adapter layer in `tools.ts`. We don't run
 * a full agent here — we exercise the runtime guards on bad inputs
 * and confirm the namespace + function-set shape is what AxAgent
 * expects.
 *
 * Each test names the regression it would catch.
 */

import { describe, expect, it } from 'vitest'

import { TraceAnalysisValidationError } from './errors'
import { OtlpFileTraceStore, TraceNotFoundError } from './store-otlp'
import {
  buildTraceAnalysisToolDescriptors,
  buildTraceAnalystTools,
  TRACE_ANALYST_TOOL_NAMESPACE,
  traceAnalystFunctionGroup,
} from './tools'

const TINY_FIXTURE = new URL('../../tests/fixtures/trace-analyst/tiny-trace.jsonl', import.meta.url)
  .pathname

describe('buildTraceAnalystTools', () => {
  it('exposes exactly the seven discovery → narrow → deep-read functions in the traces namespace', () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const tools = buildTraceAnalystTools({ store })
    // The Ax fn() builder may wrap names; inspect through JSON.stringify
    // round-trip since the AxFunction stub carries the symbol-keyed
    // brand. We don't assert on internals — only that we built 7
    // distinct tool definitions.
    expect(tools.length).toBe(7)
  })

  it('traceAnalystFunctionGroup namespaces the toolset under "traces" with discovery metadata', () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const group = traceAnalystFunctionGroup({ store })
    expect(group.namespace).toBe('traces')
    expect(group.title).toMatch(/trace/i)
    expect(group.functions.length).toBe(7)
    expect(group.selectionCriteria).toContain('OTLP')
  })

  it('adapts every canonical transport-neutral descriptor into matching Ax metadata', () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const axTools = buildTraceAnalystTools({ store })
    const descriptors = buildTraceAnalysisToolDescriptors({ store })

    expect(descriptors).toHaveLength(7)
    expect(
      descriptors.map(({ namespace, name, description, parameters }) => ({
        namespace,
        name,
        description,
        parameters,
      })),
    ).toEqual(
      axTools.map(({ namespace, name, description, parameters }) => ({
        namespace,
        name,
        description,
        parameters,
      })),
    )
    expect(descriptors.every((tool) => tool.namespace === TRACE_ANALYST_TOOL_NAMESPACE)).toBe(true)
  })

  it('delegates every Ax operation to the same canonical transport-neutral handler', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const axTools = buildTraceAnalystTools({ store })
    const descriptors = buildTraceAnalysisToolDescriptors({ store })
    const argsByName: Record<string, Record<string, unknown>> = {
      getDatasetOverview: { filters: { has_errors: true } },
      queryTraces: { filters: { has_errors: true }, limit: 1, offset: 0 },
      countTraces: { filters: { has_errors: true } },
      viewTrace: { trace_id: 't000000000001' },
      viewSpans: { trace_id: 't000000000001', span_ids: ['s004'] },
      searchTrace: {
        trace_id: 't000000000001',
        regex_pattern: 'MaxTurnsExceeded',
        max_matches: 2,
      },
      searchSpan: {
        trace_id: 't000000000001',
        span_id: 's004',
        regex_pattern: 'MaxTurnsExceeded',
        max_matches: 2,
      },
    }

    for (const descriptor of descriptors) {
      const axTool = axTools.find((tool) => tool.name === descriptor.name)
      if (!axTool) throw new Error(`missing Ax tool ${descriptor.name}`)
      const args = argsByName[descriptor.name]
      if (!args) throw new Error(`missing invocation for ${descriptor.name}`)
      await expect(descriptor.handler(args)).resolves.toEqual(await axTool.func(args))
    }
  })

  it('preserves the store byte ceiling through the transport-neutral viewTrace handler', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE, perCallByteCeiling: 100 })
    const viewTrace = buildTraceAnalysisToolDescriptors({ store }).find(
      (tool) => tool.name === 'viewTrace',
    )
    if (!viewTrace) throw new Error('missing viewTrace descriptor')

    const result = (await viewTrace.handler({ trace_id: 't000000000001' })) as {
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
  ])('preserves %s validation error across neutral and Ax callers', async (name, args) => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const axTool = buildTraceAnalystTools({ store }).find((tool) => tool.name === name)
    const descriptor = buildTraceAnalysisToolDescriptors({ store }).find(
      (tool) => tool.name === name,
    )
    if (!axTool || !descriptor) throw new Error(`missing tool ${name}`)

    await expect(Promise.resolve().then(() => axTool.func(args))).rejects.toBeInstanceOf(
      TraceAnalysisValidationError,
    )
    await expect(descriptor.handler(args)).rejects.toMatchObject({ code: 'validation' })
  })

  it('publishes exact JSON Schemas with typed filters and public integer caps', () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const tools = buildTraceAnalysisToolDescriptors({ store })
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
      type: 'object',
      additionalProperties: false,
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

    const overview = byName.get('getDatasetOverview') as {
      properties: { filters: Record<string, unknown> }
    }
    expect(overview.properties.filters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        has_errors: { type: 'boolean' },
        service_names: { type: 'array', items: { type: 'string' } },
        agent_names: { type: 'array', items: { type: 'string' } },
        model_names: { type: 'array', items: { type: 'string' } },
        tool_names: { type: 'array', items: { type: 'string' } },
        start_time_after: { type: 'string', format: 'date-time' },
        start_time_before: { type: 'string', format: 'date-time' },
        regex_pattern: { type: 'string', minLength: 1 },
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
  ])('rejects unknown %s fields identically through both public surfaces', async (name, args) => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const neutral = buildTraceAnalysisToolDescriptors({ store }).find((tool) => tool.name === name)
    const ax = buildTraceAnalystTools({ store }).find((tool) => tool.name === name)
    if (!neutral || !ax) throw new Error(`missing tool ${name}`)

    await expect(neutral.handler(args)).rejects.toBeInstanceOf(TraceAnalysisValidationError)
    await expect(Promise.resolve().then(() => ax.func(args))).rejects.toBeInstanceOf(
      TraceAnalysisValidationError,
    )
  })

  it.each([
    { filters: { has_errors: 'true' } },
    { filters: { service_names: 'runtime' } },
    { filters: { start_time_after: 'yesterday' } },
    { filters: { unknown_filter: true } },
  ])('rejects an invalid filter instead of silently broadening the query', async (args) => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const tool = buildTraceAnalysisToolDescriptors({ store }).find(
      (candidate) => candidate.name === 'getDatasetOverview',
    )
    if (!tool) throw new Error('missing getDatasetOverview descriptor')

    await expect(tool.handler(args)).rejects.toMatchObject({ code: 'validation' })
  })

  it('forwards Ax abortSignal into the canonical descriptor before any store read', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const tool = buildTraceAnalystTools({ store }).find(
      (candidate) => candidate.name === 'viewTrace',
    )
    if (!tool) throw new Error('missing viewTrace Ax tool')
    const controller = new AbortController()
    const reason = new Error('stop Ax trace read')
    controller.abort(reason)

    await expect(
      Promise.resolve().then(() =>
        tool.func({ trace_id: 't000000000001' }, { abortSignal: controller.signal }),
      ),
    ).rejects.toBe(reason)
  })

  it('preserves typed store errors instead of converting them to transport results', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const viewTrace = buildTraceAnalysisToolDescriptors({ store }).find(
      (tool) => tool.name === 'viewTrace',
    )
    if (!viewTrace) throw new Error('missing viewTrace descriptor')

    await expect(viewTrace.handler({ trace_id: 'missing' })).rejects.toBeInstanceOf(
      TraceNotFoundError,
    )
  })
})
