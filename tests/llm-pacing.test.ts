import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatClient } from '../src/analyst/chat-client'
import {
  callLlm,
  callLlmJson,
  type LlmCallRequest,
  LlmClient,
  type LlmClientOptions,
  maximumChargeForLlmRequest,
} from '../src/llm-client'

const baseUrl = 'https://provider.test/v1'
const epoch = Date.UTC(2026, 9, 4)
const request: LlmCallRequest = {
  model: 'fixture',
  messages: [{ role: 'user', content: 'Return JSON' }],
  maxTokens: 10,
}
const success = () =>
  new Response(
    JSON.stringify({
      model: 'fixture',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200 },
  )
const limited = (retryAfter: string) =>
  new Response('busy', { status: 429, headers: { 'Retry-After': retryAfter } })

function transport(response: (index: number) => Response = success) {
  const starts: number[] = []
  const fetch = vi.fn(async () => {
    const index = starts.length
    starts.push(Date.now() - epoch)
    return response(index)
  })
  return { starts, fetch: fetch as typeof globalThis.fetch }
}

const entrypoints = [
  'callLlm',
  'callLlmJson',
  'LlmClient.call',
  'LlmClient.callJson',
  'createChatClient',
] as const

function caller(entrypoint: (typeof entrypoints)[number], options: LlmClientOptions) {
  if (entrypoint === 'callLlm') return () => callLlm(request, options)
  if (entrypoint === 'callLlmJson') return () => callLlmJson(request, options)
  if (entrypoint === 'createChatClient') {
    const client = createChatClient({
      ...options,
      transport: 'openai-compatible',
      baseUrl,
      apiKey: 'fixture-only',
    })
    return () => client.chat(request)
  }
  const client = new LlmClient(options)
  return entrypoint === 'LlmClient.call'
    ? () => client.call(request)
    : () => client.callJson(request)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(epoch)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Retry-After and optional physical-call pacing', () => {
  it.each(entrypoints)('%s honors 30 seconds, then spaces the next call', async (entrypoint) => {
    const mock = transport((index) => (index === 0 ? limited('30') : success()))
    const call = caller(entrypoint, {
      baseUrl,
      fetch: mock.fetch,
      maximumAttempts: 2,
      minIntervalMs: 1_000,
    })
    const first = call()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(mock.starts).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    await first
    expect(mock.starts).toEqual([0, 30_000])

    const second = call()
    await vi.advanceTimersByTimeAsync(999)
    expect(mock.starts).toEqual([0, 30_000])
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(mock.starts).toEqual([0, 30_000, 31_000])
  })

  it.each(['http-date', 'long-timer'])('honors a full %s Retry-After', async (kind) => {
    const delay = kind === 'http-date' ? 30_000 : 2_147_484_000
    const header =
      kind === 'http-date' ? new Date(epoch + delay).toUTCString() : String(delay / 1_000)
    const mock = transport((index) => (index === 0 ? limited(header) : success()))
    const pending = callLlm(request, { baseUrl, fetch: mock.fetch, maximumAttempts: 2 })
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(mock.starts).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(mock.starts).toEqual([0, delay])
  })

  it.each(['-1', '1e400', 'not-a-delay'])(
    'backs off for invalid Retry-After %s',
    async (header) => {
      const mock = transport((index) => (index === 0 ? limited(header) : success()))
      const pending = callLlm(request, { baseUrl, fetch: mock.fetch, maximumAttempts: 2 })
      await vi.advanceTimersByTimeAsync(499)
      expect(mock.starts).toEqual([0])
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(mock.starts).toEqual([0, 500])
    },
  )

  it('spaces concurrent raw, JSON and per-call override requests', async () => {
    const mock = transport()
    const client = new LlmClient({ baseUrl, fetch: mock.fetch, minIntervalMs: 1_000 })
    const pending = Promise.all([
      client.call(request),
      client.callJson(request, { idempotencyKey: 'second' }),
      client.call(request, { idempotencyKey: 'third' }),
    ])
    await vi.advanceTimersByTimeAsync(999)
    expect(mock.starts).toEqual([0])
    await vi.advanceTimersByTimeAsync(1_001)
    await pending
    expect(mock.starts).toEqual([0, 1_000, 2_000])
  })

  it('spaces starts without waiting for an earlier response to finish', async () => {
    const starts: number[] = []
    let finishFirst!: (response: Response) => void
    const firstResponse = new Promise<Response>((resolve) => {
      finishFirst = resolve
    })
    const fetch = vi.fn(async () => {
      starts.push(Date.now() - epoch)
      return starts.length === 1 ? firstResponse : success()
    })
    const client = new LlmClient({
      baseUrl,
      fetch: fetch as typeof globalThis.fetch,
      minIntervalMs: 1_000,
    })
    const first = client.call(request)
    const second = client.call(request)
    await vi.advanceTimersByTimeAsync(1_000)
    await second
    expect(starts).toEqual([0, 1_000])
    finishFirst(success())
    await first
  })

  it('paces actual fetch starts even when asynchronous raw sinks release together', async () => {
    const mock = transport()
    const client = new LlmClient({
      baseUrl,
      fetch: mock.fetch,
      minIntervalMs: 1_000,
      rawSink: {
        async record(event) {
          if (event.direction === 'request') {
            await new Promise<void>((resolve) => setTimeout(resolve, 3_000))
          }
        },
      },
    })
    const pending = Promise.all([client.call(request), client.call(request), client.call(request)])
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(mock.starts).toEqual([3_000, 4_000, 5_000])
  })

  it('paces schema/temperature fallbacks inside one physical-attempt budget', async () => {
    const mock = transport((index) => {
      if (index === 0) return new Response('response_format not supported', { status: 400 })
      if (index === 1) return new Response('temperature must be 1', { status: 400 })
      return success()
    })
    const pending = callLlmJson(
      { ...request, jsonSchema: { name: 'result', schema: { type: 'object' } } },
      { baseUrl, fetch: mock.fetch, maximumAttempts: 3, minIntervalMs: 1_000 },
    )
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await pending).value).toEqual({ ok: true })
    expect(mock.starts).toEqual([0, 1_000, 2_000])
  })

  it('uses the larger of Retry-After and the remaining minimum interval', async () => {
    const mock = transport((index) => (index === 0 ? limited('0.1') : success()))
    const pending = callLlm(request, {
      baseUrl,
      fetch: mock.fetch,
      minIntervalMs: 1_000,
      maximumAttempts: 2,
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(mock.starts).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(mock.starts).toEqual([0, 1_000])
  })

  it('does not charge pacing time against the per-attempt HTTP timeout', async () => {
    const mock = transport()
    const client = new LlmClient({ baseUrl, fetch: mock.fetch, minIntervalMs: 1_000 })
    await client.call({ ...request, timeoutMs: 10 })
    const pending = client.call({ ...request, timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    expect(mock.starts).toEqual([0, 1_000])
  })

  it('cancels a pacing wait without fetching or consuming a future slot', async () => {
    const mock = transport()
    const client = new LlmClient({ baseUrl, fetch: mock.fetch, minIntervalMs: 1_000 })
    await client.call(request)
    const controller = new AbortController()
    const cancelled = client.call(request, { signal: controller.signal }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort(new Error('owner cancelled'))
    expect(await cancelled).toMatchObject({ message: 'owner cancelled' })
    expect(mock.starts).toEqual([0])
    const next = client.call(request)
    await vi.advanceTimersByTimeAsync(900)
    await next
    expect(mock.starts).toEqual([0, 1_000])
  })

  it('expires a pacing wait at the operation deadline without fetching', async () => {
    const mock = transport()
    const client = new LlmClient({ baseUrl, fetch: mock.fetch, minIntervalMs: 1_000 })
    await client.call(request)
    const pending = client.call(request, { deadlineMs: 100 }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ name: 'TimeoutError' })
    expect(mock.starts).toEqual([0])
  })

  it('never retries early when the deadline is shorter than Retry-After', async () => {
    const mock = transport(() => limited('30'))
    const pending = callLlm(request, {
      baseUrl,
      fetch: mock.fetch,
      deadlineMs: 100,
      minIntervalMs: 1_000,
    }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ status: 429 })
    expect(mock.starts).toEqual([0])
  })

  it.each([undefined, 0])('does not throttle when minIntervalMs is %s', async (minIntervalMs) => {
    const mock = transport()
    const client = new LlmClient({ baseUrl, fetch: mock.fetch, minIntervalMs })
    await Promise.all([client.call(request), client.callJson(request)])
    expect(mock.starts).toEqual([0, 0])
  })

  it('does not share pacing between independent options objects', async () => {
    const mock = transport()
    await Promise.all([
      callLlm(request, { baseUrl, fetch: mock.fetch, minIntervalMs: 1_000 }),
      callLlm(request, { baseUrl, fetch: mock.fetch, minIntervalMs: 1_000 }),
    ])
    expect(mock.starts).toEqual([0, 0])
  })

  it.each([-1, NaN, Infinity])('rejects invalid interval %s before dispatch', async (interval) => {
    const mock = transport()
    const options = { baseUrl, fetch: mock.fetch, minIntervalMs: interval }
    expect(() => new LlmClient(options)).toThrow(RangeError)
    await expect(callLlm(request, options)).rejects.toThrow(RangeError)
    expect(mock.starts).toEqual([])
  })

  it('allows six default physical attempts and prices the same allowance', async () => {
    const mock = transport((index) => (index < 5 ? limited('0.001') : success()))
    const client = new LlmClient({ baseUrl, fetch: mock.fetch })
    expect(client.maximumAttempts).toBe(6)
    expect(maximumChargeForLlmRequest(request)).toMatchObject({ outputTokens: 60 })
    const pending = client.call(request).catch((error) => error)
    await vi.advanceTimersByTimeAsync(5)
    expect(await pending).toMatchObject({ content: '{"ok":true}' })
    expect(mock.starts).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('preserves an explicit one-attempt cap with no retry sleep', async () => {
    const mock = transport(() => limited('30'))
    await expect(
      callLlm(request, { baseUrl, fetch: mock.fetch, maximumAttempts: 1, minIntervalMs: 1_000 }),
    ).rejects.toMatchObject({ status: 429 })
    expect(mock.starts).toEqual([0])
    expect(vi.getTimerCount()).toBe(0)
  })
})
