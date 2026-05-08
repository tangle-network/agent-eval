import { describe, expect, it } from 'vitest'
import {
  ReplayCache,
  ReplayCacheMissError,
  createReplayFetch,
  iterateRawCalls,
} from '../src/replay'
import { InMemoryRawProviderSink, type RawProviderEvent } from '../src/trace/raw-provider-sink'

function evt(overrides: Partial<RawProviderEvent>): RawProviderEvent {
  return {
    eventId: overrides.eventId ?? Math.random().toString(36),
    runId: 'r-1',
    spanId: overrides.spanId ?? 's-1',
    provider: 'tangle-router',
    model: 'm@1',
    endpoint: '/chat/completions',
    baseUrl: 'https://api.test/v1',
    attemptIndex: 0,
    direction: 'request',
    timestamp: 1_000,
    redactedFields: [],
    ...overrides,
  }
}

const REQUEST_BODY = {
  model: 'm@1',
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0,
  max_tokens: 16,
}

const RESPONSE_BODY = {
  choices: [{ message: { content: 'hello' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  model: 'm@1',
}

async function populate(): Promise<InMemoryRawProviderSink> {
  const sink = new InMemoryRawProviderSink()
  await sink.record(evt({ direction: 'request', requestBody: REQUEST_BODY }))
  await sink.record(evt({ direction: 'response', spanId: 's-1', responseBody: RESPONSE_BODY, statusCode: 200 }))
  return sink
}

describe('ReplayCache', () => {
  it('builds from a sink and indexes by canonicalized request shape', async () => {
    const sink = await populate()
    const cache = await ReplayCache.fromSink(sink)
    expect(cache.size()).toBe(1)
    const stats = cache.stats()
    expect(stats.byProvider['tangle-router']).toBe(1)
    expect(stats.byModel['m@1']).toBe(1)
    expect(stats.orphanRequests).toBe(0)
  })

  it('lookup ignores key-order differences in the request body', async () => {
    const sink = await populate()
    const cache = await ReplayCache.fromSink(sink)
    // Same body, different key insertion order — must hit.
    const reordered = {
      max_tokens: 16,
      temperature: 0,
      model: 'm@1',
      messages: [{ role: 'user', content: 'hi' }],
    }
    const hit = await cache.lookup(reordered)
    expect(hit).toBeDefined()
    expect((hit?.response.responseBody as { model: string }).model).toBe('m@1')
  })

  it('counts orphan requests when responses are missing', async () => {
    const sink = new InMemoryRawProviderSink()
    await sink.record(evt({ direction: 'request', requestBody: REQUEST_BODY }))
    const cache = await ReplayCache.fromSink(sink)
    expect(cache.size()).toBe(0)
    expect(cache.stats().orphanRequests).toBe(1)
  })

  it('throws when used against a sink that does not implement list()', async () => {
    const limp: { record: () => Promise<void> } = { record: async () => {} }
    await expect(ReplayCache.fromSink(limp as never)).rejects.toThrow(/list\(\)/)
  })
})

describe('createReplayFetch', () => {
  it('serves cached completions and counts hits', async () => {
    const cache = await ReplayCache.fromSink(await populate())
    const hits: string[] = []
    const fetchShim = createReplayFetch(cache, { onHit: (i) => hits.push(i.model) })
    const res = await fetchShim('https://api.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(REQUEST_BODY),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { model: string }
    expect(body.model).toBe('m@1')
    expect(hits).toEqual(['m@1'])
  })

  it('throws ReplayCacheMissError on miss by default', async () => {
    const cache = await ReplayCache.fromSink(await populate())
    const fetchShim = createReplayFetch(cache)
    await expect(fetchShim('https://api.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...REQUEST_BODY, messages: [{ role: 'user', content: 'something else' }] }),
    })).rejects.toBeInstanceOf(ReplayCacheMissError)
  })

  it('falls back to provided fetch when onMiss=fallback', async () => {
    const cache = await ReplayCache.fromSink(await populate())
    let fallbackCalls = 0
    const fallback = (async () => {
      fallbackCalls++
      return new Response(JSON.stringify({ source: 'fallback' }), { status: 200 })
    }) as unknown as typeof fetch
    const fetchShim = createReplayFetch(cache, { onMiss: 'fallback', fallbackFetch: fallback })
    const res = await fetchShim('https://api.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...REQUEST_BODY, messages: [{ role: 'user', content: 'fresh' }] }),
    })
    expect(fallbackCalls).toBe(1)
    expect((await res.json() as { source: string }).source).toBe('fallback')
  })

  it('returns synthetic 599 when onMiss=fail-closed', async () => {
    const cache = await ReplayCache.fromSink(await populate())
    const fetchShim = createReplayFetch(cache, { onMiss: 'fail-closed' })
    const res = await fetchShim('https://api.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...REQUEST_BODY, messages: [{ role: 'user', content: 'fresh' }] }),
    })
    expect(res.status).toBe(599)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('replay_cache_miss')
  })

  it('passes non-completion URLs through to the fallback fetch', async () => {
    const cache = await ReplayCache.fromSink(await populate())
    let fallbackCalls = 0
    const fallback = (async () => {
      fallbackCalls++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const fetchShim = createReplayFetch(cache, { fallbackFetch: fallback })
    await fetchShim('https://other.example.com/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ input: 'x' }),
    })
    expect(fallbackCalls).toBe(1)
  })
})

describe('iterateRawCalls', () => {
  it('yields paired request/response entries', async () => {
    const sink = await populate()
    const seen: string[] = []
    for await (const entry of iterateRawCalls(sink)) {
      seen.push(entry.request.model)
    }
    expect(seen).toEqual(['m@1'])
  })
})
