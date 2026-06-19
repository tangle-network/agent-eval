import { describe, expect, it } from 'vitest'
import type { LlmSpan, Message, Run, Span, ToolSpan } from '../trace/schema'
import type { SpanFilter, TraceStore } from '../trace/store'
import { toolWasteView } from './tool-waste'

// Minimal in-file store implementing only the TraceStore surface toolWasteView
// touches (listRuns + spans). Avoids coupling this slice to the full store.
class StubStore implements TraceStore {
  constructor(
    private readonly runs: Run[],
    private readonly allSpans: Span[],
  ) {}
  async listRuns(): Promise<Run[]> {
    return this.runs
  }
  async spans(filter: SpanFilter = {}): Promise<Span[]> {
    return this.allSpans.filter((s) => {
      if (filter.runId && s.runId !== filter.runId) return false
      if (filter.kind && s.kind !== filter.kind) return false
      if (filter.toolName && (s.kind !== 'tool' || s.toolName !== filter.toolName)) return false
      return true
    })
  }
  async appendRun(): Promise<void> {}
  async updateRun(): Promise<void> {}
  async appendSpan(): Promise<void> {}
  async updateSpan(): Promise<void> {}
  async appendEvent(): Promise<void> {}
  async appendArtifact(): Promise<void> {}
  async appendBudgetEntry(): Promise<void> {}
  async getRun(): Promise<Run | undefined> {
    return undefined
  }
  async events(): Promise<never[]> {
    return []
  }
  async budget(): Promise<never[]> {
    return []
  }
  async artifacts(): Promise<never[]> {
    return []
  }
}

function tool(i: number, opts: Partial<ToolSpan> & { result?: unknown }): ToolSpan {
  return {
    spanId: `t${i}`,
    runId: 'r',
    kind: 'tool',
    name: `tool.${i}`,
    startedAt: 1000 + i * 1000,
    toolName: `tool${i}`,
    args: {},
    ...opts,
  }
}

function llm(i: number, contents: string[]): LlmSpan {
  const messages: Message[] = contents.map((c) => ({ role: 'user', content: c }))
  return {
    spanId: `l${i}`,
    runId: 'r',
    kind: 'llm',
    name: `llm.${i}`,
    startedAt: 1500 + i * 1000,
    model: 'm',
    messages,
  }
}

function storeWith(tools: ToolSpan[], llms: LlmSpan[]): StubStore {
  return new StubStore([{ runId: 'r', scenarioId: 's' } as Run], [...tools, ...llms])
}

describe('toolWasteView', () => {
  it('counts an error tool call as wasted', async () => {
    const store = storeWith([tool(0, { status: 'error', result: 'boom' })], [llm(0, ['hi'])])
    const r = await toolWasteView(store, { runId: 'r' })
    expect(r.byRun[0]!.wastedCalls).toBe(1)
    expect(r.byRun[0]!.wasteRate).toBe(1)
  })

  it('does not count a tool whose result appears in a later LLM message', async () => {
    const store = storeWith(
      [tool(0, { result: 'IMPORTANT_PAYLOAD_42' })],
      [llm(0, ['here is the data: IMPORTANT_PAYLOAD_42 thanks'])],
    )
    const r = await toolWasteView(store, { runId: 'r' })
    expect(r.byRun[0]!.wastedCalls).toBe(0)
    expect(r.byRun[0]!.wasteRate).toBe(0)
  })

  it('counts a tool whose non-empty result never appears downstream as wasted', async () => {
    const store = storeWith(
      [tool(0, { result: 'UNUSED_PAYLOAD' })],
      [llm(0, ['something unrelated'])],
    )
    const r = await toolWasteView(store, { runId: 'r' })
    expect(r.byRun[0]!.wastedCalls).toBe(1)
  })

  // Regression: an empty/null tool result stringifies to '' — there is no
  // payload to propagate, so it must NOT be counted as waste. The old code
  // (`resultStr &&` → falsy → used=false) wrongly counted it.
  it('does not count an empty-result tool call as wasted', async () => {
    const store = storeWith(
      [tool(0, { result: '' }), tool(1, { result: null }), tool(2, { result: undefined })],
      [llm(0, ['no payloads here'])],
    )
    const r = await toolWasteView(store, { runId: 'r' })
    expect(r.byRun[0]!.wastedCalls).toBe(0)
    expect(r.byRun[0]!.wasteRate).toBe(0)
  })

  it('only matches LLM spans that started strictly after the tool', async () => {
    // An LLM span that ran BEFORE the tool mentions the payload, but a later
    // span must be the one that propagates it. Earlier mention != usage.
    const earlier = llm(-2, ['LATE_PAYLOAD already mentioned early']) // startedAt 500
    earlier.startedAt = 500
    const store = storeWith([tool(0, { result: 'LATE_PAYLOAD' })], [earlier])
    const r = await toolWasteView(store, { runId: 'r' })
    expect(r.byRun[0]!.wastedCalls).toBe(1)
  })

  it('honors a usageOracle override and passes only later LLM spans', async () => {
    const before = llm(-1, ['before'])
    before.startedAt = 500
    const after = llm(0, ['after'])
    const store = storeWith([tool(0, { result: 'x' })], [before, after])
    const seen: number[] = []
    const r = await toolWasteView(store, {
      runId: 'r',
      usageOracle: (_t, later) => {
        seen.push(later.llm.length)
        return true // oracle says always used
      },
    })
    expect(r.byRun[0]!.wastedCalls).toBe(0)
    // Only the span started after the tool (startedAt 1000) is later.
    expect(seen).toEqual([1])
  })

  it('reports wasteRate 0 with no NaN for an empty run', async () => {
    const store = new StubStore([{ runId: 'r', scenarioId: 's' } as Run], [])
    const r = await toolWasteView(store, { runId: 'r' })
    expect(r.byRun[0]!).toEqual({ runId: 'r', wastedCalls: 0, totalCalls: 0, wasteRate: 0 })
    expect(Number.isNaN(r.overallWasteRate)).toBe(false)
    expect(r.overallWasteRate).toBe(0)
  })
})
