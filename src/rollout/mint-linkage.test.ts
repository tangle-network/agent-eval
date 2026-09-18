import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../run-record'
import type { LlmSpan, ToolSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { mintRolloutRows } from './mint'
import type { ChatMessage } from './schema'

const run: RunRecord = {
  runId: 'captured-run', experimentId: 'capture-test', candidateId: 'candidate', scenarioId: 'task',
  seed: 1, splitTag: 'search', model: 'test-model@2026-01-01', promptHash: 'a'.repeat(64),
  configHash: 'b'.repeat(64), commitSha: 'c'.repeat(40), wallMs: 10,
  costUsd: null, costProvenance: { kind: 'uncaptured', usd: null }, tokenUsage: { input: 10, output: 5 },
  terminalOutcome: 'succeeded', outcome: { searchScore: 1, raw: {}, realness: { score: 1, gated: false } },
}

function capture(): ChatMessage[] {
  return [
    { role: 'user', content: 'Read both files.' },
    { role: 'assistant', content: null, reasoning_content: 'Inspect before editing.', tool_calls: [
      { id: 'call-a', type: 'function', function: { name: 'read', arguments: '{ "path": "a" }' } },
      { id: 'call-b', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call-b', name: 'read', content: 'contents-b' },
    { role: 'tool', tool_call_id: 'call-a', name: 'read', content: 'contents-a' },
    { role: 'assistant', content: 'Done.' },
  ]
}

async function traced(messages: ChatMessage[]): Promise<InMemoryTraceStore> {
  const store = new InMemoryTraceStore()
  const history = messages.slice(0, -1).map((message) => ({ ...message, content: message.content ?? '' }))
  const span: LlmSpan = { spanId: 'llm', runId: run.runId, kind: 'llm', name: 'coder', startedAt: 0,
    endedAt: 10, model: run.model, messages: history, output: 'Done.' }
  await store.appendSpan(span)
  return store
}

describe('canonical capture linkage', () => {
  it('retains invocation ids, raw arguments and result ids from the final span history', async () => {
    const messages = capture().map((message) => ({ ...message, content: message.content ?? '' }))
    const { rows } = await mintRolloutRows([run], await traced(messages))
    expect(rows[0]!.messages).toEqual(messages)
  })

  it('uses full canonical capture rather than compacted context, including null content and reasoning', async () => {
    const messages = capture()
    const original = structuredClone(messages)
    const store = await traced([{ role: 'user', content: 'compacted summary' }, { role: 'assistant', content: 'Done.' }])
    const { rows } = await mintRolloutRows([run], store, { messagesOf: () => messages, maxSteps: 1 })
    expect(rows[0]!.messages).toEqual(original)
    rows[0]!.messages[1]!.tool_calls![0]!.function.arguments = 'changed after mint'
    expect(messages).toEqual(original)
  })

  it('accepts a full capture without inventing spans or synthetic messages', async () => {
    const messages = capture()
    const { rows, missingTraces } = await mintRolloutRows([run], new InMemoryTraceStore(), { messagesOf: () => messages })
    expect(rows[0]!.messages).toEqual(messages)
    expect(rows[0]!.steps).toBeUndefined()
    expect(rows[0]!.provenance.gap).toBeUndefined()
    expect(missingTraces).toEqual([])
  })

  it('redacts tool arguments, reasoning and results without rewriting linkage or the source', async () => {
    const messages = capture()
    messages[1]!.tool_calls![0]!.function.arguments = '{"secret":"TOKEN"}'
    messages[1]!.reasoning_content = 'TOKEN'
    messages[2]!.content = 'TOKEN'
    const { rows } = await mintRolloutRows([run], new InMemoryTraceStore(), {
      messagesOf: () => messages, scrub: (text) => text.replaceAll('TOKEN', '[redacted]'),
    })
    expect(JSON.stringify(rows)).not.toContain('TOKEN')
    expect(rows[0]!.messages[1]!.tool_calls![0]!.id).toBe('call-a')
    expect(rows[0]!.messages[3]!.tool_call_id).toBe('call-a')
    expect(messages[2]!.content).toBe('TOKEN')
  })

  for (const missing of [undefined, []]) {
    it(`refuses ${missing === undefined ? 'missing' : 'empty'} explicit capture without falling back to spans`, async () => {
      await expect(mintRolloutRows([run], await traced(capture()), { messagesOf: () => missing }))
        .rejects.toThrow(/full capture is missing/)
    })
  }

  for (const [name, mutate] of [
    ['orphan result', (messages: ChatMessage[]) => { messages.splice(1, 1) }],
    ['missing invocation id', (messages: ChatMessage[]) => { messages[1]!.tool_calls![0]!.id = '' }],
    ['duplicate invocation id', (messages: ChatMessage[]) => { messages[1]!.tool_calls![1]!.id = 'call-a' }],
    ['duplicate result', (messages: ChatMessage[]) => { messages.splice(3, 0, messages[2]!) }],
    ['missing result', (messages: ChatMessage[]) => { messages.splice(3, 1) }],
    ['missing result id', (messages: ChatMessage[]) => { delete messages[2]!.tool_call_id }],
    ['mismatched result name', (messages: ChatMessage[]) => { messages[2]!.name = 'write' }],
    ['non-assistant invocation', (messages: ChatMessage[]) => { messages[1]!.role = 'user' }],
    ['non-tool result id', (messages: ChatMessage[]) => { messages[4]!.tool_call_id = 'call-a' }],
    ['copied call with retained result', (messages: ChatMessage[]) => { messages[1]!.is_copied_context = true }],
  ] as const) {
    it(`refuses ${name} rather than reconstructing provenance from a tool span`, async () => {
      const messages = capture()
      mutate(messages)
      const store = new InMemoryTraceStore()
      const tool: ToolSpan = { spanId: 'tool', runId: run.runId, kind: 'tool', name: 'read',
        startedAt: 0, toolName: 'read', args: { path: 'a' }, result: 'contents-a' }
      await store.appendSpan(tool)
      await expect(mintRolloutRows([run], store, { messagesOf: () => messages })).rejects.toThrow()
    })
  }
})
