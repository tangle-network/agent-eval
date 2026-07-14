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
      async forward(ai: { chat(request: unknown): Promise<unknown> }) {
        axMock.events.push('forward')
        await ai.chat({
          model: 'gpt-4o-mini',
          chatPrompt: [{ role: 'user', content: 'actor' }],
        })
        await ai.chat({
          model: 'gpt-4o-mini',
          chatPrompt: [{ role: 'user', content: 'responder' }],
        })
        return { report: '', findings: [] }
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
    let call = 0
    const ai = {
      async chat() {
        call += 1
        return call === 1
          ? {
              results: [],
              modelUsage: {
                ai: 'openai',
                model: 'gpt-4o-mini',
                tokens: {
                  promptTokens: 100,
                  completionTokens: 20,
                  totalTokens: 120,
                  cacheReadTokens: 8,
                },
              },
            }
          : {
              results: [],
              modelUsage: {
                ai: 'openai',
                model: 'gpt-4o-mini',
                tokens: { promptTokens: 30, completionTokens: 5, totalTokens: 35 },
              },
            }
      },
    }
    const analyst = createTraceAnalystKind(spec, { ai: ai as never })

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
    expect(axMock.events).toEqual(['forward'])
    expect(receipt).toEqual({
      calls: 2,
      tokens: { input: 122, output: 25, cached: 8 },
      cost: { kind: 'estimated', usd: expect.any(Number) },
    })
    expect(axMock.agentCalls).toHaveLength(1)
    expect(axMock.agentCalls[0]!.options.functions).toEqual([tool])
  })

  it('enforces the allocated analyst budget before the provider call', async () => {
    const providerChat = vi.fn(async () => ({
      results: [],
      modelUsage: {
        ai: 'openai',
        model: 'gpt-4o-mini',
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    }))
    const spec: TraceAnalystKindSpec = {
      id: 'failure-mode',
      description: 'Find trace failures',
      area: 'failure-mode',
      version: '0.0.1',
      actorDescription: 'Return findings.',
      buildTools: () => [],
      cost: { kind: 'llm' },
      maxOutputTokens: 64,
    }
    const analyst = createTraceAnalystKind(spec, {
      ai: { chat: providerChat } as never,
    })

    await expect(analyst.analyze({} as never, { budgetUsd: 0 } as never)).rejects.toThrow(
      /would exceed ceiling 0/,
    )
    expect(providerChat).not.toHaveBeenCalled()
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
    const analyst = createTraceAnalystKind(spec, {
      ai: {
        async chat() {
          return {
            results: [],
            modelUsage: {
              ai: 'openai',
              model: 'gpt-4o-mini',
              tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
          }
        },
      } as never,
    })

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
