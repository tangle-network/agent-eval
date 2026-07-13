import { describe, expect, it, vi } from 'vitest'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from './kind-factory'
import { type AnalystUsageReceipt, makeFinding } from './types'

const axMock = vi.hoisted(() => ({
  agentCalls: [] as Array<{ signature: string; options: Record<string, unknown> }>,
  events: [] as string[],
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
        axMock.events.push('forward')
        return { report: '', findings: [] }
      },
      getUsage() {
        axMock.events.push('getUsage')
        return {
          actor: [
            {
              ai: 'openai',
              model: 'm',
              tokens: {
                promptTokens: 100,
                completionTokens: 20,
                totalTokens: 120,
                cacheReadTokens: 8,
              },
            },
          ],
          responder: [
            {
              ai: 'openai',
              model: 'm',
              tokens: { promptTokens: 30, completionTokens: 5, totalTokens: 35 },
            },
          ],
        }
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
    axMock.events.length = 0
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

    let receipt: AnalystUsageReceipt | undefined
    const findings = await analyst.analyze(
      {} as never,
      {
        tags: {},
        recordUsage: (value: AnalystUsageReceipt) => {
          receipt = value
        },
      } as never,
    )

    expect(findings).toEqual([])
    expect(axMock.events).toEqual(['forward', 'getUsage'])
    expect(receipt).toEqual({
      calls: 2,
      tokens: { input: 130, output: 25, cached: 8 },
      cost: { kind: 'uncaptured', usd: null },
    })
    expect(axMock.agentCalls).toHaveLength(1)
    expect(axMock.agentCalls[0]!.options.functions).toEqual([tool])
  })

  it('renders same-run upstream findings as dependency context, not prior-run memory', async () => {
    axMock.agentCalls.length = 0
    const spec: TraceAnalystKindSpec = {
      id: 'improvement',
      description: 'Propose improvements',
      area: 'improvement',
      version: '0.0.1',
      actorDescription: 'Return findings.',
      buildTools: () => [],
      cost: { kind: 'llm' },
    }
    const upstream = makeFinding({
      analyst_id: 'failure-mode',
      area: 'failure-mode',
      claim: 'agent repeated the same failed tool call',
      severity: 'high',
      confidence: 0.9,
      evidence_refs: [{ kind: 'span', uri: 'span://trace/tool-call' }],
      recommended_action: 'deduplicate identical calls',
    })
    const analyst = createTraceAnalystKind(spec, { ai: {} as never })

    await analyst.analyze({} as never, { upstreamFindings: [upstream] } as never)

    const actor = (
      axMock.agentCalls[0]?.options.actorOptions as { description?: string } | undefined
    )?.description
    expect(actor).toContain('UPSTREAM FINDINGS (produced earlier in this same registry run)')
    expect(actor).toContain(`id=${upstream.finding_id} source=failure-mode high`)
    expect(actor).toContain('claim=agent repeated the same failed tool call')
    expect(actor).toContain('action=deduplicate identical calls')
    expect(actor).toContain('evidence=span://trace/tool-call')
    expect(actor).not.toContain('PRIOR FINDINGS (from a previous run')
  })
})
