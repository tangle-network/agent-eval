import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductClient } from './client'

function mkOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function mkErr(status: number, body: string): Response {
  return new Response(body, { status })
}

const ROUTES = {
  tasks: '/api/tasks',
  events: '/api/events',
  approvals: '/api/approvals',
  vault: '/api/vault',
  generations: '/api/generations',
}

function newClient() {
  return new ProductClient({ baseUrl: 'https://app.test', routes: ROUTES })
}

describe('ProductClient — fail-loud on non-ok responses', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('getTasks throws on a 500 instead of masking it as zero results', async () => {
    // OLD behavior: res.json() was called without checking res.ok, then the
    // error body's missing `tasks` key was masked by `?? []`, so a 500 with an
    // error JSON body returned [] — indistinguishable from a healthy empty set.
    globalThis.fetch = vi.fn(async () =>
      mkErr(500, JSON.stringify({ error: 'internal server error' })),
    ) as unknown as typeof fetch

    await expect(newClient().getTasks('ws-1')).rejects.toThrow(/HTTP 500/)
  })

  it('getApprovals throws on a 401 (auth) rather than returning [])', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkErr(401, JSON.stringify({ error: 'unauthorized' })),
    ) as unknown as typeof fetch

    await expect(newClient().getApprovals('ws-1')).rejects.toThrow(/HTTP 401/)
  })

  it('getEvents fails loud when a 200 body omits the required array field', async () => {
    // A wrong route or a contract drift can return 200 `{}`. The old `?? []`
    // turned that into "zero events"; now it must surface as a defect.
    globalThis.fetch = vi.fn(async () => mkOk({ unexpected: true })) as unknown as typeof fetch

    await expect(newClient().getEvents('ws-1')).rejects.toThrow(/missing array field "events"/)
  })

  it('getVaultTree fails loud when a 200 body omits the tree array', async () => {
    globalThis.fetch = vi.fn(async () => mkOk({})) as unknown as typeof fetch
    await expect(newClient().getVaultTree('ws-1')).rejects.toThrow(/missing array field "tree"/)
  })

  it('returns the parsed array on a healthy 200', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkOk({ tasks: [{ id: 't1', title: 'a', status: 'open', priority: 'high' }] }),
    ) as unknown as typeof fetch

    const tasks = await newClient().getTasks('ws-1')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.id).toBe('t1')
  })

  it('a genuinely empty result set is still allowed (empty array, not masked error)', async () => {
    globalThis.fetch = vi.fn(async () => mkOk({ tasks: [] })) as unknown as typeof fetch
    const tasks = await newClient().getTasks('ws-1')
    expect(tasks).toEqual([])
  })

  it('generic post throws with status + body on a 4xx', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkErr(422, 'validation failed: name required'),
    ) as unknown as typeof fetch

    await expect(newClient().post('/api/x', { a: 1 })).rejects.toThrow(
      /HTTP 422.*validation failed/,
    )
  })
})

describe('ProductClient — request timeout', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = realFetch
  })

  it('aborts a hung request after the configured timeout', async () => {
    // fetch resolves only if its signal aborts (mirrors how undici/fetch
    // rejects an aborted request). A never-resolving server must not hang the
    // harness forever.
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }
      })) as unknown as typeof fetch

    const client = new ProductClient({ baseUrl: 'https://app.test', routes: ROUTES, timeoutMs: 50 })
    const p = client.get('/api/slow')
    const assertion = expect(p).rejects.toThrow(/aborted/i)
    await vi.advanceTimersByTimeAsync(60)
    await assertion
  })
})
