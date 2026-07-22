import { describe, expect, it } from 'vitest'
import { captureFetchToRawSink } from './capture-fetch'
import type { ExtractedUsage } from './extract-usage'
import { InMemoryRawProviderSink } from './raw-provider-sink'

const CTX = {
  runId: 'r-1',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
}

function jsonFetch(body: unknown, init?: { sse?: boolean }): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': init?.sse ? 'text/event-stream' : 'application/json' },
    })) as unknown as typeof fetch
}

describe('captureFetchToRawSink onUsage wiring', () => {
  it('emits parsed usage from a JSON chat-completions response', async () => {
    const sink = new InMemoryRawProviderSink()
    const seen: ExtractedUsage[] = []
    const wrapped = captureFetchToRawSink(
      jsonFetch({ usage: { prompt_tokens: 11, completion_tokens: 4 } }),
      sink,
      CTX,
      { onUsage: (u) => seen.push(u) },
    )
    await wrapped('https://api.openai.com/v1/chat/completions', { method: 'POST' })
    expect(seen).toEqual([{ input: 11, output: 4 }])
    // capture still recorded the request + response
    expect((await sink.list({ runId: 'r-1' })).map((e) => e.direction)).toEqual([
      'request',
      'response',
    ])
  })

  it('emits accumulated usage from an SSE response', async () => {
    const sink = new InMemoryRawProviderSink()
    const seen: ExtractedUsage[] = []
    const sse = 'data: {"usage":{"input_tokens":2,"output_tokens":6}}\n\ndata: [DONE]\n\n'
    const wrapped = captureFetchToRawSink(jsonFetch(sse, { sse: true }), sink, CTX, {
      onUsage: (u) => seen.push(u),
    })
    await wrapped('https://api.openai.com/v1/chat/completions', { method: 'POST' })
    expect(seen).toEqual([{ input: 2, output: 6 }])
  })

  it('supports providers that emit SSE usage as deltas', async () => {
    const sink = new InMemoryRawProviderSink()
    const seen: ExtractedUsage[] = []
    const sse = [
      'data: {"usage":{"input_tokens":2,"output_tokens":1}}',
      '',
      'data: {"usage":{"input_tokens":3,"output_tokens":4}}',
      '',
    ].join('\n')
    const wrapped = captureFetchToRawSink(jsonFetch(sse, { sse: true }), sink, CTX, {
      onUsage: (usage) => seen.push(usage),
      sseUsageMode: 'delta',
    })

    await wrapped('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(seen).toEqual([{ input: 5, output: 5 }])
  })

  it('does not call onUsage when the response carries no usage', async () => {
    const sink = new InMemoryRawProviderSink()
    let calls = 0
    const wrapped = captureFetchToRawSink(jsonFetch({ choices: [] }), sink, CTX, {
      onUsage: () => calls++,
    })
    await wrapped('https://api.openai.com/v1/chat/completions', { method: 'POST' })
    expect(calls).toBe(0)
  })

  it('a throwing onUsage callback does not kill the call (best-effort)', async () => {
    const sink = new InMemoryRawProviderSink()
    const wrapped = captureFetchToRawSink(
      jsonFetch({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      sink,
      CTX,
      {
        onUsage: () => {
          throw new Error('boom')
        },
      },
    )
    const res = await wrapped('https://api.openai.com/v1/chat/completions', { method: 'POST' })
    expect(res.status).toBe(200)
  })
})
