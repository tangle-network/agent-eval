import { describe, expect, it } from 'vitest'
import { createChatClient } from '../src/analyst/chat-client'
import { type RunRLCampaignOptions, runRLCampaign } from '../src/rl/rl-campaign'
import type { ChatMessage } from '../src/rollout/schema'
import { InMemoryRawProviderSink } from '../src/trace/raw-provider-sink'
import { InMemoryTraceStore } from '../src/trace/store'

function campaign(mode: 'history' | 'orphan' | 'compacted' = 'history', shared?: InMemoryTraceStore) {
  const stores = new Map<string, InMemoryTraceStore>()
  const captures = new Map<string, ChatMessage[]>()
  const model = 'test-model@2026-05-08'
  const endpoint = 'https://api.test.local/v1'
  const options: RunRLCampaignOptions<string> = {
    campaignId: 'rl-capture', variants: [{ id: 'a', payload: 'a' }, { id: 'b', payload: 'b' }],
    scenarios: [{ scenarioId: 'task' }], seeds: [1], commitSha: 'c'.repeat(40), executionRef: endpoint,
    chatFactory: () => createChatClient({ transport: 'custom', defaultModel: model, maximumAttempts: 1,
      chat: async () => { throw new Error('this capture fixture must not call a model') } }),
    storeFactory: ({ runId }) => {
      const store = shared ?? new InMemoryTraceStore()
      stores.set(runId, store)
      return store
    },
    rawSinkFactory: () => new InMemoryRawProviderSink(),
    runner: async (ctx) => {
      await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
      const history: Array<ChatMessage & { content: string }> = [
        { role: 'user', content: 'Read the fixture.' },
        { role: 'assistant', content: '', tool_calls: [
          { id: ctx.runId, type: 'function', function: { name: 'read', arguments: '{"path":"fixture"}' } },
        ] },
        { role: 'tool', content: `result-${ctx.variantId}`, tool_call_id: ctx.runId },
      ]
      captures.set(ctx.runId, [...history, { role: 'assistant', content: 'Done.' }])
      const handle = await ctx.emitter.llm({ name: 'coder', model,
        messages: mode === 'compacted' ? [{ role: 'user', content: 'compacted summary' }]
          : mode === 'orphan' ? history.filter((message) => message.role !== 'assistant') : history,
        output: 'Done.' })
      // Exercise the ordinary integrity path with an explicitly synthetic transport receipt.
      await ctx.rawSink.record({ eventId: `request-${ctx.runId}`, runId: ctx.runId, spanId: handle.span.spanId,
        provider: 'test', model, endpoint: '/chat/completions', baseUrl: endpoint, attemptIndex: 0,
        direction: 'request', timestamp: 1000, redactedFields: [] })
      await handle.end()
      await ctx.emitter.endRun({ pass: false, score: 0 })
      return { pass: false, score: 0, model, promptHash: 'a'.repeat(64), configHash: 'b'.repeat(64),
        costUsd: 0.001, costProvenance: { kind: 'observed', usd: 0.001 }, tokenUsage: { input: 10, output: 5 } }
    },
    ...(mode === 'compacted' ? { rollout: { messagesOf: (runId: string) => captures.get(runId) } } : {}),
  }
  return { options, stores, captures }
}

describe('RL campaign capture join', () => {
  it('mints each run from the exact evaluation store instead of an empty replacement', async () => {
    const { options, stores, captures } = campaign()
    const result = await runRLCampaign(options)
    expect(result.campaign.failedRuns).toEqual([])
    expect(stores.size).toBe(2)
    expect(new Set(stores.values()).size).toBe(2)
    expect(result.rolloutLines).toHaveLength(2)
    for (const line of result.rolloutLines) {
      expect(line.provenance.gap).toBeUndefined()
      expect(line.messages).toEqual(captures.get(line.run_id))
      expect(line.messages[1]!.tool_calls![0]!.id).toBe(line.run_id)
      expect(line.messages[2]!.tool_call_id).toBe(line.run_id)
      expect(line.steps).toHaveLength(1)
    }
  })

  it('also uses a shared evaluation TraceStore without crossing run identities', async () => {
    const shared = new InMemoryTraceStore()
    const { options, captures } = campaign('history', shared)
    const result = await runRLCampaign(options)
    expect(result.rolloutLines).toHaveLength(2)
    for (const line of result.rolloutLines) expect(line.messages).toEqual(captures.get(line.run_id))
  })

  it('refuses missing call provenance actually captured by the evaluation', async () => {
    const { options } = campaign('orphan')
    await expect(runRLCampaign(options)).rejects.toThrow(/no captured invocation/)
  })

  it('passes the full-capture resolver through rather than training on compacted context', async () => {
    const { options, captures } = campaign('compacted')
    const result = await runRLCampaign(options)
    expect(result.rolloutLines).toHaveLength(2)
    for (const line of result.rolloutLines) expect(line.messages).toEqual(captures.get(line.run_id))
  })
})
