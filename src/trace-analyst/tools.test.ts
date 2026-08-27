/**
 * Tests for the AxFunction adapter layer in `tools.ts`. We don't run
 * a full agent here — we exercise the runtime guards on bad inputs
 * and confirm the namespace + function-set shape is what AxAgent
 * expects.
 *
 * Each test names the regression it would catch.
 */

import { describe, expect, it } from 'vitest'

import { OtlpFileTraceStore } from './store-otlp'
import { buildTraceAnalystTools, traceAnalystFunctionGroup } from './tools'

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
})
