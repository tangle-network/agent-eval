import { describe, expect, it, vi } from 'vitest'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from './kind-factory'

const axMock = vi.hoisted(() => ({
  agentCalls: [] as Array<{ signature: string; options: Record<string, unknown> }>,
}))

vi.mock('@ax-llm/ax', () => ({
  AxJSRuntime: class {
    readonly options: unknown
    constructor(options?: unknown) {
      this.options = options
    }
  },
  agent: (signature: string, options: Record<string, unknown>) => {
    if (
      options.functions !== undefined &&
      !(
        typeof (options.functions as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
        'function'
      )
    ) {
      throw new TypeError('functions must be iterable')
    }
    axMock.agentCalls.push({ signature, options })
    return {
      async forward() {
        return { report: '', findings: [] }
      },
      getUsage() {
        return {}
      },
      getChatLog() {
        return {}
      },
      resetUsage() {},
    }
  },
}))

describe('createTraceAnalystKind Ax contract', () => {
  it('passes trace tools as the iterable Ax functions shape', async () => {
    axMock.agentCalls.length = 0
    const tool = { namespace: 'traces', name: 'getDatasetOverview' }
    const spec: TraceAnalystKindSpec = {
      id: 'failure-mode',
      description: 'Find trace failures',
      area: 'failure-mode',
      version: '0.0.1',
      actorDescription: 'Return findings.',
      buildTools: () => [tool as never],
      cost: { kind: 'llm' },
    }
    const analyst = createTraceAnalystKind(spec, { ai: {} as never })

    const findings = await analyst.analyze({} as never, { tags: {} } as never)

    expect(findings).toEqual([])
    expect(axMock.agentCalls).toHaveLength(1)
    expect(axMock.agentCalls[0]!.options.functions).toEqual([tool])
  })
})
