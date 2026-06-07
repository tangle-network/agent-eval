import { describe, expect, it } from 'vitest'
import { assertModelsServed, ModelsUnreachableError, preflightModels } from './preflight'

const BASE = 'https://router.tangle.tools/v1'
const KEY = 'test-key'

function listResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Build a fetch fake whose chat-completions responses are keyed by model id. */
function makeFetch(
  listedIds: string[],
  probeByModel: Record<string, { status: number; body?: unknown }> = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/models')) return listResponse(listedIds)
    if (url.endsWith('/chat/completions')) {
      const model = JSON.parse(String(init?.body)).model as string
      const spec = probeByModel[model] ?? { status: 200 }
      return new Response(spec.body === undefined ? '{}' : JSON.stringify(spec.body), {
        status: spec.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected url ${url}`)
  }) as typeof fetch
}

describe('preflightModels — membership only', () => {
  it('marks listed vs unlisted models, served null when not probed', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6', 'opencode/zai-coding-plan/glm-5.1'],
      fetchImpl: makeFetch(['claude-sonnet-4-6', 'deepseek-v4-pro']),
    })
    expect(out.succeeded).toBe(true)
    expect(out.error).toBeNull()
    expect(out.value).toEqual([
      { model: 'claude-sonnet-4-6', listed: true, served: null, status: null, detail: null },
      {
        model: 'opencode/zai-coding-plan/glm-5.1',
        listed: false,
        served: null,
        status: null,
        detail: null,
      },
    ])
  })

  it('tolerates a trailing slash on baseUrl', async () => {
    const out = await preflightModels({
      baseUrl: `${BASE}/`,
      apiKey: KEY,
      models: ['claude-haiku-4-5'],
      fetchImpl: makeFetch(['claude-haiku-4-5']),
    })
    expect(out.value?.[0]?.listed).toBe(true)
  })
})

describe('preflightModels — probe', () => {
  it('served true on 200', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6'],
      probe: true,
      fetchImpl: makeFetch(['claude-sonnet-4-6'], { 'claude-sonnet-4-6': { status: 200 } }),
    })
    expect(out.value).toEqual([
      { model: 'claude-sonnet-4-6', listed: true, served: true, status: 200, detail: null },
    ])
  })

  it('served false on 401 and captures the body error.message as detail', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['opencode/zai-coding-plan/glm-5.1'],
      probe: true,
      fetchImpl: makeFetch([], {
        'opencode/zai-coding-plan/glm-5.1': {
          status: 401,
          body: {
            message: 'No API key configured for model opencode/zai-coding-plan/glm-5.1',
            code: 'model_not_found',
          },
        },
      }),
    })
    expect(out.value).toEqual([
      {
        model: 'opencode/zai-coding-plan/glm-5.1',
        listed: false,
        served: false,
        status: 401,
        detail: 'No API key configured for model opencode/zai-coding-plan/glm-5.1',
      },
    ])
  })

  it('served false on 503 with no usable body message', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['deepseek-v4-pro'],
      probe: true,
      fetchImpl: makeFetch(['deepseek-v4-pro'], { 'deepseek-v4-pro': { status: 503, body: {} } }),
    })
    expect(out.value).toEqual([
      { model: 'deepseek-v4-pro', listed: true, served: false, status: 503, detail: null },
    ])
  })

  it('reads error.message nested under error', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['gpt-4.1-mini'],
      probe: true,
      fetchImpl: makeFetch(['gpt-4.1-mini'], {
        'gpt-4.1-mini': { status: 429, body: { error: { message: 'rate limited' } } },
      }),
    })
    expect(out.value?.[0]).toMatchObject({ served: false, status: 429, detail: 'rate limited' })
  })
})

describe('preflightModels — network failure', () => {
  it('GET failure returns a typed outcome, never throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6'],
      fetchImpl,
    })
    expect(out.succeeded).toBe(false)
    expect(out.value).toBeNull()
    expect(out.error).toContain('ECONNREFUSED')
  })

  it('non-2xx /models returns a typed outcome with the status', async () => {
    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as typeof fetch
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6'],
      fetchImpl,
    })
    expect(out.succeeded).toBe(false)
    expect(out.error).toContain('403')
  })

  it('probe POST failure returns a typed outcome', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/models')) return listResponse(['claude-sonnet-4-6'])
      throw new Error('socket hang up')
    }) as typeof fetch
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6'],
      probe: true,
      fetchImpl,
    })
    expect(out.succeeded).toBe(false)
    expect(out.error).toContain('socket hang up')
  })
})

describe('assertModelsServed', () => {
  it('passes silently when every model is served', async () => {
    const models = ['claude-sonnet-4-6', 'deepseek-v4-pro', 'gpt-4.1-mini']
    await expect(
      assertModelsServed({ baseUrl: BASE, apiKey: KEY, models, fetchImpl: makeFetch(models) }),
    ).resolves.toHaveLength(3)
  })

  it('throws naming EVERY dead model — unlisted and probe-failed alike', async () => {
    const models = [
      'claude-sonnet-4-6',
      'opencode/dead-a',
      'kimi-code/dead-b',
      'claude-code/dead-c',
    ]
    let thrown: unknown
    try {
      await assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models,
        probe: true,
        fetchImpl: makeFetch(['claude-sonnet-4-6', 'claude-code/dead-c'], {
          'claude-sonnet-4-6': { status: 200 },
          'opencode/dead-a': {
            status: 401,
            body: { message: 'No API key configured for model opencode/dead-a' },
          },
          'kimi-code/dead-b': {
            status: 401,
            body: { message: 'No API key configured for model kimi-code/dead-b' },
          },
          // listed but unconfigured: caught only by the probe
          'claude-code/dead-c': {
            status: 401,
            body: { message: 'No API key configured for model claude-code/dead-c' },
          },
        }),
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ModelsUnreachableError)
    const msg = (thrown as Error).message
    expect(msg).toContain('opencode/dead-a')
    expect(msg).toContain('kimi-code/dead-b')
    expect(msg).toContain('claude-code/dead-c')
    expect(msg).toContain('3/4')
    // the served model is never named
    expect(msg).not.toContain('claude-sonnet-4-6')
    expect((thrown as ModelsUnreachableError).results).toHaveLength(4)
  })

  it('a listed-but-probe-failed model is dead (no partial silent pass)', async () => {
    await expect(
      assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['deepseek-v4-pro'],
        probe: true,
        fetchImpl: makeFetch(['deepseek-v4-pro'], { 'deepseek-v4-pro': { status: 503, body: {} } }),
      }),
    ).rejects.toThrow(ModelsUnreachableError)
  })

  it('rethrows a network failure rather than reporting a partial pass', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    await expect(
      assertModelsServed({ baseUrl: BASE, apiKey: KEY, models: ['claude-sonnet-4-6'], fetchImpl }),
    ).rejects.toThrow(/ECONNREFUSED/)
  })
})
