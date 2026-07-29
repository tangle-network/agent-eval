/**
 * Tests for the AxFunction adapter layer in `tools.ts`. We don't run
 * a full agent here — we exercise the runtime guards on bad inputs
 * and confirm the namespace + function-set shape is what AxAgent
 * expects.
 *
 * Each test names the regression it would catch.
 */

import { describe, expect, it } from 'vitest'

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

  it('exposes transport-neutral metadata exactly matching every Ax function', () => {
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

  it('delegates every transport-neutral handler to the same bounded Ax operation', async () => {
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
    ['queryTraces', { limit: 0 }, 'limit must be an integer 1..200'],
    ['queryTraces', { limit: 201 }, 'limit must be an integer 1..200'],
    ['queryTraces', { limit: 1, offset: -1 }, 'offset must be a non-negative integer'],
    [
      'searchTrace',
      { trace_id: 't000000000001', regex_pattern: '[', max_matches: 1 },
      'Invalid regular expression',
    ],
    [
      'searchTrace',
      { trace_id: 't000000000001', regex_pattern: 'x', max_matches: 501 },
      'max_matches must be an integer 1..500',
    ],
  ])('preserves %s validation error for transport-neutral callers', async (name, args, message) => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const axTool = buildTraceAnalystTools({ store }).find((tool) => tool.name === name)
    const descriptor = buildTraceAnalysisToolDescriptors({ store }).find(
      (tool) => tool.name === name,
    )
    if (!axTool || !descriptor) throw new Error(`missing tool ${name}`)

    await expect(Promise.resolve().then(() => axTool.func(args))).rejects.toThrow(message)
    await expect(descriptor.handler(args)).rejects.toThrow(message)
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
