import { describe, expect, it } from 'vitest'
import { callLlm } from '../src/llm-client'
import { InMemoryRawProviderSink } from '../src/trace/raw-provider-sink'

function makeFetchSequence(
  responses: Array<{ status: number; body: unknown; delayMs?: number }>,
): typeof fetch {
  let i = 0
  return (async (_url: string, _init: unknown) => {
    const r = responses[i++]!
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const SUCCESS_BODY = {
  choices: [{ message: { content: 'hi' } }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  model: 'm',
}

describe('callLlm raw capture', () => {
  it('records request + response on a successful call', async () => {
    const sink = new InMemoryRawProviderSink()
    await callLlm(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        rawSink: sink,
        traceContext: { runId: 'r-1', spanId: 's-1' },
        fetch: makeFetchSequence([{ status: 200, body: SUCCESS_BODY }]),
      },
    )
    const events = await sink.list({ runId: 'r-1' })
    expect(events.map((e) => e.direction)).toEqual(['request', 'response'])
    expect(events[0]?.attemptIndex).toBe(0)
    expect(events[0]?.spanId).toBe('s-1')
    expect(events[0]?.provider).toBe('openai')
    // Auth header was redacted at the sink boundary.
    expect(events[0]?.requestHeaders?.Authorization).toBeUndefined()
    expect(events[0]?.redactedFields).toContain('requestHeaders.Authorization')
    expect(events[1]?.responseBody).toMatchObject({ model: 'm' })
    expect(events[1]?.statusCode).toBe(200)
  })

  it('records request + error on a failed call and per attempt on retries', async () => {
    const sink = new InMemoryRawProviderSink()
    await expect(
      callLlm(
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          rawSink: sink,
          maxRetries: 2,
          fetch: makeFetchSequence([
            { status: 503, body: '<<gateway>>' },
            { status: 200, body: SUCCESS_BODY },
          ]),
        },
      ),
    ).resolves.toBeDefined()
    const events = await sink.list()
    // attempt 0 → request, error; attempt 1 → request, response.
    expect(events.map((e) => `${e.attemptIndex}:${e.direction}`)).toEqual([
      '0:request',
      '0:error',
      '1:request',
      '1:response',
    ])
    const error = events.find((e) => e.direction === 'error')!
    expect(error.statusCode).toBe(503)
    expect(error.responseBody).toBe('<<gateway>>')
  })

  it('records error with non-JSON response body when JSON.parse fails', async () => {
    const sink = new InMemoryRawProviderSink()
    await expect(
      callLlm(
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          rawSink: sink,
          maxRetries: 1,
          fetch: makeFetchSequence([{ status: 200, body: 'not json' }]),
        },
      ),
    ).rejects.toThrow()
    const events = await sink.list()
    const last = events[events.length - 1]!
    expect(last.direction).toBe('error')
    expect(last.errorMessage).toMatch(/non-JSON response/)
    expect(last.responseBody).toBe('not json')
  })
})
